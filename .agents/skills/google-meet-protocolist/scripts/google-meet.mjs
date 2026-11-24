import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const calendarOrigin = 'https://www.googleapis.com/calendar/v3';
const meetOrigin = 'https://meet.googleapis.com/v2';
const driveOrigin = 'https://www.googleapis.com/drive/v3';
const meetCodePattern = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const fileIdPattern = /^[A-Za-z0-9_-]{10,200}$/;

class GoogleError extends Error {
  constructor(status, reason) {
    super(`Google API returned HTTP ${status}${reason ? ` (${reason})` : ''}.`);
    this.status = status;
  }
}

function endpoint(origin, path, parameters = {}) {
  const parametersToUse = Object.entries(parameters).filter(([, value]) => value !== undefined);
  const query = new URLSearchParams(parametersToUse);
  return new URL(`${origin}${path}${query.size ? `?${query}` : ''}`);
}

async function googleJson(url, accessToken) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = body?.error?.details?.find(detail => detail.reason)?.reason ?? body?.error?.status;
    throw new GoogleError(response.status, reason);
  }
  if (!body || typeof body !== 'object') throw new Error('Google API returned an invalid response.');
  return body;
}

async function googlePages(url, accessToken, property) {
  const items = [];
  const seen = new Set();
  const nextUrl = new URL(url);
  let pageToken;
  do {
    if (pageToken) nextUrl.searchParams.set('pageToken', pageToken);
    const page = await googleJson(nextUrl, accessToken);
    items.push(...(page[property] ?? []));
    pageToken = page.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new Error('Google API repeated a pagination token.');
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return items;
}

export function timeWindow(from, to) {
  const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!stamp.test(from ?? '') || !stamp.test(to ?? '')) {
    throw new Error('Use RFC 3339 timestamps with an explicit timezone for --from and --to.');
  }
  const start = new Date(from);
  const end = new Date(to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error('The meeting time window must have a valid start before its end.');
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function meetCodeFrom(event) {
  for (const item of [event.hangoutLink, ...(event.conferenceData?.entryPoints ?? []).map(part => part.uri)]) {
    try {
      const link = new URL(item);
      const code = link.pathname.split('/').filter(Boolean)[0];
      if (link.origin === 'https://meet.google.com' && meetCodePattern.test(code ?? '')) return code.toLowerCase();
    } catch {
      // Older calendar items can lack a usable conference URL.
    }
  }
  return null;
}

function recordingAttachments(event) {
  return (event.attachments ?? [])
    .filter(attachment => attachment.mimeType?.startsWith('video/') ||
      (!attachment.mimeType && /(?:recording|запись|\.mp4)$/i.test(attachment.title ?? '')))
    .filter(attachment => fileIdPattern.test(attachment.fileId ?? ''))
    .map(attachment => ({ fileId: attachment.fileId, title: attachment.title ?? null, url: `https://drive.google.com/file/d/${attachment.fileId}/view` }));
}

export function selectMeetings(events, { window, queries = [], people = [] }) {
  const result = [];
  const seen = new Set();
  const titleTerms = queries.map(normalized).filter(Boolean);
  const peopleTerms = people.map(normalized).filter(Boolean);
  const lower = Date.parse(window.from);
  const upper = Date.parse(window.to);

  for (const event of events) {
    const start = event.start?.dateTime;
    const time = Date.parse(start);
    if (event.status === 'cancelled' || !Number.isFinite(time) || time < lower || time >= upper) continue;
    if (event.attendees?.some(person => person.self && person.responseStatus === 'declined')) continue;
    const meetCode = meetCodeFrom(event);
    const attachments = recordingAttachments(event);
    if (!meetCode && !attachments.length) continue;
    if (titleTerms.length && !titleTerms.some(term => normalized(event.summary).includes(term))) continue;
    const attendees = event.attendees ?? [];
    const names = [event.organizer?.email ?? '', ...attendees.flatMap(person => [person.displayName ?? '', person.email ?? ''])];
    if (peopleTerms.some(term => !names.some(name => normalized(name).includes(term)))) continue;
    // A recurring series shares one iCalUID, including across calendars.
    const unique = JSON.stringify([event.iCalUID ?? `${event.calendarId}:${event.id}`, time]);
    if (seen.has(unique)) continue;
    seen.add(unique);
    result.push({
      title: event.summary ?? 'Встреча без названия',
      start,
      end: event.end?.dateTime ?? null,
      calendarId: event.calendarId,
      eventId: event.id,
      calendarUrl: event.htmlLink ?? null,
      recurring: Boolean(event.recurringEventId),
      meetCode,
      organizer: event.organizer?.email ?? null,
      participants: attendees.map(person => person.displayName ?? person.email).filter(Boolean),
      recordingAttachments: attachments,
    });
  }
  return result.sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}

async function listMeetings(accessToken, options, window) {
  const calendars = options.calendar?.length ? [...options.calendar] : ['primary'];
  if (options['visible-calendars']) {
    const list = await googlePages(endpoint(calendarOrigin, '/users/me/calendarList', {
      fields: 'nextPageToken,items(id,primary,selected,accessRole)',
      minAccessRole: 'reader',
    }), accessToken, 'items');
    calendars.push(...list.filter(calendar => calendar.selected && !calendar.primary).map(calendar => calendar.id));
  }
  const errors = [];
  const events = [];
  for (const calendarId of new Set(calendars)) {
    const url = endpoint(calendarOrigin, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin: window.from,
      timeMax: window.to,
      singleEvents: 'true',
      showDeleted: 'false',
      maxResults: '250',
      fields: 'nextPageToken,items(id,iCalUID,summary,status,start,end,recurringEventId,htmlLink,hangoutLink,conferenceData(entryPoints(uri)),organizer(email),attendees(email,displayName,self,responseStatus),attachments(fileId,mimeType,title))',
    });
    try {
      const calendarEvents = await googlePages(url, accessToken, 'items');
      events.push(...calendarEvents.map(event => ({ ...event, calendarId })));
    } catch (error) {
      errors.push({ calendarId, status: error.status ?? null });
    }
  }
  return {
    window,
    checkedCalendars: [...new Set(calendars)],
    errors,
    meetings: selectMeetings(events, { window, queries: options.query, people: options.person }),
  };
}

async function listRecordings(accessToken, meetCode, window) {
  const filter = `space.meeting_code = "${meetCode}" AND start_time >= "${window.from}" AND start_time < "${window.to}"`;
  const records = await googlePages(endpoint(meetOrigin, '/conferenceRecords', { filter, pageSize: '100' }), accessToken, 'conferenceRecords');
  const conferences = [];
  for (const record of records) {
    if (!/^conferenceRecords\/[A-Za-z0-9_-]+$/.test(record.name ?? '')) continue;
    try {
      const items = await googlePages(endpoint(meetOrigin, `/${record.name}/recordings`, { pageSize: '100' }), accessToken, 'recordings');
      conferences.push({
        start: record.startTime,
        end: record.endTime ?? null,
        recordings: items.map(item => {
          const fileId = item.driveDestination?.file?.replace(/^files\//, '');
          return {
            state: item.state,
            start: item.startTime ?? null,
            end: item.endTime ?? null,
            fileId: fileIdPattern.test(fileId ?? '') ? fileId : null,
            url: fileIdPattern.test(fileId ?? '') ? `https://drive.google.com/file/d/${fileId}/view` : null,
          };
        }),
      });
    } catch (error) {
      conferences.push({ start: record.startTime, end: record.endTime ?? null, error: error.status ?? null });
    }
  }
  return { meetCode, window, conferences };
}

async function findDriveCandidates(accessToken, options, window) {
  const title = options.query?.[0];
  if (!title?.trim()) throw new Error('Provide the exact title stem with --query for a Drive lookup.');
  const escaped = title.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const q = `trashed = false and mimeType = 'video/mp4' and createdTime >= '${window.from}' and createdTime < '${window.to}' and name contains '${escaped}'`;
  const files = await googlePages(endpoint(driveOrigin, '/files', {
    q, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '100',
    fields: 'nextPageToken,files(id,name,createdTime,webViewLink)',
  }), accessToken, 'files');
  return { window, title, files };
}

async function inputToken(expectedAccount) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let token;
  try {
    token = JSON.parse(input)?.access_token;
  } catch {
    throw new Error('The Google OAuth provider supplied invalid JSON.');
  }
  if (typeof token !== 'string' || !token.trim()) throw new Error('The trusted OAuth provider supplied no access token.');
  const identity = await googleJson(new URL('https://openidconnect.googleapis.com/v1/userinfo'), token);
  if (identity.email_verified !== true || identity.email?.toLowerCase() !== expectedAccount) {
    throw new Error('The OAuth token does not identify the expected Google account.');
  }
  return token;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string' }, to: { type: 'string' },
      query: { type: 'string', multiple: true }, person: { type: 'string', multiple: true },
      calendar: { type: 'string', multiple: true }, 'visible-calendars': { type: 'boolean' },
      'meet-code': { type: 'string' }, 'oauth-stdin': { type: 'boolean' },
      account: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) {
    console.log('google-meet.mjs list|recordings|drive --oauth-stdin --account EMAIL --from RFC3339 --to RFC3339 [--query TITLE] [--meet-code CODE]');
    return;
  }
  const [command] = positionals;
  const window = timeWindow(values.from, values.to);
  const meetCode = values['meet-code']?.toLowerCase();
  const commands = {
    list: token => listMeetings(token, values, window),
    recordings: token => listRecordings(token, meetCode, window),
    drive: token => findDriveCandidates(token, values, window),
  };
  if (!Object.hasOwn(commands, command) || positionals.length !== 1) throw new Error('Unknown command.');
  if (command === 'recordings' && !meetCodePattern.test(meetCode ?? '')) throw new Error('Pass a valid --meet-code.');
  const account = values.account?.trim().toLowerCase();
  if (!values['oauth-stdin'] || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account ?? '')) {
    throw new Error('Provide --oauth-stdin and the expected Google --account.');
  }
  const result = await commands[command](await inputToken(account));
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    const diagnostic = error.status ? error.message : typeof error.code === 'string' ? error.code : error.message;
    console.error(JSON.stringify({ error: diagnostic, status: error.status ?? null }));
    process.exitCode = 1;
  });
}
