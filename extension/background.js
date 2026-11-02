// Service worker: owns recording state and is the only writer of recording data (docs/spec/architecture.md §4, §6).
// All listeners are registered synchronously at top level so webRequest events wake the worker.
import { run, req, deleteSession, deleteAllSessions, DEFAULT_SETTINGS } from './lib/store.js';
import { detect, compilePatterns, readBody, maskRequest, stripQuery, parseRequest, failedEvent } from './lib/parse.js';

const log = (msg, extra) => console.log('[aajr]', msg, extra ?? '');
const IDLE = { active_session_id: null, status: null };

// ---------- cached config (recordingState + settings live in chrome.storage.local) ----------
let cache = null;
function load() {
  cache ??= chrome.storage.local.get(['recordingState', 'settings']).then((r) => {
    const settings = { ...DEFAULT_SETTINGS, ...r.settings };
    return { state: r.recordingState ?? IDLE, settings, patterns: compilePatterns(settings.detection?.custom_patterns) };
  });
  return cache;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch.recordingState || ch.settings)) cache = null;
});

// All writes go through one queue: one writer avoids races on dedup and counters.
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

const notify = (session_id) => chrome.runtime.sendMessage({ type: 'changed', session_id }).catch(() => { /* panel closed */ });

async function bumpHealth(kind, err) {
  const { state } = await load();
  const { health } = await chrome.storage.local.get('health');
  const h = health?.session_id === state.active_session_id ? health : { session_id: state.active_session_id, storage_errors: 0, capture_errors: 0 };
  h[kind] += 1;
  h.last_error = err?.name ?? 'Error';
  await chrome.storage.local.set({ health: h }).catch(() => {});
}
function fail(kind, err) {
  console.error('[aajr]', kind, err?.name, err?.message);
  bumpHealth(kind === 'storage' || err?.name === 'QuotaExceededError' ? 'storage_errors' : 'capture_errors', err).catch(() => {});
}

async function updateSession(id, fn) {
  return run(['sessions'], 'readwrite', async (t) => {
    const s = await req(t.objectStore('sessions').get(id));
    if (!s) return null;
    fn(s);
    t.objectStore('sessions').put(s);
    return s;
  });
}

// ---------- tabs ----------
async function ensureTab(session_id, browser_tab_id, ts) {
  const existing = await run(['tabs'], 'readonly', (t) => req(t.objectStore('tabs').index('session_tab').getAll([session_id, browser_tab_id])));
  const open = existing.find((x) => x.closed_at == null);
  if (open) return open.tab_id;
  let info = null;
  if (browser_tab_id >= 0) { try { info = await chrome.tabs.get(browser_tab_id); } catch { /* tab gone */ } }
  const tab = { tab_id: crypto.randomUUID(), session_id, browser_tab_id, initial_url: info?.url ?? null, current_url: info?.url ?? null, title: info?.title ?? null, created_at: ts, closed_at: null };
  await run(['tabs'], 'readwrite', (t) => { t.objectStore('tabs').add(tab); });
  return tab.tab_id;
}
async function patchOpenTab(browser_tab_id, fn) {
  const { state } = await load();
  if (!state.active_session_id) return;
  await serial(() => run(['tabs'], 'readwrite', async (t) => {
    const rows = await req(t.objectStore('tabs').index('session_tab').getAll([state.active_session_id, browser_tab_id]));
    const open = rows.find((x) => x.closed_at == null);
    if (open) { fn(open); t.objectStore('tabs').put(open); }
  }));
}
chrome.tabs.onRemoved.addListener((id) => { patchOpenTab(id, (t) => { t.closed_at = Date.now(); }).catch((e) => fail('capture', e)); });
chrome.tabs.onUpdated.addListener((id, ch) => {
  if (!ch.title && !ch.url) return;
  patchOpenTab(id, (t) => { if (ch.title) t.title = ch.title; if (ch.url) t.current_url = ch.url; }).catch((e) => fail('capture', e));
});

// ---------- capture ----------
const pending = new Map(); // Chrome requestId → capture_id, for headers and result of a stored request
const DROP_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

async function capture(d) {
  const { state, settings, patterns } = await load();
  const kind = detect(d.url, patterns);
  if (!kind) return;
  const sid = state.active_session_id;
  if (state.status === 'paused') { await serial(() => updateSession(sid, (s) => { s.counters.dropped_paused += 1; })); return; }
  if (state.status !== 'recording') return;
  const capture_id = crypto.randomUUID();
  pending.set(d.requestId, capture_id);
  if (pending.size > 500) pending.delete(pending.keys().next().value);
  await serial(() => store(d, kind, capture_id, sid, settings)).catch((e) => fail('storage', e));
}

async function store(d, kind, capture_id, session_id, settings) {
  const tab_id = await ensureTab(session_id, d.tabId, d.timeStamp);
  const masked = maskRequest({ url: d.url, body: readBody(d.requestBody) }, settings.masking?.rules);
  let events;
  try { events = parseRequest({ url: masked.url, method: d.method, body: masked.body }, kind); } catch (e) {
    log('parse failed', e?.message);
    events = [failedEvent(`decoder error: ${e?.message ?? e}`)];
  }
  const retain = settings.retain_raw !== false;
  const request = {
    capture_id, session_id, tab_id, request_id: d.requestId, dedup_key: `webRequest:${d.requestId}:${d.timeStamp}`, timestamp: d.timeStamp,
    frame_id: d.frameId ?? null, document_id: d.documentId ?? null, url: retain ? masked.url : stripQuery(masked.url),
    method: d.method, request_type: d.type, initiator: d.initiator ?? null, available_headers: null,
    available_body: retain ? masked.body : null, capture_method: 'webRequest', result: null, detected_as: kind,
  };
  const tracking_server = new URL(d.url).host;
  const added = await run(['requests', 'events', 'sessions'], 'readwrite', async (t) => {
    if (await req(t.objectStore('requests').index('dedup_key').getKey(request.dedup_key))) return false;
    const s = await req(t.objectStore('sessions').get(session_id));
    if (!s) return false;
    t.objectStore('requests').add(request);
    events.forEach((e, i) => t.objectStore('events').add({
      ...e, event_id: crypto.randomUUID(), session_id, capture_id, event_index: i, seq: s.counters.events + i, timestamp: d.timeStamp,
      request_method: d.method, tracking_server, tab_id, frame_id: request.frame_id, document_id: request.document_id,
      raw_reference: capture_id, capture_method: 'webRequest',
    }));
    const c = s.counters;
    c.requests += 1;
    c.events += events.length;
    c.parse_partial += events.filter((e) => e.parse_status === 'partial').length;
    c.parse_failed += events.filter((e) => e.parse_status === 'failed').length;
    t.objectStore('sessions').put(s);
    return true;
  });
  if (added) notify(session_id);
}

async function patchRequest(requestId, fn) {
  const id = pending.get(requestId);
  if (!id) return;
  await serial(() => run(['requests'], 'readwrite', async (t) => {
    const r = await req(t.objectStore('requests').get(id));
    if (r) { fn(r); t.objectStore('requests').put(r); }
  }));
}

const ALL = { urls: ['<all_urls>'] };
chrome.webRequest.onBeforeRequest.addListener((d) => { capture(d).catch((e) => fail('capture', e)); }, ALL, ['requestBody']);
chrome.webRequest.onSendHeaders.addListener((d) => {
  if (!pending.has(d.requestId)) return;
  load().then(({ settings }) => {
    if (settings.retain_raw === false) return;
    const headers = (d.requestHeaders ?? []).filter((x) => !DROP_HEADERS.test(x.name)).map(({ name, value }) => ({ name, value: value ?? '' }));
    const ct = headers.find((x) => /^content-type$/i.test(x.name))?.value ?? null;
    return patchRequest(d.requestId, (r) => {
      r.available_headers = headers;
      if (r.available_body && ct) r.available_body.content_type = ct;
    });
  }).catch((e) => fail('capture', e));
}, ALL, ['requestHeaders']);
chrome.webRequest.onCompleted.addListener((d) => {
  if (!pending.has(d.requestId)) return;
  patchRequest(d.requestId, (r) => { r.result = { status_code: d.statusCode }; }).then(() => notify(null)).catch((e) => fail('capture', e)).finally(() => pending.delete(d.requestId));
}, ALL);
chrome.webRequest.onErrorOccurred.addListener((d) => {
  if (!pending.has(d.requestId)) return;
  patchRequest(d.requestId, (r) => { r.result = { error: d.error }; }).then(() => notify(null)).catch((e) => fail('capture', e)).finally(() => pending.delete(d.requestId));
}, ALL);

// ---------- navigations (ADR-0006) ----------
async function navigation(d, kind) {
  if (d.frameId !== 0 || !/^https?:/.test(d.url)) return;
  const { state } = await load();
  if (state.status !== 'recording') return;
  const sid = state.active_session_id;
  await serial(async () => {
    const tab_id = await ensureTab(sid, d.tabId, d.timeStamp);
    await run(['navigations'], 'readwrite', (t) => {
      t.objectStore('navigations').add({
        navigation_id: crypto.randomUUID(), session_id: sid, tab_id, kind, transition_type: kind === 'document' ? d.transitionType ?? null : null,
        document_id: d.documentId ?? null, url: d.url, started_at: d.timeStamp,
      });
    });
  });
  notify(sid);
}
for (const [ev, kind] of [[chrome.webNavigation.onCommitted, 'document'], [chrome.webNavigation.onHistoryStateUpdated, 'history'], [chrome.webNavigation.onReferenceFragmentUpdated, 'fragment']]) {
  ev.addListener((d) => { navigation(d, kind).catch((e) => fail('capture', e)); });
}

// ---------- commands from the side panel ----------
const pad = (n) => String(n).padStart(2, '0');
const defaultName = (d) => `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

async function setState(state) {
  await chrome.storage.local.set({ recordingState: state });
  cache = null;
}
async function stopActive() {
  const { state } = await load();
  if (!state.active_session_id) return;
  const now = Date.now();
  await updateSession(state.active_session_id, (s) => {
    s.status = 'stopped';
    s.stopped_at = now;
    const open = s.pauses.at(-1);
    if (open && open.to == null) open.to = now;
    const j = s.journeys?.at(-1);
    if (j && j.to == null) j.to = now;
  });
  await setState(IDLE);
}

async function command(msg) {
  const { state, settings } = await load();
  const sid = state.active_session_id;
  switch (msg.cmd) {
    case 'start': {
      await stopActive();
      const now = Date.now();
      const s = {
        session_id: crypto.randomUUID(), name: defaultName(new Date(now)), started_at: now, stopped_at: null, status: 'recording',
        configuration_snapshot: { custom_patterns: settings.detection?.custom_patterns ?? [], masking_rules: settings.masking?.rules ?? [], retain_raw: settings.retain_raw !== false },
        counters: { requests: 0, events: 0, parse_partial: 0, parse_failed: 0, storage_errors: 0, dropped_paused: 0, worker_restarts: 0 },
        pauses: [], restarts: [], journeys: [],
      };
      await run(['sessions'], 'readwrite', (t) => { t.objectStore('sessions').add(s); });
      await chrome.storage.local.set({ health: { session_id: s.session_id, storage_errors: 0, capture_errors: 0 } });
      await setState({ active_session_id: s.session_id, status: 'recording' });
      log('recording started');
      return { session_id: s.session_id };
    }
    case 'pause':
    case 'resume': {
      if (!sid) throw new Error('No active recording.');
      const now = Date.now();
      await updateSession(sid, (s) => {
        s.status = msg.cmd === 'pause' ? 'paused' : 'recording';
        if (msg.cmd === 'pause') s.pauses.push({ from: now, to: null });
        else if (s.pauses.at(-1)?.to == null && s.pauses.length) s.pauses.at(-1).to = now;
      });
      await setState({ active_session_id: sid, status: msg.cmd === 'pause' ? 'paused' : 'recording' });
      return {};
    }
    case 'stop':
      await stopActive();
      return {};
    // Journey breakpoint (T-012): toggles a marked span inside the active recording; recording itself continues.
    case 'journey': {
      if (!sid) throw new Error('No active recording.');
      const now = Date.now();
      let started = null;
      await updateSession(sid, (s) => {
        s.journeys ??= [];
        const open = s.journeys.at(-1);
        if (open && open.to == null) { open.to = now; return; }
        started = { journey_id: crypto.randomUUID(), name: `Journey ${s.journeys.length + 1}`, from: now, to: null };
        s.journeys.push(started);
      });
      return { started: started?.journey_id ?? null };
    }
    case 'rename-journey': {
      const name = String(msg.name ?? '').trim().slice(0, 120);
      if (!name) throw new Error('Name is empty.');
      await updateSession(msg.session_id, (s) => { const j = s.journeys?.find((x) => x.journey_id === msg.journey_id); if (j) j.name = name; });
      return {};
    }
    case 'rename': {
      const name = String(msg.name ?? '').trim().slice(0, 200);
      if (!name) throw new Error('Name is empty.');
      await updateSession(msg.session_id, (s) => { s.name = name; });
      return {};
    }
    case 'delete-all':
      if (sid) throw new Error('Stop the recording before deleting all recordings.');
      await deleteAllSessions();
      return {};
    case 'delete':
      if (msg.session_id === sid) throw new Error('Stop the recording before deleting it.');
      await deleteSession(msg.session_id);
      return {};
    default:
      throw new Error(`Unknown command ${msg.cmd}`);
  }
}

// Screenshots (T-013): content.js reports user interactions; capture the visible tab, at most one per 600 ms.
let lastShot = 0;
async function screenshot(tab) {
  const { state, settings } = await load();
  if (state.status !== 'recording' || !settings.screenshots || !tab?.active || Date.now() - lastShot < 600) return;
  lastShot = Date.now();
  const ts = Date.now();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 });
  const blob = await (await fetch(dataUrl)).blob();
  const sid = state.active_session_id;
  await serial(async () => {
    const tab_id = await ensureTab(sid, tab.id, ts);
    await run(['screenshots'], 'readwrite', (t) => { t.objectStore('screenshots').add({ shot_id: crypto.randomUUID(), session_id: sid, tab_id, timestamp: ts, image: blob }); });
  });
  notify(sid);
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Messages from web pages' content scripts may only report interactions, never run commands.
  if (sender.tab) {
    if (msg?.type === 'interaction') screenshot(sender.tab).catch((e) => console.error('[aajr] screenshot', e?.message));
    return false;
  }
  if (!msg?.cmd) return false;
  serial(() => command(msg)).then(
    (r) => { respond({ ok: true, ...r }); notify(msg.session_id ?? r.session_id ?? null); },
    (e) => { console.error('[aajr] command', msg.cmd, e?.message); respond({ ok: false, error: e?.message ?? String(e) }); },
  );
  return true;
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error('[aajr] sidePanel', e?.message));

// Worker start marker: shows restarts as coverage gaps in the Journey (architecture.md §6.6).
load().then(({ state }) => {
  if (!state.active_session_id) return;
  return serial(() => updateSession(state.active_session_id, (s) => { s.restarts.push(Date.now()); s.counters.worker_restarts += 1; }))
    .then(() => notify(state.active_session_id));
}).catch((e) => fail('capture', e));
