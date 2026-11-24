const origin = 'https://drive.google.com';
const requestOptions = { maxRedirects: 0, timeout: 15_000 };

export async function checkGoogleSession(request, expectedAccount) {
  const email = expectedAccount.trim().toLowerCase();

  async function checkAccount() {
    const response = await request.post('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', {
      ...requestOptions,
      headers: { Origin: 'https://www.google.com', 'Content-Type': 'application/x-www-form-urlencoded' },
      data: ' ',
    });
    try {
      const status = response.status();
      if (status === 401) return { state: 'session_required', status };
      if (status !== 200) return { state: 'session_unverified', status };
      const result = await response.json();
      if (result?.[0] !== 'gaia.l.a.r' || !Array.isArray(result[1])) return { state: 'session_unverified', status };
      // ListAccounts returns the default account first. The timedtext URL uses that account.
      const [account] = result[1];
      if (!account) return { state: 'session_required', status };
      if (account[0] !== 'gaia.l.a' || typeof account[3] !== 'string' || !account[3]) {
        return { state: 'session_unverified', status };
      }
      if (account[9] === 0 || account[14] === 1) return { state: 'session_required', status };
      return { state: account[3].trim().toLowerCase() === email ? 'session_ready' : 'account_mismatch', status };
    } finally {
      await response.dispose();
    }
  }

  async function checkDrive() {
    const url = new URL('/drive/u/0/my-drive', origin);
    const response = await request.get(url.href, requestOptions);
    try {
      const status = response.status();
      const headers = response.headers();
      if (status === 401 || (status >= 300 && status < 400 && headers.location &&
        new URL(headers.location, url).origin === 'https://accounts.google.com')) {
        return { state: 'session_required', status };
      }
      const drivePage = status === 200 && /^text\/html\b/i.test(headers['content-type'] ?? '');
      return { state: drivePage ? 'session_ready' : 'session_unverified', status };
    } finally {
      await response.dispose();
    }
  }

  try {
    const account = await checkAccount();
    if (account.state !== 'session_ready') return account;
    return await checkDrive();
  } catch {
    return { state: 'session_unverified' };
  }
}

export async function readDrive(request, { fileId, mode = 'captions', offset = 0, limit = 160, language = 'ru' }) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId ?? '')) throw new Error('Pass a verified Drive file ID.');
  if (!['captions', 'metadata'].includes(mode)) throw new Error('Use captions or metadata mode.');
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) throw new Error('Pass a valid track language.');
  if (!Number.isInteger(offset) || offset < 0 ||
      (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 250))) {
    throw new Error('Use a nonnegative offset and a page size between 1 and 250, or null for the full track.');
  }

  if (mode === 'metadata') {
    const url = new URL('/file/d/' + fileId + '/view', origin);
    const response = await request.get(url.href, requestOptions);
    try {
      const status = response.status();
      const location = response.headers().location;
      if (status === 401 || (location && new URL(location, url).origin === 'https://accounts.google.com')) {
        return { fileId, state: 'session_required', status };
      }
      if (status !== 200) return { fileId, state: 'unavailable', status };
      const html = await response.text();
      const meta = new Map([...html.matchAll(/<meta\b[^>]*\bproperty=["']og:(title|url)["'][^>]*\bcontent=(["'])(.*?)\2[^>]*>/gi)]
        .map(([, key, , value]) => [key, value]));
      const canonical = meta.get('url')?.replaceAll('&amp;', '&');
      if (!canonical || !meta.get('title')) return { fileId, state: 'unverified', status };
      const link = new URL(canonical, origin);
      if (link.origin !== origin || link.pathname !== url.pathname) return { fileId, state: 'unverified', status };
      const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
      const title = meta.get('title').replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => entities[key]);
      return { fileId, state: 'ready', status, title, url: url.href };
    } finally {
      await response.dispose();
    }
  }

  const url = new URL('/timedtext', origin);
  url.search = new URLSearchParams({
    id: fileId, type: 'track', lang: language, kind: 'asr', fmt: 'json3', xospf: '1',
  });
  async function get(start) {
    let next = new URL(start);
    for (let hop = 0; hop < 4; hop++) {
      const response = await request.get(next.href, requestOptions);
      try {
        const status = response.status();
        const location = response.headers().location;
        if (status < 300 || status >= 400 || !location) {
          return { status, body: await response.text() };
        }
        const target = new URL(location, next);
        if (target.hostname === 'accounts.google.com') return { status, sessionRequired: true };
        if (target.origin !== origin || !/^\/(?:u\/\d+\/)?timedtext$/.test(target.pathname)) return { status, unsupportedRedirect: true };
        next = target;
      } finally {
        await response.dispose();
      }
    }
    return { status: 302, unsupportedRedirect: true };
  }

  const track = await get(url);
  if (track.sessionRequired) return { fileId, state: 'session_required', status: track.status };
  if (track.status !== 200) return { fileId, state: 'unavailable', status: track.status };
  let payload;
  try { payload = JSON.parse(track.body); } catch {}
  const rows = (payload?.events ?? []).map(event => ({
    startMs: event.tStartMs ?? 0,
    durationMs: event.dDurationMs ?? null,
    text: (event.segs ?? []).map(segment => segment.utf8 ?? '').join(''),
  })).filter(row => row.text.trim());
  if (!rows.length) {
    const listUrl = new URL('/timedtext', origin);
    listUrl.search = new URLSearchParams({ id: fileId, v: fileId, type: 'list', hl: language, vssids: '1' });
    const list = await get(listUrl);
    if (list.sessionRequired) return { fileId, state: 'session_required', status: list.status };
    const languages = Array.from((list.body ?? '').matchAll(/<track\b[^>]*\blang_code="([^"]+)"/gi), match => match[1]);
    return { fileId, state: 'no_text', status: track.status, listStatus: list.status, languages };
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
  const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const end = limit === null ? rows.length : Math.min(rows.length, offset + limit);
  return { fileId, state: 'ready', language, total: rows.length, revision, offset, nextOffset: end < rows.length ? end : null, rows: rows.slice(offset, end) };
}
