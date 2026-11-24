import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const googleHosts = ['accounts.google.com', 'calendar.google.com', 'drive.google.com'];

export function googleStorageState(state) {
  const cookies = state.cookies.filter(cookie => {
    const domain = cookie.domain.toLowerCase();
    return googleHosts.some(host => host === domain || (domain.startsWith('.') && host.endsWith(domain)));
  });
  return { cookies, origins: [] };
}

function sessionPath(account) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('Google session storage requires Windows and LOCALAPPDATA.');
  }
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

export async function loadSession(account) {
  const { file } = sessionPath(account);
  let encrypted;
  try {
    encrypted = await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const plaintext = dpapi('Unprotect', encrypted);
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
  const { root, file } = sessionPath(account);
  const plaintext = Buffer.from(JSON.stringify({
    version: 1, account, userAgent, storageState: googleStorageState(storageState),
  }));
  let encrypted;
  try {
    encrypted = dpapi('Protect', plaintext);
  } finally {
    plaintext.fill(0);
  }
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
