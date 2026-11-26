import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium, request } from 'playwright-core';
import { calendarWeekMatchesAccount, calendarWindow, readCalendar } from './calendar-http.mjs';
import { checkGoogleSession, readDrive } from './drive-http.mjs';
import { driveReference, findDriveVideos } from './drive-search.mjs';
import { googleStorageState, loadSession, saveSession } from './session-store.mjs';

const driveHome = 'https://drive.google.com/drive/u/0/my-drive';
const calendarHome = 'https://calendar.google.com/calendar/u/0/r';
const macOS = process.platform === 'darwin';
const commands = new Set(['status', 'login', 'list', 'videos', 'metadata', 'captions']);
const report = value => console.log(JSON.stringify(value));
const progress = value => console.error(JSON.stringify(value));

async function openRequest(session, account) {
  const http = await request.newContext(session);
  const result = await checkGoogleSession(http, account);
  if (result.state === 'session_ready') return { http, result };
  await http.dispose();
  return { result };
}

async function calendarSession(http, account) {
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  let url = new URL(calendarHome + '/week/' + monday.toISOString().slice(0, 10).replaceAll('-', '/'));
  for (let i = 0; i < 5; i++) {
    let response;
    try {
      response = await http.get(url.href, { maxRedirects: 0, timeout: 10_000 });
      const status = response.status();
      const headers = response.headers();
      if (status === 200 && /^text\/html\b/i.test(headers['content-type'] ?? '')) {
        return calendarWeekMatchesAccount(await response.text(), account) ? 'ready' : 'unavailable';
      }
      if (status === 401) return 'session_required';
      if (status < 300 || status >= 400 || !headers.location) return 'unavailable';
      const next = new URL(headers.location, url);
      if (next.origin === 'https://accounts.google.com') return 'session_required';
      if (next.origin !== 'https://calendar.google.com' || !next.pathname.startsWith('/calendar/u/0/r/') ||
          next.searchParams.has('authuser')) return 'unavailable';
      url = next;
    } catch { return 'unavailable'; }
    finally { await response?.dispose(); }
  }
  return 'unavailable';
}

async function signIn(account, saved) {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  } catch {
    return { result: { state: 'browser_launch_failed' } };
  }
  let state;
  try {
    const context = await browser.newContext(saved ?? {});
    const page = await context.newPage();
    // Sign-in redirects can destroy the page context, so read the UA before navigating on macOS.
    const userAgent = macOS ? await page.evaluate(() => navigator.userAgent) : null;
    await page.goto(driveHome, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    progress({ state: 'browser_opened', account, signInPage: page.url().startsWith('https://accounts.google.com/') });
    const deadline = Date.now() + 10 * 60_000;
    let calendarOpened = false;
    while (browser.isConnected() && !page.isClosed() && Date.now() < deadline) {
      const check = await checkGoogleSession(context.request, account);
      if (check.state === 'session_ready') {
        if (macOS) {
          if (!calendarOpened) {
            calendarOpened = true;
            await page.goto(calendarHome, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
            progress({ state: 'calendar_opened', signInPage: page.url().startsWith('https://accounts.google.com/') });
          }
          const calendar = await calendarSession(context.request, account);
          if (calendar === 'unavailable') return { result: { state: 'browser_calendar_unverified' } };
          if (calendar !== 'ready') { await delay(2500); continue; }
        }
        state = {
          userAgent: userAgent ?? await page.evaluate(() => navigator.userAgent),
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
    if (macOS && await calendarSession(verified.http, account) !== 'ready') {
      await verified.http.dispose();
      return { result: { state: 'standalone_calendar_unverified' } };
    }
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
      'file-id': { type: 'string', multiple: true }, file: { type: 'string', multiple: true }, language: { type: 'string' },
      folder: { type: 'string' }, 'folder-name': { type: 'string' }, recursive: { type: 'boolean' },
      offset: { type: 'string' }, limit: { type: 'string' }, 'no-login': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) return null;
  if (!commands.has(command) || positionals.length !== 1) throw new Error('Unknown command.');
  const account = values.account?.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account ?? '')) throw new Error('Pass the expected Google email with --account.');
  if (command === 'list') calendarWindow(values.from, values.to, values['time-zone']);
  const folder = values.folder?.trim();
  const folderName = values['folder-name']?.trim();
  if (command === 'videos') {
    if (!values.query?.some(title => title.trim()) && !folder && !folderName) {
      throw new Error('Pass --query, --folder or --folder-name.');
    }
    if ((folder && (folderName || !driveReference(folder, 'folder'))) || (values.recursive && !folder && !folderName)) {
      throw new Error('Pass one valid Drive folder link, ID or name.');
    }
  }
  const files = [...(values['file-id'] ?? []).map(id => /^[A-Za-z0-9_-]{10,200}$/.test(id) ? { id } : null),
    ...(values.file ?? []).map(url => driveReference(url, 'file'))];
  if (['metadata', 'captions'].includes(command) && (!files.length || files.some(file => !file))) {
    throw new Error('Pass at least one verified --file-id or --file Drive link.');
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
  return { command, values, account, offset, limit, folder, folderName, files };
}

async function main() {
  const input = readOptions();
  if (!input) {
    console.log('google-meet-http.mjs status|login|list|videos|metadata|captions --account EMAIL');
    console.log('list --from RFC3339 --to RFC3339 --time-zone IANA [--query TITLE] [--person EMAIL] [--calendar NAME]');
    console.log('videos [--query TITLE] [--folder URL_OR_ID | --folder-name NAME] [--recursive]');
    console.log('metadata|captions [--file-id ID | --file URL] [--language ru] [--offset 0] [--limit 160]');
    return;
  }
  const { command, values, account, offset, limit, folder, folderName, files } = input;
  const saved = await loadSession(account);
  let connection = saved ? await openRequest(saved, account) : { result: { state: 'session_required' } };
  let repairSession;
  if (macOS && command === 'login' && connection.http) {
    const calendar = await calendarSession(connection.http, account);
    if (calendar !== 'ready') {
      await connection.http.dispose();
      if (calendar === 'session_required') repairSession = saved;
      connection = { result: { state: repairSession ? 'session_required' : 'standalone_calendar_unverified' } };
    }
  }
  const canSignIn = command !== 'status' && !values['no-login'];
  if (!connection.http && canSignIn && ['session_required', 'account_mismatch'].includes(connection.result.state)) {
    connection = await signIn(account, repairSession);
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
    } else if (command === 'videos') {
      report(await findDriveVideos(http, { queries: values.query, folder, folderName, recursive: values.recursive }));
    } else if (command === 'metadata' || command === 'captions') {
      const unique = [...new Map(files.map(file => [file.id, file])).values()];
      const results = await Promise.all(unique.map(({ id, resourceKey }) => readDrive(http, {
        fileId: id, resourceKey, mode: command, offset, limit, language: values.language,
      })));
      report(results.length === 1 ? results[0] : { state: results.every(file => file.state === 'ready') ? 'ready' : 'partial', files: results });
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
