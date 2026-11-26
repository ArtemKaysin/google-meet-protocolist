import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const macOnly = { skip: process.platform !== 'darwin' && 'requires Swift and macOS' };

test('macOS setup replaces an untrusted helper symlink with a native build without touching its target', macOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'protocolist-setup-'));
  try {
    for (const file of ['setup-macos.mjs', 'keychain-session.swift']) {
      copyFileSync(new URL(`../scripts/${file}`, import.meta.url), join(root, file));
    }
    const target = join(root, 'untrusted');
    const marker = '#!/bin/sh\nexit 97\n';
    writeFileSync(target, marker, { mode: 0o700 });
    const helper = join(root, '.keychain-session');
    symlinkSync(target, helper);
    const run = () => spawnSync(process.execPath, [join(root, 'setup-macos.mjs')], { encoding: 'utf8', timeout: 60000 });
    const result = run();
    assert.equal(result.status, 0, result.stderr ?? result.error?.code);
    assert.ok(lstatSync(helper).isFile());
    assert.equal(readFileSync(target, 'utf8'), marker);
    const native = readFileSync(helper);
    assert.ok(native.length > 1024 && !native.subarray(0, 4).equals(Buffer.from('#!/b')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
