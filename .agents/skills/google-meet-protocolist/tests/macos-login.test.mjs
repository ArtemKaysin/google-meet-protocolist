import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Exercise the real CLI orchestration without Chrome, the network or real cookies.
const dataURL = source => `data:text/javascript,${encodeURIComponent(source)}`;
const playwright = dataURL(`
  let calendarOpened = false, browserClosed = false;
  const reply = (status, location, body = '') => ({ status: () => status, dispose: async () => {},
    headers: () => location ? { location } : { 'content-type': 'text/html' }, text: async () => body });
  function week(email, calendar = email) {
    const initial = [];
    if (email) initial[0] = ['synthetic-account-key', '1000', email, email, []];
    initial[39] = [null, [[null, []], null, [null, [[null, [calendar, ['Calendar']]]]]]];
    return '<script id="initialdata">' + JSON.stringify(initial) + '</script>';
  }
  function http(standalone) {
    return {
      post: async () => { const row = ['gaia.l.a', null, null, standalone &&
        process.env.PROTOCOLIST_FIXTURE_CASE === 'wrong-account' ? 'other@example.invalid' : 'user@example.invalid'];
        return { ...reply(200), json: async () => ['gaia.l.a.r', [row]] }; },
      get: async (url) => {
        const parsed = new URL(url);
        const scenario = standalone && process.env.PROTOCOLIST_FIXTURE_CASE;
        if (parsed.hostname !== 'calendar.google.com') return reply(200);
        if (!calendarOpened || scenario === 'calendar-denied') return reply(302, 'https://accounts.google.com/ServiceLogin');
        if (scenario === 'other-slot' && parsed.pathname.startsWith('/calendar/u/0/r')) {
          return reply(302, parsed.pathname.replace('/u/0/', '/u/1/'));
        }
        if (scenario === 'generic-html') return reply(200, null, '<html>Calendar Help</html>');
        if (scenario === 'wrong-calendar') return reply(200, null, week('other@example.invalid'));
        if (scenario === 'shared-calendar') return reply(200, null, week('other@example.invalid', 'user@example.invalid'));
        if (scenario === 'missing-identity') return reply(200, null, week(null, 'user@example.invalid'));
        return reply(200, null, week('user@example.invalid'));
      },
      dispose: async () => {}, storageState: async () => ({ cookies: [], origins: [] }),
    };
  }
  export const request = { newContext: async () => {
    if (!browserClosed) throw new Error('browser must be closed before verification');
    return http(true);
  } };
  export const chromium = { launch: async () => ({ isConnected: () => true,
    close: async () => { browserClosed = true; },
    newContext: async () => ({ request: http(false), storageState: async () => ({ cookies: [] }),
      newPage: async () => {
        let url = 'about:blank';
        return { isClosed: () => false, url: () => url, evaluate: async () => {
          if (url !== 'about:blank') throw new Error('sign-in can navigate away');
          return 'synthetic ua';
        }, goto: async (next) => { url = next; if (next.startsWith('https://calendar.google.com/')) calendarOpened = true; } };
      },
    }),
  }) };
`);
const store = dataURL(`
  export const googleStorageState = state => state;
  export const loadSession = async () => null;
  export const saveSession = async () => { console.error('fixture-session-saved'); };
`);
const hooks = dataURL(`export async function resolve(name, context, next) {
  if (name === 'playwright-core') return { url: ${JSON.stringify(playwright)}, shortCircuit: true };
  if (name === './session-store.mjs') return { url: ${JSON.stringify(store)}, shortCircuit: true };
  return next(name, context);
}`);
const preload = dataURL(`import { register } from 'node:module'; register(${JSON.stringify(hooks)});`);
const cli = fileURLToPath(new URL('../scripts/google-meet-http.mjs', import.meta.url));
const onMac = { skip: process.platform !== 'darwin' && 'macOS login path' };
const run = scenario => spawnSync(process.execPath, ['--import', preload, cli, 'login', '--account', 'user@example.invalid'], {
  env: { ...process.env, PROTOCOLIST_FIXTURE_CASE: scenario }, encoding: 'utf8', timeout: 15000,
});

test('Mac login opens Calendar in the same browser before validating and storing the session', onMac, () => {
  const result = run('success');
  assert.equal(result.status, 0, result.stderr ?? result.error?.code);
  assert.equal(JSON.parse(result.stdout).state, 'session_ready');
  assert.match(result.stderr, /calendar_opened/);
  assert.match(result.stderr, /fixture-session-saved/);
});

test('a Calendar login redirect in standalone HTTP prevents saving a Drive-only session', onMac, () => {
  const result = run('calendar-denied');
  assert.equal(result.status, 3, result.stderr ?? result.error?.code);
  assert.equal(JSON.parse(result.stdout).state, 'standalone_calendar_unverified');
  assert.doesNotMatch(result.stderr, /fixture-session-saved/);
});

test('a different Google account in standalone HTTP is never saved', onMac, () => {
  const result = run('wrong-account');
  assert.equal(result.status, 3, result.stderr ?? result.error?.code);
  assert.equal(JSON.parse(result.stdout).googleState, 'account_mismatch');
  assert.doesNotMatch(result.stderr, /fixture-session-saved/);
});

for (const scenario of ['generic-html', 'other-slot', 'wrong-calendar', 'shared-calendar', 'missing-identity']) {
  test(`Mac login rejects an unverified Calendar response (${scenario})`, onMac, () => {
    const result = run(scenario);
    assert.equal(result.status, 3, result.stderr ?? result.error?.code);
    assert.equal(JSON.parse(result.stdout).state, 'standalone_calendar_unverified');
    assert.doesNotMatch(result.stderr, /fixture-session-saved/);
  });
}
