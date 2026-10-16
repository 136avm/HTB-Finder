'use strict';
/*
 * HTB Machine Finder - server
 *
 * - Holds the Hack The Box token (HTB_TOKEN) so it never reaches the browser.
 * - Synchronises the machine list and every machine profile in the background,
 *   retrying until each listed machine has its profile.
 * - Persists everything to DATA_DIR/machines.json.
 * - Serves the single-page UI from ./public.
 *
 * No runtime dependencies. Requires Node 18+ (global fetch).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- config
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const PORT = num(process.env.PORT, 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TARGET = (process.env.HTB_BASE_URL || 'https://labs.hackthebox.com').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'machines.json');
const SYNC_INTERVAL_MIN = num(process.env.SYNC_INTERVAL_MINUTES, 60); // 0 disables periodic sync
const MIN_SYNC_GAP_MS = num(process.env.MIN_SYNC_GAP_SECONDS, 10) * 1000;
const CONCURRENCY = Math.max(1, num(process.env.CONCURRENCY, 4));
const BACKOFF_MS = num(process.env.BACKOFF_BASE_MS, 2000);
const RETRY_AFTER_FAILURE_MS = num(process.env.SYNC_RETRY_SECONDS, 60) * 1000;
const REQUEST_GAP_MS = num(process.env.REQUEST_GAP_MS, 120);

function readToken() {
  if (process.env.HTB_TOKEN_FILE) {
    try { return fs.readFileSync(process.env.HTB_TOKEN_FILE, 'utf8').trim(); }
    catch (e) { console.error('Cannot read HTB_TOKEN_FILE: ' + e.message); }
  }
  return (process.env.HTB_TOKEN || '').trim();
}
const TOKEN = readToken();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- store
fs.mkdirSync(DATA_DIR, { recursive: true });
let store = { list: {}, cache: {} };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  store = { list: d.list || {}, cache: d.cache || {} };
  log(`Loaded ${Object.keys(store.list).length} machines from ${DATA_FILE}`);
} catch { /* first run */ }

function persist() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA_FILE);
}

const hasProfile = id => { const c = store.cache[id]; return !!(c && typeof c === 'object' && c.name); };

// ---------------------------------------------------------------- state
const state = {
  running: false, phase: 'idle', round: 0,
  lastSync: null, lastListSync: null, lastError: null, warning: null,
  retryAt: null, version: 0,
};
const unavailable = new Set(); // profiles HTB answers 404 for; reported, not retried within a run
let pauseUntil = 0;            // shared rate-limit pause
let retryTimer = null;

class FatalError extends Error {}

function status() {
  const ids = Object.keys(store.list);
  const withProfile = ids.filter(hasProfile).length;
  const unavail = ids.filter(id => unavailable.has(id) && !hasProfile(id)).length;
  return {
    tokenConfigured: !!TOKEN,
    running: state.running, phase: state.phase, round: state.round,
    total: ids.length, withProfile, unavailable: unavail,
    complete: ids.length > 0 && withProfile + unavail === ids.length,
    lastSync: state.lastSync, lastListSync: state.lastListSync,
    lastError: state.lastError, warning: state.warning, retryAt: state.retryAt,
    version: state.version,
  };
}

// ---------------------------------------------------------------- HTB client
async function htb(p) {
  const headers = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json', 'User-Agent': 'htb-machine-finder/1.0' };
  for (let attempt = 0; ; attempt++) {
    const wait = pauseUntil - Date.now();
    if (wait > 0) await sleep(wait);

    let r;
    try { r = await fetch(TARGET + p, { headers, signal: AbortSignal.timeout(30000) }); }
    catch (e) {
      if (attempt >= 6) throw new Error('network error: ' + e.message);
      await sleep(Math.min(BACKOFF_MS * 2 ** attempt, 60000));
      continue;
    }

    if (r.status === 401) throw new FatalError('Hack The Box rejected the token (HTTP 401). Check HTB_TOKEN; it may have expired or been revoked.');
    if (r.status === 404) { const e = new Error('HTTP 404'); e.status = 404; throw e; }

    if (r.status === 429 || r.status === 403 || r.status >= 500) {
      if (attempt >= 8) throw new Error(`HTTP ${r.status} persisted after ${attempt + 1} attempts`);
      const ra = Number(r.headers.get('retry-after'));
      const w = Math.min(ra > 0 ? ra * 1000 : BACKOFF_MS * 2 ** Math.min(attempt, 5), 60000);
      if (r.status === 429) pauseUntil = Math.max(pauseUntil, Date.now() + w); // every worker waits
      else await sleep(w);
      continue;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);

    try { return await r.json(); }
    catch { if (attempt >= 3) throw new Error('invalid JSON in response'); await sleep(BACKOFF_MS); }
  }
}

async function fetchList(p, retired) {
  let lastCount = 0, expected = null;
  for (let tries = 0; tries < 3; tries++) {
    const out = new Map(); let page = 1, last = 1; expected = null;
    do {
      const j = await htb(`${p}?per_page=100&page=${page}`);
      const items = j.data || [];
      items.forEach(m => out.set(m.id, { ...m, _retired: retired }));
      if (j.meta && typeof j.meta.total === 'number') expected = j.meta.total;
      last = (j.meta && j.meta.last_page) || (j.links && !j.links.next ? page : page + 1);
      if (!items.length) break;
      page++;
    } while (page <= last);
    lastCount = out.size;
    if (expected === null || out.size >= expected) return [...out.values()];
    log(`List ${p}: got ${out.size} of ${expected}, retrying`);
  }
  state.warning = `List ${p} returned ${lastCount} of ${expected} machines announced by the API.`;
  throw new Error(state.warning);
}

// ---------------------------------------------------------------- sync
async function runPool(ids) {
  const queue = ids.slice();
  let sinceSave = 0, fatal = null;
  const worker = async () => {
    while (queue.length && !fatal) {
      const id = queue.shift();
      try {
        const j = await htb('/api/v4/machine/profile/' + encodeURIComponent(id));
        const info = j.info || j.data || j;
        if (info && typeof info === 'object' && info.name) {
          store.cache[id] = info;
          if (++sinceSave >= 25) { sinceSave = 0; persist(); state.version++; }
        } else log(`Profile ${id}: unexpected payload, will retry`);
      } catch (e) {
        if (e instanceof FatalError) { fatal = e; return; }
        if (e.status === 404) { unavailable.add(String(id)); log(`Profile ${id}: 404, marked unavailable`); }
        else log(`Profile ${id}: ${e.message}, will retry`);
      }
      await sleep(REQUEST_GAP_MS);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  persist(); state.version++;
  if (fatal) throw fatal;
}

const missingIds = () => Object.keys(store.list).filter(id => !hasProfile(id) && !unavailable.has(String(id)));

async function fillProfiles() {
  let stalled = 0;
  for (state.round = 1; ; state.round++) {
    const missing = missingIds();
    if (!missing.length) return;
    log(`Round ${state.round}: ${missing.length} profiles missing`);
    await runPool(missing);
    const after = missingIds().length;
    if (after === 0) return;
    if (after >= missing.length) {
      if (++stalled >= 3) throw new Error(`${after} machine profiles could not be loaded yet.`);
    } else stalled = 0;
    await sleep(Math.min(BACKOFF_MS * 2 ** stalled, 30000));
  }
}

async function sync({ full = false } = {}) {
  if (state.running || !TOKEN) return false;
  state.running = true; state.lastError = null; state.warning = null; state.retryAt = null;
  clearTimeout(retryTimer);
  try {
    state.phase = 'list'; state.version++;
    log('Sync started' + (full ? ' (full rebuild)' : ''));
    const active = await fetchList('/api/v4/machine/paginated', false);
    const retired = await fetchList('/api/v4/machine/list/retired/paginated', true);
    const all = active.concat(retired);
    if (!all.length) throw new Error('The API returned an empty machine list.');

    const list = Object.fromEntries(all.map(m => [m.id, m]));
    if (full) store.cache = {};
    for (const id of Object.keys(store.cache)) if (!(id in list)) delete store.cache[id]; // drop stale entries
    store.list = list; unavailable.clear();
    state.lastListSync = new Date().toISOString();
    persist(); state.version++; // progress flags (user/root owns) are visible immediately

    state.phase = 'profiles';
    await fillProfiles();

    state.lastSync = new Date().toISOString();
    log(`Sync complete: ${all.length} machines, all profiles loaded`);
    return true;
  } catch (e) {
    state.lastError = e.message;
    log('Sync failed: ' + e.message);
    if (!(e instanceof FatalError)) {
      state.retryAt = new Date(Date.now() + RETRY_AFTER_FAILURE_MS).toISOString();
      retryTimer = setTimeout(() => sync(), RETRY_AFTER_FAILURE_MS); // keep going until complete
    }
    return false;
  } finally {
    state.running = false; state.phase = 'idle'; state.version++;
  }
}

// ---------------------------------------------------------------- http
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const sameOriginPost = req => req.headers['x-requested-with'] === 'htb-finder'; // forces a CORS preflight for cross-site pages

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/healthz') return json(res, 200, { ok: true });
  if (p === '/status') return json(res, 200, status());

  if (p === '/data' && req.method === 'GET') return json(res, 200, store);

  if (p === '/sync' && req.method === 'POST') {
    if (!sameOriginPost(req)) return json(res, 403, { error: 'forbidden' });
    if (!TOKEN) return json(res, 400, { error: 'HTB_TOKEN is not configured' });
    if (state.running) return json(res, 200, { started: false, reason: 'running' });
    const fresh = state.lastListSync && Date.now() - Date.parse(state.lastListSync) < MIN_SYNC_GAP_MS;
    if (fresh && status().complete && u.searchParams.get('force') !== '1') return json(res, 200, { started: false, reason: 'fresh' });
    sync();
    return json(res, 202, { started: true });
  }

  if (p === '/reset' && req.method === 'POST') {
    if (!sameOriginPost(req)) return json(res, 403, { error: 'forbidden' });
    if (!TOKEN) return json(res, 400, { error: 'HTB_TOKEN is not configured' });
    if (state.running) return json(res, 409, { error: 'a sync is already running' });
    sync({ full: true });
    return json(res, 202, { started: true });
  }

  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (p === '/' || p === '/index.html') {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('public/index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, HOST, () => {
  log(`HTB Machine Finder listening on http://localhost:${PORT}`);
  if (!TOKEN) { log('HTB_TOKEN is not set: serving cached data only, sync is disabled.'); return; }
  sync(); // refresh on boot
  if (SYNC_INTERVAL_MIN > 0) setInterval(() => sync(), SYNC_INTERVAL_MIN * 60000).unref();
});
