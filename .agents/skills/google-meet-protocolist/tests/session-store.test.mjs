import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { googleStorageState, loadSession } from '../scripts/session-store.mjs';

const helper = fileURLToPath(new URL('../scripts/.keychain-session', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/google-meet-http.mjs', import.meta.url));
const macOnly = { skip: process.platform !== 'darwin' && 'requires native macOS Keychain' };
const freshAccount = () => `${randomUUID()}@example.invalid`;

test('a new Mac account has no saved session', macOnly, async () => {
  assert.equal(await loadSession(freshAccount()), null);
});

test('native Keychain keeps two fixture accounts separate and removes both', macOnly, () => {
  const result = spawnSync(helper, ['self-test'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr ?? result.error?.code);
  assert.equal(result.stdout.trim(), 'Keychain fixture: account isolation, update and cleanup verified');
});

test('status on a new Mac install reports that login is needed, without opening Chrome', macOnly, () => {
  const result = spawnSync(process.execPath, [cli, 'status', '--account', freshAccount()], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 3, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { state: 'session_required' });
  assert.equal(result.stderr, '');
});

test('rejects invalid helper writes without exposing the input', macOnly, () => {
  const account = freshAccount();
  const result = spawnSync(helper, ['write', account], { encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ version: 1, account: freshAccount(), sentinel: 'synthetic-private' }),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /synthetic-private/);
  const read = spawnSync(helper, ['read', account], { encoding: 'utf8', timeout: 15000 });
  assert.equal(read.status, 3, read.stderr);
  assert.equal(read.stdout, '');
});

test('keeps only Google session cookies and excludes browser local storage', () => {
  const state = { cookies: [{ domain: '.google.com' }, { domain: 'drive.google.com' },
    { domain: 'google.com.example.invalid' }, { domain: 'example.invalid' }],
  origins: [{ origin: 'https://drive.google.com' }] };
  assert.deepEqual(googleStorageState(state), { cookies: state.cookies.slice(0, 2), origins: [] });
});
