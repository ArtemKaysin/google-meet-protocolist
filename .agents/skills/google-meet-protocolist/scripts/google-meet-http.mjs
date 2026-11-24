import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium, request } from 'playwright-core';
import { readCalendar } from './calendar-http.mjs';
import { checkGoogleSession, readDrive } from './drive-http.mjs';
import { timeWindow } from './google-meet.mjs';
import { googleStorageState, loadSession, saveSession } from './session-store.mjs';

const driveHome = 'https://drive.google.com/drive/u/0/my-drive';
const commands = new Set(['status', 'login', 'list', 'metadata', 'captions']);
const report = value => console.log(JSON.stringify(value));
const progress = value => console.error(JSON.stringify(value));

async function openRequest(session, account) {
  const http = await request.newContext(session);
  const result = await checkGoogleSession(http, account);
  if (result.state === 'session_ready') return { http, result };
  await http.dispose();
  return { result };
}

async function signIn(account) {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  } catch {
    return { result: { state: 'browser_launch_failed' } };
  }
  let state;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(driveHome, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    progress({ state: 'browser_opened', account, signInPage: page.url().startsWith('https://accounts.google.com/') });
    const deadline = Date.now() + 10 * 60_000;
    while (browser.isConnected() && !page.isClosed() && Date.now() < deadline) {
      const check = await checkGoogleSession(context.request, account);
      if (check.state === 'session_ready') {
        state = {
          userAgent: await page.evaluate(() => navigator.userAgent),
          storageState: googleStorageState(await context.storageState()),
        };
        break;
      }
      await delay(2500);
    }
    if (!state) {
      const cancelled = !browser.isConnected() || page.isClosed();
      return { result: { state: cancelled ? 'login_cancelled' : 'login_timed_out' } };
    }
  } finally {
    await browser.close();
  }

  const verified = await openRequest(state, account);
  if (!verified.http) return { result: { state: 'standalone_session_unverified', googleState: verified.result.state } };
  try {
    await saveSession(account, {
      userAgent: state.userAgent,
      storageState: await verified.http.storageState(),
    });
    return verified;
  } catch (error) {
    await verified.http.dispose();
    throw error;
  }
}

function readOptions() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      account: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      'time-zone': { type: 'string' }, query: { type: 'string', multiple: true },
      person: { type: 'string', multiple: true }, calendar: { type: 'string', multiple: true },
      'file-id': { type: 'string', multiple: true }, language: { type: 'string' },
      offset: { type: 'string' }, limit: { type: 'string' }, 'no-login': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) return null;
  if (!commands.has(command) || positionals.length !== 1) throw new Error('Unknown command.');
  const account = values.account?.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account ?? '')) throw new Error('Pass the expected Google email with --account.');
  if (command === 'list') {
    timeWindow(values.from, values.to);
    if (!values['time-zone']) throw new Error('Pass the user’s IANA time zone with --time-zone.');
    new Intl.DateTimeFormat('en', { timeZone: values['time-zone'] });
  }
  if (['metadata', 'captions'].includes(command) &&
      (!values['file-id']?.length || values['file-id'].some(id => !/^[\w-]{10,200}$/.test(id)))) {
    throw new Error('Pass at least one verified --file-id.');
  }
  const offset = values.offset === undefined ? 0 : Number(values.offset);
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (!Number.isInteger(offset) || offset < 0 ||
      (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 250))) {
    throw new Error('Use a nonnegative --offset and a --limit between 1 and 250.');
  }
  if (values.language && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(values.language)) {
    throw new Error('Pass a valid Google Drive track language.');
  }
  return { command, values, account, offset, limit };
}

async function main() {
  const input = readOptions();
  if (!input) {
    console.log('google-meet-http.mjs status|login|list|metadata|captions --account EMAIL');
    console.log('list --from RFC3339 --to RFC3339 --time-zone IANA [--query TITLE] [--person EMAIL] [--calendar NAME]');
    console.log('metadata|captions --file-id ID [--file-id ID] [--language ru] [--offset 0] [--limit 160]');
    return;
  }
  const { command, values, account, offset, limit } = input;
  const saved = await loadSession(account);
  let connection = saved ? await openRequest(saved, account) : { result: { state: 'session_required' } };
  const canSignIn = command !== 'status' && !values['no-login'];
  if (!connection.http && canSignIn && ['session_required', 'account_mismatch'].includes(connection.result.state)) {
    connection = await signIn(account);
  }
  if (!connection.http) {
    report(connection.result);
    process.exitCode = 3;
    return;
  }
  const { http, result } = connection;
  try {
    if (command === 'list') {
      report(await readCalendar(http, {
        expectedAccount: account, from: values.from, to: values.to, timeZone: values['time-zone'],
        queries: values.query, people: values.person, calendarNames: values.calendar,
      }));
    } else if (command === 'metadata' || command === 'captions') {
      const files = await Promise.all(values['file-id'].map(fileId => readDrive(http, {
        fileId, mode: command, offset, limit, language: values.language,
      })));
      report(files.length === 1 ? files[0] : { state: files.every(file => file.state === 'ready') ? 'ready' : 'partial', files });
    } else {
      report(result);
    }
  } finally {
    await http.dispose();
  }
}

main().catch(error => {
  const message = error.message?.split('\n', 1)[0] ?? 'Google Meet HTTP request failed.';
  progress({ state: 'error', message });
  process.exitCode = 1;
});
