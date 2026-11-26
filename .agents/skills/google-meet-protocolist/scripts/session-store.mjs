import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const googleHosts = ['accounts.google.com', 'calendar.google.com', 'drive.google.com'];
const macHelper = fileURLToPath(new URL('./.keychain-session', import.meta.url));
const maxMacSessionBytes = 256 * 1024;

export function googleStorageState(state) {
  const cookies = state.cookies.filter(cookie => {
    const domain = cookie.domain.toLowerCase();
    return googleHosts.some(host => host === domain || (domain.startsWith('.') && host.endsWith(domain)));
  });
  return { cookies, origins: [] };
}

function sessionPath(account) {
  if (process.platform !== 'win32') throw new Error('Google session storage requires Windows or macOS.');
  if (!process.env.LOCALAPPDATA) throw new Error('Windows session storage requires LOCALAPPDATA.');
  const root = resolve(process.env.GOOGLE_MEET_PROTOCOLIST_HOME ?? join(process.env.LOCALAPPDATA, 'GoogleMeetProtocolist'));
  const name = createHash('sha256').update(account).digest('hex') + '.dpapi';
  return { root, file: join(root, name) };
}

function dpapi(operation, input) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$out = [System.Security.Cryptography.ProtectedData]::' + operation + '($data, $null, $scope)',
    '[Console]::Write([Convert]::ToBase64String($out))',
  ].join('; ');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    input: input.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout?.trim()) throw new Error('Windows could not access the protected Google session.');
  return Buffer.from(result.stdout.trim(), 'base64');
}

function keychain(operation, account, input) {
  const result = spawnSync(macHelper, [operation, account], {
    input, timeout: 20_000, maxBuffer: maxMacSessionBytes + 4096,
  });
  if (result.error?.code === 'ENOENT') throw new Error('Run npm run setup:macos from the skill directory.');
  if (operation === 'read' && result.status === 3) return null;
  if (result.status !== 0) {
    result.stdout?.fill(0);
    throw new Error('macOS Keychain session unavailable. No file fallback.');
  }
  return result.stdout;
}

async function readSession(account) {
  if (process.platform === 'darwin') return keychain('read', account);
  const { file } = sessionPath(account);
  let encrypted;
  try {
    encrypted = await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return dpapi('Unprotect', encrypted);
}

export async function loadSession(account) {
  const plaintext = await readSession(account);
  if (plaintext === null) return null;
  try {
    const session = JSON.parse(plaintext.toString('utf8'));
    if (session.version !== 1 || session.account !== account || typeof session.userAgent !== 'string' ||
        !Array.isArray(session.storageState?.cookies)) {
      throw new Error('The saved Google session has an unexpected format.');
    }
    return { userAgent: session.userAgent, storageState: googleStorageState(session.storageState) };
  } finally {
    plaintext.fill(0);
  }
}

export async function saveSession(account, { userAgent, storageState }) {
  const plaintext = Buffer.from(JSON.stringify({
    version: 1, account, userAgent, storageState: googleStorageState(storageState),
  }));
  let encrypted;
  try {
    if (process.platform === 'darwin') {
      if (plaintext.length > maxMacSessionBytes) throw new Error('Google session exceeds the Keychain helper limit.');
      keychain('write', account, plaintext);
      return;
    }
    encrypted = dpapi('Protect', plaintext);
  } finally {
    plaintext.fill(0);
  }
  const { root, file } = sessionPath(account);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, randomUUID() + '.tmp');
  try {
    await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
