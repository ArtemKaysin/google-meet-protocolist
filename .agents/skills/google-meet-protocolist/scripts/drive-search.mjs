import { createHash } from 'node:crypto';

export const driveOrigin = 'https://drive.google.com';
const searchUrl = 'https://drivefrontend-pa.clients6.google.com/$rpc/google.internal.apps.drive.driveway.v1.DriveFrontendService/SearchItems';
const requestOptions = { maxRedirects: 0, timeout: 15_000 };
const idPattern = /^[A-Za-z0-9_-]{10,200}$/;
const keyPattern = /^[A-Za-z0-9_-]{1,200}$/;
const folderMime = 'application/vnd.google-apps.folder';
const shortcutMime = 'application/vnd.google-apps.shortcut';
const fieldMask = 'partial_items(id,title,mime_type),full_items(id,title,mime_type,parent,alternate_link,resource_key,modified_date_millis,create_date_millis,shortcut_details(target_id,target_mime_type,target_resource_key)),continuation_token';
const normalize = value => value.trim().normalize('NFKC').toLowerCase().replaceAll('ё', 'е');

export function driveReference(value, kind) {
  const input = value?.trim() ?? '';
  if (idPattern.test(input)) return { id: input };
  try {
    const url = new URL(input);
    if (url.origin !== driveOrigin || url.username || url.password) return null;
    const path = kind === 'folder'
      ? /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/
      : /^\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/(?:view|preview|edit))?\/?$/;
    const id = url.pathname.match(path)?.[1] ?? (url.pathname === '/open' ? url.searchParams.get('id') : null);
    const resourceKey = url.searchParams.get('resourcekey');
    if (!idPattern.test(id ?? '') || (resourceKey && !keyPattern.test(resourceKey))) return null;
    return { id, resourceKey: resourceKey || undefined };
  } catch {
    return null;
  }
}

function driveUrl(reference, kind) {
  const path = kind === 'folder' ? '/drive/folders/' + reference.id : '/file/d/' + reference.id + '/view';
  const url = new URL(path, driveOrigin);
  if (reference.resourceKey) url.searchParams.set('resourcekey', reference.resourceKey);
  return url.href;
}

async function webAuthorization(request) {
  const { cookies } = await request.storageState();
  const timestamp = Math.floor(Date.now() / 1000);
  const schemes = [
    ['SAPISIDHASH', 'SAPISID'],
    ['SAPISID1PHASH', '__Secure-1PAPISID'],
    ['SAPISID3PHASH', '__Secure-3PAPISID'],
  ];
  return schemes.flatMap(([scheme, name]) => {
    const cookie = cookies.find(item => item.name === name && item.path === '/' &&
      (item.domain === 'drive.google.com' || item.domain === '.google.com') &&
      (item.expires === -1 || item.expires > timestamp));
    if (!cookie) return [];
    const hash = createHash('sha1').update(timestamp + ' ' + cookie.value + ' ' + driveOrigin).digest('hex');
    return scheme + ' ' + timestamp + '_' + hash;
  }).join(' ');
}

async function pageData(request, url) {
  let response;
  try {
    response = await request.get(url, requestOptions);
  } catch {
    return { state: 'network_error' };
  }
  try {
    const status = response.status();
    const location = response.headers().location;
    if (status === 401 || (location && new URL(location, url).origin === 'https://accounts.google.com')) {
      return { state: 'session_required', status };
    }
    if (status !== 200) return { state: 'unavailable', status };
    return { state: 'ready', html: await response.text() };
  } finally {
    await response.dispose();
  }
}

function fileFromRow(row) {
  if (!Array.isArray(row) || !idPattern.test(row[0] ?? '') ||
      typeof row[2] !== 'string' || typeof row[3] !== 'string') return null;
  const kind = row[3] === folderMime ? 'folder' : 'file';
  const linked = typeof row[114] === 'string' ? driveReference(row[114], kind) : null;
  const ref = linked?.id === row[0] ? linked : { id: row[0] };
  const time = value => Number.isFinite(value) && value > 0 && value < 8.64e15 ? new Date(value).toISOString() : null;
  return {
    id: row[0], title: row[2], mimeType: row[3], url: driveUrl(ref, kind),
    createdTime: time(row[9]), modifiedTime: time(row[10]),
    parentIds: Array.isArray(row[1]) ? row[1].filter(id => idPattern.test(id)) : [],
    shortcut: row[3] === shortcutMime && idPattern.test(row[131]?.[0] ?? '')
      ? { id: row[131][0], mimeType: row[131][2] } : null,
  };
}

function folderSnapshot(html) {
  const raw = html.match(/window\['_DRIVE_ivd'\]\s*=\s*'((?:\\[\s\S]|[^'\\])*)'/)?.[1];
  if (!raw) return null;
  try {
    const escaped = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
    const decoded = raw.replace(/\\(x[\da-f]{2}|u[\da-f]{4}|.)/gi, (_, value) => {
      if (value.length > 1) return String.fromCharCode(parseInt(value.slice(1), 16));
      return escaped[value] ?? value;
    });
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed?.[0])) return null;
    return { files: parsed[0].map(fileFromRow).filter(Boolean), rows: parsed[0].length };
  } catch {
    return null;
  }
}

function htmlText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (!lower.startsWith('#')) return entities[lower];
    const numeric = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : match;
  });
}

async function folderPreview(request, folder) {
  const url = new URL('/embeddedfolderview', driveOrigin);
  url.searchParams.set('id', folder.id);
  if (folder.resourceKey) url.searchParams.set('resourcekey', folder.resourceKey);
  const result = await pageData(request, url.href);
  if (result.state !== 'ready') return result;
  const entries = [...result.html.matchAll(/<div\b[^>]*\bclass="flip-entry"\s+id="entry-([A-Za-z0-9_-]+)"[^>]*>/gi)];
  if (!entries.length) return { state: 'unexpected_folder_preview' };
  const files = entries.flatMap((entry, index) => {
    const block = result.html.slice(entry.index, entries[index + 1]?.index);
    const href = block.match(/<a\b[^>]*\bhref="([^"]+)"/i)?.[1];
    const name = block.match(/<div class="flip-entry-title">([^<]*)<\/div>/i)?.[1];
    if (!href || name === undefined) return [];
    const link = htmlText(href);
    const isFolder = /^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\//.test(link);
    const ref = driveReference(link, isFolder ? 'folder' : 'file');
    if (!ref || ref.id !== entry[1]) return [];
    const mimeType = isFolder ? folderMime
      : block.match(/https:\/\/drive-thirdparty\.googleusercontent\.com\/\d+\/type\/([^"?&#\s]+)/i)?.[1];
    if (!mimeType) return [];
    return [{ id: ref.id, title: htmlText(name), mimeType, url: driveUrl(ref, isFolder ? 'folder' : 'file'),
      parentIds: [folder.id], createdTime: null, modifiedTime: null, shortcut: null }];
  });
  return { state: 'ready', files };
}

async function searchItems(request, apiKey, { title, folder, mimeType } = {}) {
  const criteria = [];
  // These are positional fields in the request sent by Drive's search interface.
  if (title) criteria[0] = [[1, title, 0]];
  criteria[4] = 0;
  if (mimeType) criteria[8] = [[mimeType, 0]];
  if (folder) criteria[34] = [[folder.id]];

  const files = new Map();
  const seen = new Set();
  const issues = [];
  let cursor;
  do {
    const authorization = await webAuthorization(request);
    if (!authorization) return { state: 'session_required', files: [], issues };
    const headers = {
      origin: driveOrigin, authorization, 'content-type': 'application/json+protobuf',
      'x-goog-authuser': '0', 'x-goog-api-key': apiKey, 'x-goog-fieldmask': fieldMask,
    };
    if (folder?.resourceKey) headers['x-goog-drive-resource-keys'] = folder.id + '/' + folder.resourceKey;
    let response;
    try {
      response = await request.post(searchUrl, {
        ...requestOptions, headers, data: JSON.stringify([criteria, cursor ? [50, cursor] : [50], 1]),
      });
    } catch {
      issues.push({ state: 'search_network_error' });
      break;
    }
    try {
      const status = response.status();
      if (status === 401) return { state: 'session_required', files: [], issues };
      if (status !== 200) {
        issues.push({ state: 'search_http_error', status });
        break;
      }
      const payload = await response.json().catch(() => null);
      const pages = payload?.[0];
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
        issues.push({ state: 'unexpected_search_format' });
        break;
      }
      for (const part of pages) {
        for (const row of Array.isArray(part[1]) ? part[1] : Array.isArray(part[0]) ? part[0] : []) {
          const item = fileFromRow(row);
          if (item) files.set(item.id, item);
          else if (!issues.some(issue => issue.state === 'unreadable_result')) issues.push({ state: 'unreadable_result' });
        }
      }
      const last = pages.at(-1);
      cursor = typeof last?.[3] === 'string' && last[3] ? last[3] : null;
      if (cursor && seen.has(cursor)) {
        issues.push({ state: 'repeated_page_token' });
        break;
      }
      if (cursor) seen.add(cursor);
    } finally {
      await response.dispose();
    }
  } while (cursor);
  return { state: issues.length ? 'partial' : 'ready', files: [...files.values()], issues };
}

export async function findDriveVideos(request, { queries = [], folder, folderName, recursive = false } = {}) {
  const titles = [...new Set(queries.map(value => value.trim()).filter(Boolean))];
  if (!titles.length && !folder && !folderName) throw new Error('Pass a video title or a Drive folder.');
  if (recursive && !folder && !folderName) throw new Error('Pass a Drive folder for recursive search.');
  const target = folder ? driveReference(folder, 'folder') : null;
  if ((folder && !target) || (folder && folderName)) throw new Error('Pass one valid Drive folder link, ID or name.');

  const bootstrap = await pageData(request, driveOrigin + '/drive/u/0/my-drive');
  if (bootstrap.state !== 'ready') return bootstrap;
  const apiKey = bootstrap.html.match(/"yLTeS"\s*:\s*"(AIza[\w-]{35})"/)?.[1];
  if (!apiKey) return { state: 'unexpected_drive_bootstrap' };

  let root = target;
  const issues = [];
  if (folderName) {
    const result = await searchItems(request, apiKey, { title: folderName, mimeType: folderMime });
    if (result.state !== 'ready') return { state: result.state, issues: result.issues };
    const folders = result.files.filter(file => file.mimeType === folderMime && normalize(file.title) === normalize(folderName));
    if (folders.length !== 1) {
      return {
        state: folders.length ? 'ambiguous_folder' : 'folder_not_found',
        folders: folders.map(file => ({ title: file.title, url: file.url })),
      };
    }
    root = driveReference(folders[0].url, 'folder');
  }
  const snapshots = new Map();
  if (root) {
    const verified = await pageData(request, driveUrl(root, 'folder'));
    if (verified.state !== 'ready') return verified;
    const snapshot = folderSnapshot(verified.html);
    if (!snapshot) return { state: 'folder_unverified' };
    snapshots.set(root.id, snapshot);
  }

  const matches = new Map();
  function addVideo(file) {
    const targetVideo = typeof file.shortcut?.mimeType === 'string' && file.shortcut.mimeType.startsWith('video/');
    if (!file.mimeType.startsWith('video/') && !targetVideo) return;
    const fileId = targetVideo ? file.shortcut.id : file.id;
    const existing = matches.get(fileId);
    if (existing && (targetVideo || !existing.shortcutId)) return;
    matches.set(fileId, {
      fileId, title: file.title, mimeType: targetVideo ? file.shortcut.mimeType : file.mimeType,
      url: targetVideo ? driveUrl({ id: fileId }, 'file') : file.url,
      createdTime: file.createdTime, modifiedTime: file.modifiedTime, parentIds: file.parentIds,
      ...(targetVideo ? { shortcutId: file.id } : {}),
    });
  }

  const jobs = root ? [root] : [null];
  const visited = new Set();
  const matchesTitle = file => !titles.length || titles.some(term => normalize(file.title).includes(normalize(term)));
  for (const current of jobs) {
    if (current && visited.has(current.id)) continue;
    if (current) visited.add(current.id);
    const queryTitles = recursive || !titles.length ? [undefined] : titles;
    const files = new Map();
    for (const title of queryTitles) {
      const result = await searchItems(request, apiKey, { title, folder: current });
      if (result.state === 'session_required') return { state: result.state };
      issues.push(...result.issues.map(issue => ({ ...issue, folderId: current?.id })));
      for (const file of result.files) files.set(file.id, file);
    }
    const relevant = file => (recursive && file.mimeType === folderMime) || matchesTitle(file);
    if (current) {
      let snapshot = snapshots.get(current.id);
      if (!snapshot && !files.size) {
        const response = await pageData(request, driveUrl(current, 'folder'));
        if (response.state === 'session_required') return { state: response.state };
        snapshot = response.html && folderSnapshot(response.html);
        if (!snapshot) issues.push({ state: 'folder_unverified', folderId: current.id });
      }
      if (snapshot && ((!files.size && snapshot.rows) ||
          snapshot.files.some(file => relevant(file) && !files.has(file.id)))) {
        const listed = snapshot.files.filter(relevant);
        if (snapshot.rows >= 50) {
          const preview = await folderPreview(request, current);
          if (preview.state === 'session_required') return { state: preview.state };
          issues.push({ state: 'folder_preview_unpaged', folderId: current.id });
          if (preview.state === 'ready') listed.push(...preview.files.filter(relevant));
        } else if (snapshot.files.length !== snapshot.rows) {
          issues.push({ state: 'unexpected_folder_format', folderId: current.id });
        }
        for (const file of listed) if (!files.has(file.id)) files.set(file.id, file);
      }
    }
    for (const file of files.values()) {
      if (recursive && current && file.mimeType === folderMime && !visited.has(file.id)) {
        const child = driveReference(file.url, 'folder');
        if (child) jobs.push(child);
      }
      if (!recursive || matchesTitle(file)) addVideo(file);
    }
  }
  return {
    state: issues.length ? 'partial' : 'ready',
    folder: root ? { id: root.id, url: driveUrl(root, 'folder') } : null,
    videos: [...matches.values()], issues,
  };
}
