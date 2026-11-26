import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function setup() {
  if (process.platform !== 'darwin') throw new Error('This setup command is for macOS only.');
  const scripts = fileURLToPath(new URL('.', import.meta.url));
  const source = join(scripts, 'keychain-session.swift');
  const helper = join(scripts, '.keychain-session');
  const directory = mkdtempSync(join(scripts, '.keychain-build-'));
  try {
    const output = join(directory, '.keychain-session');
    const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-warnings-as-errors', source, '-o', output], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('Could not build the Keychain helper. Install Xcode Command Line Tools and retry.');
    const installed = lstatSync(helper, { throwIfNoEntry: false });
    if (installed?.isFile() && (installed.mode & 0o100) && installed.size === lstatSync(output).size &&
        readFileSync(output).equals(readFileSync(helper))) {
      console.log('The macOS Keychain helper matches the fresh build.');
      return;
    }
    renameSync(output, helper);
    console.log('The macOS Keychain helper is installed.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try { setup(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
