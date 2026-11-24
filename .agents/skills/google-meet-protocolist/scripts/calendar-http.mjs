export function calendarWindow(from, to, timeZone) {
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const lower = Date.parse(from);
  const upper = Date.parse(to);
  if (!timestamp.test(from) || !timestamp.test(to) || !(lower < upper)) {
    throw new Error('Pass a nonempty RFC 3339 interval with an explicit offset.');
  }
  if (!timeZone) throw new Error('Pass the user’s IANA time zone.');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return { lower, upper, formatter };
}

export async function readCalendar(request, {
  expectedAccount,
  from,
  to,
  timeZone,
  queries = [],
  people = [],
  calendarNames = [],
}) {
  const { lower, upper, formatter } = calendarWindow(from, to, timeZone);
  const email = expectedAccount.trim().toLowerCase();
  const origin = 'https://calendar.google.com';
  const dayMs = 86_400_000;
  const lookups = [];
  const issues = [];
  const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const titleTerms = queries.map(normalize).filter(Boolean);
  const personTerms = people.map(normalize).filter(Boolean);
  const requestedCalendars = calendarNames.map(normalize).filter(Boolean);
  const named = new Set([...requestedCalendars, ...titleTerms]);
  const matchesTitle = title => !titleTerms.length || titleTerms.some(term => normalize(title).includes(term));

  function localDay(time) {
    const parts = Object.fromEntries(formatter.formatToParts(time).map(({ type, value }) => [type, value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  }

  const dateKey = (time, delimiter = '-') => new Date(time).toISOString().slice(0, 10).replaceAll('-', delimiter);
  const first = localDay(lower);
  const last = localDay(upper - 1);
  const firstMonday = first - ((new Date(first).getUTCDay() + 6) % 7) * dayMs;
  for (let monday = firstMonday; monday <= last; monday += 7 * dayMs) {
    lookups.push({
      week: dateKey(monday, '/'),
      start: dateKey(Math.max(monday, first), ''),
      end: dateKey(Math.min(monday + 7 * dayMs, last + dayMs), ''),
    });
  }

  async function fetchHtml(start) {
    let url = new URL(start, origin);
    for (let hop = 0; hop < 4; hop++) {
      let reply;
      try {
        reply = await request.get(url.href, { maxRedirects: 0, timeout: 15_000 });
      } catch {
        return { issue: 'network_error' };
      }
      try {
        const status = reply.status();
        const location = reply.headers().location;
        if (status >= 300 && status < 400 && location) {
          const next = new URL(location, url);
          if (next.origin === 'https://accounts.google.com') return { issue: 'session_required', status };
          if (next.origin !== origin || !next.pathname.startsWith('/calendar/')) {
            return { issue: 'unexpected_redirect', status };
          }
          url = next;
          continue;
        }
        if (status === 401) return { issue: 'session_required', status };
        return status === 200 ? { html: await reply.text(), url } : { issue: 'http_error', status };
      } finally {
        await reply.dispose();
      }
    }
    return { issue: 'unexpected_redirect' };
  }

  function eventLink(link, base = origin) {
    try {
      const url = new URL(link, base);
      if (![origin, 'https://www.google.com'].includes(url.origin) ||
          !/^\/calendar\/(?:u\/0\/)?event$/.test(url.pathname)) return null;
      const eid = url.searchParams.get('eid');
      if (!/^[\w-]+={0,2}$/.test(eid ?? '')) return null;
      const [eventKey, calendarId] = atob(eid.replaceAll('-', '+').replaceAll('_', '/')).split(' ');
      if (!eventKey || !calendarId) return null;
      return { eid, eventKey, calendarId, calendarUrl: origin + '/calendar/event?eid=' + encodeURIComponent(eid) };
    } catch {
      return null;
    }
  }

  function meetingLinks(record) {
    const attachments = (Array.isArray(record[56]) ? record[56] : []).filter(item => Array.isArray(item) &&
      typeof item[3] === 'string' && item[3].startsWith('video/') && /^[\w-]{10,200}$/.test(item[4] ?? ''))
      .map(item => ({ fileId: item[4], title: item[1] ?? null, url: 'https://drive.google.com/file/d/' + item[4] + '/view' }));
    const meetCode = typeof record[45] === 'string'
      ? record[45].match(/^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i)?.[1] ?? null
      : null;
    return { meetCode, recordingAttachments: attachments };
  }

  function parseRecord(row) {
    const record = row?.[3];
    const link = Array.isArray(record) && typeof record[2] === 'string' ? eventLink(record[2]) : null;
    if (!link || typeof record[5] !== 'string' || !Number.isFinite(record[35]?.[1]?.[0])) return null;
    const guests = Array.isArray(record[20]) ? record[20] : [];
    return {
      ...link,
      title: record[5],
      startMs: record[35][1][0],
      endMs: Number.isFinite(record[36]?.[1]?.[0]) ? record[36][1][0] : null,
      recurring: Boolean(record[55] || record[12]?.length),
      template: Boolean(record[12]?.length && !record[55]),
      declined: guests.some(person => typeof person?.[0] === 'string' && person[0].toLowerCase() === email && person[5] === 1),
      organizer: record[34]?.[0] ?? record[9]?.[0] ?? null,
      participants: guests.map(person => person?.[0]).filter(value => typeof value === 'string'),
      ...meetingLinks(record),
    };
  }

  function parseWeek(html) {
    const script = html.match(/<script\b[^>]*\bid=["']initialdata["'][^>]*>([\s\S]*?)<\/script>/i);
    const batch = script && JSON.parse(script[1])?.[39]?.[1];
    if (!Array.isArray(batch?.[0]?.[1]) || !Array.isArray(batch?.[2]?.[1])) return null;
    // The web response uses positional arrays for events, calendars and the selected set.
    return {
      events: batch[0][1].map(parseRecord).filter(Boolean),
      calendars: batch[2][1].map(row => ({ id: row[1]?.[0], title: row[1]?.[1]?.[0] }))
        .filter(calendar => typeof calendar.id === 'string' && typeof calendar.title === 'string'),
      selected: Array.isArray(batch[4]?.[1]) ? batch[4][1].map(row => row[5]?.[4]).filter(id => typeof id === 'string') : null,
    };
  }

  function htmlText(value) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return value.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
      const lower = entity.toLowerCase();
      if (!lower.startsWith('#')) return entities[lower];
      const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
  }

  function parseAgenda(html, base) {
    if (!/\bclass=["'][^"']*\bview-agenda\b/i.test(html)) return null;
    return [...html.matchAll(/<a\b[^>]*\bclass=["']event-link["'][^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(([, href, title]) => {
        const link = eventLink(htmlText(href), base);
        return link && { ...link, title: htmlText(title) };
      }).filter(Boolean);
  }

  function materialize(occurrence, templates) {
    const slot = occurrence.eventKey.match(/^(.*)_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!slot) return null;
    const [, master, year, month, day, hour, minute, second] = slot;
    const template = templates.get(occurrence.calendarId + ' ' + master);
    if (!template) return null;
    const startMs = Date.parse(year + '-' + month + '-' + day + 'T' + hour + ':' + minute + ':' + second + 'Z');
    const duration = template.endMs === null ? null : template.endMs - template.startMs;
    // The agenda supplies the occurrence, while the series supplies its meeting details.
    return {
      ...template, ...occurrence, startMs,
      endMs: duration === null ? null : startMs + duration,
      template: false, recurring: true, recordingAttachments: [],
    };
  }

  async function batch(items, work) {
    const output = [];
    for (let start = 0; start < items.length; start += 4) {
      output.push(...await Promise.all(items.slice(start, start + 4).map(work)));
    }
    return output;
  }

  const weeks = await batch(lookups, async lookup => {
    const result = await fetchHtml('/calendar/u/0/r/week/' + lookup.week);
    if (result.issue) {
      issues.push({ source: 'week', week: lookup.week, state: result.issue, status: result.status });
      return null;
    }
    try {
      const week = parseWeek(result.html);
      if (week) {
        if (!week.selected) issues.push({ source: 'week', week: lookup.week, state: 'calendar_selection_unverified' });
        return { ...lookup, ...week };
      }
    } catch {
      // An unfamiliar response must not be mistaken for an empty week.
    }
    issues.push({ source: 'week', week: lookup.week, state: 'unexpected_format' });
    return null;
  });
  if (issues.some(issue => issue.state === 'session_required')) return { state: 'session_required' };

  const records = new Map();
  const templates = new Map();
  const calendars = new Map([[email, 'primary']]);
  for (const week of weeks.filter(Boolean)) {
    for (const calendar of week.calendars) {
      if (week.selected?.includes(calendar.id) || named.has(normalize(calendar.title)) || named.has(normalize(calendar.id))) {
        calendars.set(calendar.id, calendar.title);
      }
    }
    for (const event of week.events) {
      const available = week.calendars.find(calendar => calendar.id === event.calendarId);
      if (available) calendars.set(available.id, available.title);
      if (event.template) templates.set(event.calendarId + ' ' + event.eventKey, event);
      else records.set(event.eid, event);
    }
  }
  for (const title of requestedCalendars) {
    if (![...calendars].some(([id, name]) => title === normalize(id) || title === normalize(name))) {
      issues.push({ source: 'calendar', title, state: 'calendar_not_found' });
    }
  }

  const agendas = lookups.flatMap(lookup => [...calendars].map(([calendarId]) => ({ ...lookup, calendarId })));
  const occurrences = await batch(agendas, async item => {
    const url = new URL('/calendar/u/0/htmlembed', origin);
    url.search = new URLSearchParams({
      src: item.calendarId, mode: 'AGENDA', dates: item.start + '/' + item.end, ctz: timeZone, hl: 'en',
    });
    const result = await fetchHtml(url);
    const rows = result.html ? parseAgenda(result.html, result.url) : null;
    if (rows) return rows;
    issues.push({ source: 'agenda', week: item.week, calendarId: item.calendarId, state: result.issue ?? 'unexpected_format', status: result.status });
    return [];
  });
  if (issues.some(issue => issue.state === 'session_required')) return { state: 'session_required' };

  for (const occurrence of occurrences.flat()) {
    if (records.has(occurrence.eid) || !matchesTitle(occurrence.title)) continue;
    const event = materialize(occurrence, templates);
    if (event) records.set(event.eid, event);
    else issues.push({ source: 'event', title: occurrence.title, calendarUrl: occurrence.calendarUrl, state: 'details_unresolved' });
  }

  const meetings = new Map();
  for (const event of [...records.values()].sort((a, b) => a.startMs - b.startMs)) {
    if (event.startMs < lower || event.startMs >= upper || event.declined || !matchesTitle(event.title)) continue;
    if (!event.meetCode && !event.recordingAttachments.length) continue;
    const participants = [event.organizer, ...event.participants].map(normalize);
    if (personTerms.some(person => !participants.some(value => value.includes(person)))) continue;
    const key = JSON.stringify([event.eventKey, event.startMs]);
    const first = meetings.get(key);
    if (first) {
      for (const attachment of event.recordingAttachments) {
        if (!first.recordingAttachments.some(old => old.fileId === attachment.fileId)) {
          first.recordingAttachments.push(attachment);
        }
      }
      continue;
    }
    meetings.set(key, {
      title: event.title, start: new Date(event.startMs).toISOString(),
      end: event.endMs === null ? null : new Date(event.endMs).toISOString(),
      calendarId: event.calendarId, eventId: event.eid, calendarUrl: event.calendarUrl,
      recurring: event.recurring, meetCode: event.meetCode, organizer: event.organizer,
      participants: event.participants, recordingAttachments: [...event.recordingAttachments],
    });
  }
  return {
    state: issues.length ? 'partial' : 'ready',
    window: { from, to, timeZone },
    checkedCalendars: [...calendars].map(([id, title]) => ({ id, title })),
    meetings: [...meetings.values()],
    issues,
  };
}
