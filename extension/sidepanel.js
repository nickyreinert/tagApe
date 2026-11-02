// Side panel: reads recording data from IndexedDB, sends commands to the worker, renders views (docs/spec/ui-ux.md).
// Captured values are untrusted: rendered with textContent only (via h()).
import { listSessions, bySession, countBySession, DEFAULT_SETTINGS } from './lib/store.js';
import { BUILT_IN_PATTERNS } from './lib/parse.js';
import { icon } from './lib/icons.js';
import { parseCurl, fetchNames, adobeName } from './lib/adobe.js';
import { buildReport } from './lib/report.js';
import { OPS, matchesProfile, ruleText, validateRules } from './lib/match.js';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' });
const fmtTime = (ms) => timeFmt.format(ms);
const fmtShort = (ms) => fmtTime(ms).slice(0, 8);
function fmtDur(ms) {
  const a = Math.abs(ms), sign = ms < 0 ? '−' : '+';
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  if (a < 60000) return `${sign}${(a / 1000).toFixed(1)} s`;
  return `${sign}${Math.floor(a / 60000)} min ${Math.round((a % 60000) / 1000)} s`;
}
const clock = (ms) => [3600000, 60000, 1000].map((d, i) => String(Math.floor(ms / d) % (i ? 60 : 100)).padStart(2, '0')).join(':');
const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const plain = (v) => (v && typeof v === 'object' ? v.resolved ?? v.raw : v);
const fileSafe = (s) => s.replace(/\W+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'session';

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r?.ok) throw new Error(r?.error ?? 'The extension did not respond.');
  return r;
}

// ---------- state ----------
const S = {
  rec: { active_session_id: null, status: null }, health: null, permission: false, banner: null,
  settings: structuredClone(DEFAULT_SETTINGS), profiles: [],
  sessions: [], viewedId: lsGet('aajr.viewed'), session: null, events: [], tabs: new Map(), requests: new Map(), navs: [],
  view: lsGet('aajr.view') ?? 'live', settingsOpen: false,
  onlyMatching: true, search: '', warningsOnly: false, pageHost: '', server: '', callType: '', journeyFocus: '', cleared: new Map(), journeyGroup: 'merged',
  editingProfile: null, expanded: null, openGroups: new Set(JSON.parse(lsGet('aajr.groups') ?? '["overview","events","variables"]')),
  autoScroll: true, renaming: null,
};
const NO_TAB = { badge: 'BG', title: 'No tab (background request)' };
const tabOf = (e) => S.tabs.get(e.tab_id) ?? NO_TAB;
const profile = () => S.profiles.find((p) => p.profile_id === S.settings.active_filter_profile_id) ?? null;
const activeSession = () => S.sessions.find((s) => s.session_id === S.rec.active_session_id) ?? null;
const isActiveView = () => S.session && S.session.session_id === S.rec.active_session_id;
const healthNow = () => (S.health && S.health.session_id === S.rec.active_session_id ? S.health : null);
const warnings = () => S.events.filter((e) => e.parse_status !== 'complete').length + (isActiveView() ? (healthNow()?.storage_errors ?? 0) : 0);

async function loadConfig() {
  const r = await chrome.storage.local.get(['recordingState', 'settings', 'filterProfiles', 'health', 'adobeNames']);
  S.rec = r.recordingState ?? { active_session_id: null, status: null };
  S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...r.settings };
  S.profiles = r.filterProfiles ?? [];
  S.health = r.health ?? null;
  S.names = r.adobeNames ?? null;
  S.permission = await chrome.permissions.contains({ origins: ['<all_urls>'] });
}
// Adobe friendly name for a decoded variable (ADR-0010), or null when not loaded / switched off.
const nameOf = (kind, name) => (S.settings.show_names === false ? null : adobeName(S.names, kind, name));
const nameTag = (kind, name) => { const n = nameOf(kind, name); return n ? h('span', { class: 'aname' }, n) : null; };
const saveSettings = (patch) => { Object.assign(S.settings, patch); return chrome.storage.local.set({ settings: S.settings }); };

// Live view state survives panel reloads and browser restarts (T-017); per-viewer convenience, so localStorage.
const VIEW_KEYS = ['onlyMatching', 'search', 'warningsOnly', 'pageHost', 'server', 'callType', 'journeyFocus', 'journeyGroup'];
function saveViewState() {
  lsSet('aajr.viewState', JSON.stringify({
    ...Object.fromEntries(VIEW_KEYS.map((k) => [k, S[k]])),
    cleared: [...S.cleared], collapsed: [...(S.collapsed ?? [])], openPins: [...(S.openPins ?? [])],
  }));
}
function loadViewState() {
  let v;
  try { v = JSON.parse(lsGet('aajr.viewState') ?? 'null'); } catch { v = null; }
  if (!v || typeof v !== 'object') return false;
  for (const k of VIEW_KEYS) if (typeof v[k] === typeof S[k]) S[k] = v[k];
  if (Array.isArray(v.cleared)) S.cleared = new Map(v.cleared.filter((x) => Array.isArray(x) && x.length === 2));
  if (Array.isArray(v.collapsed)) S.collapsed = new Set(v.collapsed);
  if (Array.isArray(v.openPins)) S.openPins = new Set(v.openPins);
  return true;
}

async function loadSessions() {
  S.sessions = (await listSessions()).sort((a, b) => b.started_at - a.started_at);
  if (!S.sessions.some((s) => s.session_id === S.viewedId)) S.viewedId = S.rec.active_session_id ?? S.sessions[0]?.session_id ?? null;
  lsSet('aajr.viewed', S.viewedId);
}

async function sessionData(id) {
  const [events, tabs, requests, navs, shots] = await Promise.all(['events', 'tabs', 'requests', 'navigations', 'screenshots'].map((st) => bySession(st, id)));
  shots.sort((a, b) => a.timestamp - b.timestamp);
  events.sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
  tabs.sort((a, b) => a.created_at - b.created_at);
  let n = 0;
  const tabMap = new Map(tabs.map((t) => [t.tab_id, t.browser_tab_id < 0 ? { ...t, ...NO_TAB } : { ...t, badge: `T${++n}`, title: t.title ?? t.current_url ?? `Tab ${t.browser_tab_id}` }]));
  navs.sort((a, b) => a.started_at - b.started_at);
  return { events, tabs: tabMap, requests: new Map(requests.map((r) => [r.capture_id, r])), navs, shots };
}

// ---------- screenshots (T-013) ----------
const shotUrls = new Map();
const shotUrl = (shot) => { if (!shotUrls.has(shot.shot_id)) shotUrls.set(shot.shot_id, URL.createObjectURL(shot.image)); return shotUrls.get(shot.shot_id); };
// Latest screenshot of the same tab taken at or before the hit.
function shotFor(e) {
  let found = null;
  for (const x of S.shots ?? []) { if (x.timestamp > e.timestamp) break; if (x.tab_id === e.tab_id) found = x; }
  return found;
}
function shotCell(e) {
  const shot = shotFor(e);
  if (!shot) return h('div', { class: 'shot' });
  const img = h('img', { src: shotUrl(shot), alt: `Screenshot ${fmtShort(shot.timestamp)}`, loading: 'lazy' });
  img.addEventListener('mouseenter', () => {
    const p = $('#shot-preview');
    p.replaceChildren(h('img', { src: img.src, alt: '' }), h('span', { class: 'muted' }, `Screenshot ${fmtTime(shot.timestamp)}`));
    p.hidden = false;
    const r = img.getBoundingClientRect();
    p.style.top = `${Math.max(4, Math.min(r.top, innerHeight - p.offsetHeight - 4))}px`;
  });
  img.addEventListener('mouseleave', () => { $('#shot-preview').hidden = true; });
  return h('div', { class: 'shot' }, img);
}

async function loadViewed() {
  S.session = S.sessions.find((s) => s.session_id === S.viewedId) ?? null;
  if (!S.session) { Object.assign(S, { events: [], tabs: new Map(), requests: new Map(), navs: [], shots: [] }); return; }
  Object.assign(S, await sessionData(S.viewedId));
  // Object URLs for screenshot Blobs are cached by shot id and released when they are no longer loaded.
  const ids = new Set(S.shots.map((x) => x.shot_id));
  for (const [id, url] of shotUrls) if (!ids.has(id)) { URL.revokeObjectURL(url); shotUrls.delete(id); }
}

async function viewSession(id, view) {
  S.viewedId = id;
  lsSet('aajr.viewed', id);
  Object.assign(S, { expanded: null, warningsOnly: false, autoScroll: true });
  await loadViewed();
  if (view) setView(view); else renderAll();
}

// ---------- header ----------
let tick;
function renderHeader() {
  const hdr = $('#hdr');
  const active = activeSession();
  const status = S.rec.status ?? 'none';
  const st = { recording: ['● Recording', 'recording'], paused: ['❚❚ Paused', ''], none: ['○ Not recording', ''] }[status];
  const elapsed = h('span', { class: 'mono muted' });
  const updateElapsed = () => { elapsed.textContent = active ? clock(Date.now() - active.started_at) : ''; };
  updateElapsed();
  clearInterval(tick);
  if (active) tick = setInterval(updateElapsed, 1000);

  const btns = [];
  if (status === 'none') btns.push(h('button', { type: 'button', class: 'primary', onclick: startRecording }, 'Start recording'));
  if (status === 'recording') btns.push(h('button', { type: 'button', onclick: () => command({ cmd: 'pause' }) }, 'Pause'));
  if (status === 'paused') btns.push(h('button', { type: 'button', onclick: () => command({ cmd: 'resume' }) }, 'Resume'));
  if (status !== 'none') btns.push(h('button', { type: 'button', onclick: () => command({ cmd: 'stop' }, 'Recording stopped. Data is kept in Sessions.') }, 'Stop'));
  if (status !== 'none') btns.push(h('button', { type: 'button', title: 'Stop this recording and start a new one', onclick: startRecording }, 'New'));
  if (status !== 'none') {
    const open = active?.journeys?.at(-1)?.to === null ? active.journeys.at(-1) : null;
    btns.push(h('button', { type: 'button', class: open ? 'journey-on' : '', 'aria-pressed': String(!!open),
      title: open ? `End ${open.name}; recording continues` : 'Mark the start of a journey; recording continues',
      onclick: () => command({ cmd: 'journey' }, open ? `${open.name} ended.` : 'Journey started.') },
    icon('flag'), open ? ` End ${open.name}` : ' Journey'));
    if (open) btns.push(h('button', { type: 'button', 'aria-label': `Rename ${open.name}`, title: 'Rename journey', onclick: (ev) => renameJourney(ev.currentTarget, active.session_id, open) }, icon('edit')));
  }
  const w = warnings();
  const counts = S.session ? h('span', { class: 'counts' },
    h('span', {}, `${S.events.length} hits · ${S.tabs.size} tabs`),
    w ? h('button', { type: 'button', class: 'warnbtn', 'aria-pressed': String(S.warningsOnly), title: 'Show only hits with decoding warnings', onclick: () => { S.warningsOnly = !S.warningsOnly; setView('live'); } }, icon('warn'), ` ${w}`) : null) : null;

  const viewing = S.session && !isActiveView()
    ? h('div', { class: 'viewing' }, `Viewing: ${S.session.name} (${S.session.status}) `,
      active ? h('button', { type: 'button', class: 'link', onclick: () => viewSession(active.session_id) }, 'Show active recording') : null)
    : null;

  const banners = [];
  if (S.banner) banners.push(S.banner);
  const hl = healthNow();
  if (hl?.storage_errors) banners.push({ text: `Could not save hits (storage full or unavailable). ${hl.storage_errors} hits were dropped. Export and delete old recordings in Sessions.`, action: ['Open Sessions', () => setView('sessions')] });
  if (hl?.capture_errors) banners.push({ text: 'Capture error: some requests may be missing. Details in the extension console.', action: null });
  if (status !== 'none' && !S.permission) banners.push({ text: 'All-sites access was removed: nothing is captured. Recording needs access to all sites, because tracking servers can be on any domain.', action: ['Grant access', requestPermission] });

  hdr.replaceChildren(
    h('div', { class: 'status-line' },
      h('span', { class: 'status ' + st[1], role: 'status' }, st[0]),
      h('span', { class: 'session-name', title: active?.name ?? '' }, active?.name ?? ''),
      elapsed),
    h('div', { class: 'controls' }, btns,
      h('label', { title: 'Screenshot the tab on every click or key press while recording' },
        h('input', { type: 'checkbox', checked: !!S.settings.screenshots, onchange: (e) => saveSettings({ screenshots: e.target.checked }) }), ' Screenshot'),
      counts),
    viewing ?? '',
    ...banners.map((b) => h('div', { class: 'banner error', role: 'alert' }, h('span', {}, b.text),
      b.action ? h('div', { class: 'actions' }, h('button', { type: 'button', onclick: b.action[1] }, b.action[0])) : null)));
}

async function requestPermission() {
  try { S.permission = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch (e) { console.error('[aajr] permission', e?.message); S.permission = false; }
  renderHeader();
  return S.permission;
}
// permissions.request needs the click's user gesture, so it runs before any dialog (ADR-0004).
async function startRecording() {
  S.banner = null;
  if (!(await requestPermission())) {
    S.banner = { text: 'Recording needs access to all sites, because tracking servers can be on any domain.', action: ['Try again', startRecording] };
    renderHeader();
    return;
  }
  const active = activeSession();
  if (active && !(await confirmDialog(`Stop "${active.name}" and start a new recording? Its data is kept.`, 'Start new'))) return;
  try {
    const r = await send({ cmd: 'start' });
    await loadConfig();
    await loadSessions();
    toast('Recording started. Closing the panel does not stop it.');
    await viewSession(r.session_id, 'live');
  } catch (e) { toast(`Could not start: ${e.message}`); }
}
async function command(msg, done) {
  try {
    await send(msg);
    if (done) toast(done);
  } catch (e) { toast(e.message); }
}

// ---------- views ----------
function setView(v) {
  S.view = v;
  lsSet('aajr.view', v);
  S.settingsOpen = false;
  renderAll();
}
function renderTabs() {
  for (const t of $('#tabs').querySelectorAll('[role="tab"]')) {
    const on = !S.settingsOpen && t.dataset.view === S.view;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on || (S.settingsOpen && t.dataset.view === 'live') ? 0 : -1;
  }
  $('#gear').setAttribute('aria-pressed', String(S.settingsOpen));
  $('#views').setAttribute('aria-labelledby', S.settingsOpen ? 'gear' : 'tab-' + S.view);
}
function renderAll() {
  renderHeader();
  renderTabs();
  $('#views').scrollTop = 0;
  ({ live: renderLive, sessions: renderSessions, settings: renderSettings })[S.settingsOpen ? 'settings' : S.view]();
  updateStickyTop();
}
function empty(title, text, ...extra) { return h('div', { class: 'empty' }, h('strong', {}, title), h('span', {}, text), ...extra); }

// Color code (sidepanel.css): left border = source, chips = variable kind. Icons and colors always carry a text alternative.
const SRC = { appmeasurement: 'AppMeasurement', websdk: 'Web SDK', ga4: 'Google Analytics 4', universal: 'Universal Analytics', unknown: 'Unknown format' };
function hitIcon(e) {
  const [name, label] = {
    page_view: ['view', 'Page view'], link_custom: ['click', 'Custom link'], link_download: ['download', 'Download link'], link_exit: ['exit', 'Exit link'],
    websdk_event: ['bolt', e.event_type ?? 'Web SDK event'], ga4_event: ['bolt', e.event_type ?? 'GA4 event'], ga_event: ['bolt', e.event_type ?? 'UA hit'], unknown: ['unknown', e.request_method === 'POST' ? 'Beacon' : 'Unknown hit'],
  }[e.hit_type];
  return h('span', { class: 'hit-icon ht-' + e.hit_type.replace(/_/g, '-'), title: label, 'aria-label': label, role: 'img' }, icon(name, { size: 11, weight: 2.5 }));
}
const chip = (kind, text, title) => h('span', { class: 'chip ' + kind, title }, text);
// Clickable variable chip: opens the popover with Pin (T-005).
const varChip = (kind, name) => h('button', { type: 'button', class: `chip ${kind} chip-btn`, 'aria-haspopup': 'dialog', onclick: (ev) => openPopover(ev.currentTarget, kind, name) }, name);
function countChip(kind, prefix, obj, title) {
  const n = Object.keys(obj ?? {}).length;
  return n ? chip(kind, `${prefix} ${n}`, `${n} ${title}`) : null;
}
// Favorite columns: widths in percent, resizable by dragging the header separators; kept per viewer.
let colW = (() => { try { const w = JSON.parse(lsGet('aajr.cols')); return Array.isArray(w) && w.length === 3 ? w : null; } catch { return null; } })() ?? [50, 20, 30];
const applyColW = () => $('#views').style.setProperty('--cols', colW.map((w) => `minmax(0, ${w}fr)`).join(' '));
applyColW();
// Drag the left edge of a favorite column in any row; boundary b sits between column b-1 and b.
function colResizer(b) {
  const handle = h('span', { class: 'col-resize', title: 'Drag to resize columns', 'aria-hidden': 'true' });
  handle.addEventListener('click', (ev) => ev.stopPropagation());
  handle.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    down.stopPropagation();
    handle.setPointerCapture(down.pointerId);
    const box = handle.closest('.row').getBoundingClientRect();
    const move = (ev) => {
      const left = colW.slice(0, b - 1).reduce((a, w) => a + w, 0);
      const pair = colW[b - 1] + colW[b];
      const x = Math.max(left + 1, Math.min(left + pair - 1, ((ev.clientX - box.left) / box.width) * 100));
      colW[b - 1] = x - left;
      colW[b] = pair - colW[b - 1];
      applyColW();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', () => { handle.removeEventListener('pointermove', move); lsSet('aajr.cols', JSON.stringify(colW)); }, { once: true });
  });
  return handle;
}
// Call type (T-007): Web SDK requests share one endpoint, so the type comes from the payload.
// decisioning = decisioning.* events, or non-page-view events with propositions or a personalization query;
// analytics = page views, link clicks and other events carrying AA data; other = the rest.
const CALL_TYPES = { analytics: ['Analytics tracking'], decisioning: ['Target / decisioning'], other: ['Other (identity, audience, …)'] };
function callType(e) {
  if (e.source === 'appmeasurement' || e.source === 'ga4' || e.source === 'universal') return 'analytics';
  const et = e.event_type ?? '';
  const hasAA = !!e.data?.__adobe?.analytics || Object.keys(e.evars).length > 0 || e.events.length > 0;
  // eventType decides first: sites often attach AA data to every event, including Target notifications.
  if (et.startsWith('decisioning.')) return 'decisioning';
  if (et === 'web.webpagedetails.pageViews' || et.startsWith('web.webinteraction.')) return 'analytics';
  if (e.xdm?._experience?.decisioning || personalizationQuery(e)) return 'decisioning';
  if (hasAA) return 'analytics';
  return 'other';
}
function personalizationQuery(e) {
  const b = S.requests.get(e.capture_id)?.available_body;
  if (!b?.data || b.encoding !== 'utf8') return false;
  try { return !!JSON.parse(b.data)?.query?.personalization; } catch { return false; }
}
// Row title: default page/link name, or the dimension chosen in the title picker (settings.title_field).
const TITLE_FIELDS = ['page_name', 'page_url', 'link_name', 'referrer', 'hit_type', 'tracking_server'];
function titleOf(e) {
  const f = S.settings.title_field;
  if (!f) return { text: (e.hit_type.startsWith('link') || e.source === 'ga4' || e.source === 'universal') && e.link_name ? e.link_name : e.page_name ?? '(no page name)' };
  const i = f.indexOf(':');
  const v = i < 0 ? e[f] : valueOf(e, f.slice(0, i), f.slice(i + 1));
  const label = i < 0 ? f : f.slice(i + 1);
  return v == null || v === '' ? { text: `(${label} not set)`, muted: true } : { text: String(v), label };
}
function eventRow(e, opts = {}) {
  const tab = tabOf(e);
  const t = titleOf(e);
  const open = S.expanded === e.event_id;
  const n = (o) => Object.keys(o ?? {}).length;
  const pill = (kind, count, label) => (count ? chip(kind, String(count), `${count} ${label}`) : null);
  // Columns: hit summary | favorite events | favorite dimensions (only when favorites exist).
  const cols = (S.settings.favorites ?? []).length > 0;
  const shots = (S.shots ?? []).length > 0;
  const ct = callType(e);
  const row = h('div', { class: `row src-${e.source} ct-${ct}` + (cols ? ' cols' : '') + (shots ? ' shots' : '') + (opts.match ? ' match' : '') + (open ? ' open' : ''), 'data-id': e.event_id, title: SRC[e.source],
    onclick: (ev) => { if (!ev.target.closest('.title-btn, .row-main, .chip-btn, .col-resize')) toggleHit(e.event_id); } },
    h('div', { class: 'row-left' },
    h('button', { type: 'button', class: 'row-main meta', 'aria-expanded': String(open), onclick: () => toggleHit(e.event_id) },
      hitIcon(e),
      h('span', { class: 'sr-only' }, CALL_TYPES[ct][0]),
      h('span', { class: 'mono' }, fmtTime(e.timestamp)),
      h('span', { class: 'badge', title: tab.title }, tab.badge),
      h('span', { class: 'sr-only' }, SRC[e.source]),
      e.parse_status !== 'complete' ? h('span', { class: 'pstat ' + e.parse_status, title: e.parse_status }, icon(e.parse_status === 'partial' ? 'warn' : 'fail')) : null,
      opts.match ? h('span', { title: 'Matches filter' }, icon('star', { filled: true })) : null,
      opts.delta != null ? h('span', { class: 'delta' }, fmtDur(opts.delta)) : null),
    h('button', { type: 'button', class: 'title-btn' + (t.muted ? ' muted' : ''), title: 'Choose the dimension shown here', 'aria-haspopup': 'dialog', onclick: (ev) => openTitlePicker(ev.currentTarget) },
      t.label ? h('span', { class: 'title-label' }, t.label) : null, t.text),
    h('span', { class: 'chips' },
      pill('ev', e.events.length, 'events'), pill('evar', n(e.evars), 'eVars'), pill('prop', n(e.props), 'props'),
      pill('list', n(e.list_vars), 'list variables'), pill('hier', n(e.hierarchies), 'hierarchies'),
      e.products.length ? chip('prod', [icon('cart', { size: 11 }), ` ${e.products.length}`], `${e.products.length} products`) : null),
    ),
    cols ? h('div', { class: 'favs' }, colResizer(1), favChips(e, true)) : null,
    cols ? h('div', { class: 'favs' }, colResizer(2), favChips(e, false)) : null,
    shots ? shotCell(e) : null);
  return open ? [row, hitDetail(e)] : row;
}
function openTitlePicker(anchor) {
  const keys = new Set();
  for (const e of S.events) {
    for (const [kind, obj] of [['evar', e.evars], ['prop', e.props], ['list', e.list_vars], ['hier', e.hierarchies]]) for (const k of Object.keys(obj ?? {})) keys.add(`${kind}:${k}`);
  }
  const options = [['', 'Default (page / link name)'], ...TITLE_FIELDS.map((f) => [f, f]),
    ...[...keys].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((k) => { const i = k.indexOf(':'), n = nameOf(k.slice(0, i), k.slice(i + 1)); return [k, n ? `${k.slice(i + 1)} · ${n}` : k.slice(i + 1)]; })];
  const list = h('ul', { class: 'picker-list' });
  const choose = (v) => { closePopover(); saveSettings({ title_field: v || null }).then(rerenderView); };
  const draw = (q) => list.replaceChildren(...options.filter(([, l]) => l.toLowerCase().includes(q.toLowerCase())).slice(0, 80)
    .map(([v, l]) => h('li', {}, h('button', { type: 'button', class: 'link' + ((S.settings.title_field ?? '') === v ? ' current' : ''), onclick: () => choose(v) }, l))));
  const input = h('input', { type: 'search', placeholder: 'Search dimensions', 'aria-label': 'Search dimensions',
    oninput: (ev) => draw(ev.target.value), onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); list.querySelector('button')?.click(); } } });
  draw('');
  showPopover(anchor, [h('strong', {}, 'Show in row title'), input, list]);
  input.focus();
}
function listKeys(ev) {
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  const rows = [...ev.currentTarget.querySelectorAll('.row-main')];
  const i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  ev.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))].focus();
}
function searchHit(e, q) {
  q = q.toLowerCase();
  const vals = [e.page_name, e.link_name, e.page_url, ...e.events.map((x) => x.name), ...Object.values(e.evars).map(plain), ...Object.values(e.props).map(plain)];
  return vals.some((v) => v != null && String(v).toLowerCase().includes(q));
}

// Live
// Page host: from the hit's page URL, else from its tab's URL.
function pageHost(e) {
  for (const u of [e.page_url, tabOf(e).current_url, tabOf(e).initial_url]) {
    try { if (u) return new URL(u).host; } catch { /* not a URL */ }
  }
  return '';
}
// Options are rebuilt with every list render, so hosts of new hits appear.
function fillHostSelects() {
  for (const [id, all, key, vals] of [['page-host', 'All sites', 'pageHost', S.events.map(pageHost)], ['server-host', 'All servers', 'server', S.events.map((e) => e.tracking_server)]]) {
    const sel = $('#' + id);
    if (!sel) continue;
    const opts = [...new Set([...vals, S[key]].filter(Boolean))].sort();
    sel.replaceChildren(h('option', { value: '' }, all), ...opts.map((v) => h('option', { value: v, selected: v === S[key] }, v)));
  }
}
// Trash = clear the view only: hits up to the cutoff stay stored, Live hides them (per session, until the panel closes).
function liveEvents() {
  const cut = S.cleared.get(S.viewedId);
  return cut ? S.events.filter((e) => e.timestamp > cut.timestamp || (e.timestamp === cut.timestamp && e.seq > cut.seq)) : S.events;
}
function clearView() {
  const last = S.events.at(-1);
  if (last) S.cleared.set(S.viewedId, { timestamp: last.timestamp, seq: last.seq });
  renderLiveList();
}
function liveItems() {
  const p = profile();
  return liveEvents()
    .map((e) => ({ e, match: p ? matchesProfile(e, p, tabOf) : false }))
    .filter(({ e, match }) => (!S.warningsOnly || e.parse_status !== 'complete') && (!S.pageHost || pageHost(e) === S.pageHost) && (!S.server || e.tracking_server === S.server) && (!S.callType || callType(e) === S.callType) && inJourneyFocus(e) && (!S.search || searchHit(e, S.search)) && (!p || !S.onlyMatching || match));
}
function clearFilters() {
  Object.assign(S, { search: '', warningsOnly: false, pageHost: '', server: '', callType: '', journeyFocus: '' });
  saveSettings({ active_filter_profile_id: null });
  renderAll();
}
function renderLive() {
  const views = $('#views');
  if (!S.session) {
    views.replaceChildren(empty('Not recording.', 'Press Start recording, then browse as usual. Closing this panel does not stop recording.'));
    return;
  }
  if (!S.events.length) {
    const rec = isActiveView() && S.rec.status === 'recording';
    views.replaceChildren(empty(rec ? 'Waiting for hits…' : 'Empty recording', rec
      ? 'Recording. No analytics requests detected yet. Load a page that uses Adobe Analytics or Google Analytics, or add a custom tracking pattern in Settings.'
      : 'This recording has no hits.'));
    return;
  }
  const sel = h('select', { 'aria-label': 'Filter profile', onchange: (e) => {
    saveSettings({ active_filter_profile_id: e.target.value || null });
    S.onlyMatching = profile()?.show_matching_only ?? true;
    renderLive();
  } }, h('option', { value: '' }, 'No filter'), S.profiles.map((p) => h('option', { value: p.profile_id, selected: p.profile_id === S.settings.active_filter_profile_id }, p.name)));
  const only = h('label', {}, h('input', { type: 'checkbox', checked: S.onlyMatching, disabled: !profile(), onchange: (e) => { S.onlyMatching = e.target.checked; renderLiveList(); } }), ' only matching');
  const search = h('input', { type: 'search', class: 'grow', placeholder: 'Search events, page, values', 'aria-label': 'Search', value: S.search, oninput: (e) => { S.search = e.target.value; renderLiveList(); } });
  const hostSel = (id, label, key) => h('select', { id, 'aria-label': label, onchange: (e) => { S[key] = e.target.value; renderLiveList(); } });
  const pageSel = hostSel('page-host', 'Page host', 'pageHost');
  const serverSel = hostSel('server-host', 'Tracking server', 'server');
  const journeys = S.session?.journeys ?? [];
  const journeySel = journeys.length ? h('select', { 'aria-label': 'Journey focus', onchange: (e) => { S.journeyFocus = e.target.value; renderLiveList(); } },
    h('option', { value: '' }, 'All hits'), h('option', { value: 'any', selected: S.journeyFocus === 'any' }, 'Only journeys'),
    journeys.map((j) => h('option', { value: j.journey_id, selected: S.journeyFocus === j.journey_id }, j.name))) : null;
  const typeSel = h('select', { 'aria-label': 'Call type', onchange: (e) => { S.callType = e.target.value; renderLiveList(); } },
    h('option', { value: '' }, 'All call types'), Object.entries(CALL_TYPES).map(([v, [label]]) => h('option', { value: v, selected: v === S.callType }, label)));
  const seg = h('select', { 'aria-label': 'Group by', onchange: (e) => { S.journeyGroup = e.target.value; renderLiveList(); } },
    [['merged', 'No grouping'], ['journey', 'Group by journey'], ['tab', 'Group by tab'], ['page', 'Group by page']].map(([v, l]) => h('option', { value: v, selected: S.journeyGroup === v }, l)));
  const report = h('button', { type: 'button', 'aria-label': 'Export journey report', title: 'Export an HTML report of the shown hits (current filters and journey focus)', onclick: exportReport }, icon('download'));
  const trash = h('button', { type: 'button', 'aria-label': 'Clear view', title: 'Clear view (hits stay saved in the session)', onclick: clearView }, icon('trash'));
  // Profile select only when profiles exist (T-008); they are managed in Settings.
  const hasProfiles = S.profiles.length > 0;
  views.replaceChildren(h('div', { class: 'toolbar' }, hasProfiles ? sel : null, hasProfiles ? only : null, pageSel, serverSel, typeSel, journeySel, seg, search, report, trash, h('div', { class: 'info', id: 'live-info' }), h('div', { class: 'pinned', id: 'pinned' })), h('div', { id: 'live-list', onkeydown: listKeys }));
  renderLiveList();
}
function renderLiveList() {
  const list = $('#live-list');
  if (!list) return;
  saveViewState();
  fillHostSelects();
  const items = liveItems(), p = profile(), total = liveEvents().length;
  renderPinned(items.map(({ e }) => e));
  const hidden = S.events.length - total;
  const filtered = p || S.search || S.warningsOnly || S.pageHost || S.server || S.callType || S.journeyFocus;
  $('#live-info').replaceChildren(
    h('span', {}, filtered ? `${items.length} of ${total} shown${S.warningsOnly ? ' · warnings only' : ''}` : `${total} hits`,
      hidden ? ` · ${hidden} cleared ` : '',
      hidden ? h('button', { type: 'button', class: 'link', onclick: () => { S.cleared.delete(S.viewedId); renderLiveList(); } }, 'Show all') : ''),
    filtered ? h('button', { type: 'button', class: 'link', onclick: clearFilters }, 'Clear') : '');
  if (!total) {
    list.replaceChildren(h('div', {}, empty('View cleared.', `New hits appear here. ${hidden} earlier hits are still saved in this session.`)));
    return;
  }
  if (!items.length) {
    list.replaceChildren(h('div', {}, empty('No events match.', `${S.events.length} events are hidden by ${p ? `"${p.name}"` : 'the current criteria'}. The recording is unchanged.`,
      h('button', { type: 'button', onclick: clearFilters }, 'Clear filter'))));
    return;
  }
  list.replaceChildren(...groupedLists(liveEntries(items), p && !S.onlyMatching),
    h('div', {}, h('button', { type: 'button', class: 'jump', id: 'jump', hidden: S.autoScroll, onclick: () => { S.autoScroll = true; scrollBottom(); } }, '↓ Jump to latest')));
  if (S.autoScroll) scrollBottom();
}
const scrollBottom = () => { const v = $('#views'); v.scrollTop = v.scrollHeight; };
$('#views').addEventListener('scroll', () => {
  if (S.view !== 'live' || S.settingsOpen) return;
  const v = $('#views');
  S.autoScroll = v.scrollTop + v.clientHeight >= v.scrollHeight - 24;
  $('#jump')?.toggleAttribute('hidden', S.autoScroll);
});

// Rename a journey in the popover (T-014).
function renameJourney(anchor, session_id, j) {
  const input = h('input', { value: j.name, 'aria-label': 'Journey name', maxlength: '120' });
  const save = async () => {
    closePopover();
    await command({ cmd: 'rename-journey', session_id, journey_id: j.journey_id, name: input.value }, 'Journey renamed.');
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
  showPopover(anchor, [h('strong', {}, 'Rename journey'), input,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: save }, 'Save'), h('button', { type: 'button', onclick: closePopover }, 'Cancel'))]);
  input.select();
}
// Journeys (T-012): user-set breakpoints; an open journey runs until now.
const journeyOf = (ts) => (S.session?.journeys ?? []).find((j) => ts >= j.from && (j.to == null || ts <= j.to)) ?? null;
function inJourneyFocus(e) {
  if (!S.journeyFocus) return true;
  // A restored focus may name a journey of another session: ignore it then.
  if (S.journeyFocus !== 'any' && !(S.session?.journeys ?? []).some((x) => x.journey_id === S.journeyFocus)) return true;
  const j = journeyOf(e.timestamp);
  return S.journeyFocus === 'any' ? !!j : j?.journey_id === S.journeyFocus;
}
// Grouping (merged / by tab / by page) with navigation separators and coverage gaps, limited to the shown hits' time span.
function liveEntries(items) {
  if (!items.length) return [];
  const lo = items[0].e.timestamp, hi = items.at(-1).e.timestamp;
  const tabs = new Set(items.map(({ e }) => e.tab_id));
  const s = S.session;
  const inRange = (ts) => ts >= lo && ts <= hi;
  return [
    ...items.map(({ e, match }) => ({ type: 'event', ts: e.timestamp, tab: e.tab_id, e, match })),
    ...S.navs.filter((n) => tabs.has(n.tab_id) && inRange(n.started_at)).map((n) => ({ type: 'nav', ts: n.started_at, tab: n.tab_id, n })),
    ...(s?.pauses ?? []).filter((p) => inRange(p.from)).map((p) => ({ type: 'gap', ts: p.from, g: { kind: 'pause', ts: p.from, to: p.to } })),
    ...(s?.restarts ?? []).filter(inRange).map((ts) => ({ type: 'gap', ts, g: { kind: 'restart', ts } })),
    ...(s?.journeys ?? []).flatMap((j) => [
      inRange(j.from) ? { type: 'mark', ts: j.from, m: { j, edge: 'start' } } : null,
      j.to != null && inRange(j.to) ? { type: 'mark', ts: j.to, m: { j, edge: 'end' } } : null,
    ]).filter(Boolean),
  ].sort((a, b) => a.ts - b.ts);
}
function gapRow(g) {
  return h('li', { class: 'gap' }, g.kind === 'pause'
    ? `❚❚ Paused ${fmtShort(g.ts)}–${g.to ? fmtShort(g.to) : 'now'}${g.to ? ` (${fmtDur(g.to - g.ts).slice(1)})` : ''}. Nothing recorded.`
    : `⟳ Extension restarted at ${fmtShort(g.ts)}. Requests during the restart may be missing.`);
}
const navKind = { document: '⤓ page load', history: '↪ SPA route', fragment: '# fragment' };
function navRow(n) {
  return h('li', { class: 'sep' }, `${(S.tabs.get(n.tab_id) ?? NO_TAB).badge} · ${navKind[n.kind]} · ${hostPath(n.url)}`);
}
// A collapsible group section; collapsed state per group key survives re-renders.
function groupSection(key, title, ...lists) {
  S.collapsed ??= new Set();
  const d = h('details', { class: 'group', open: !S.collapsed.has(key) }, h('summary', { class: 'group-h group-sum' }, title), ...lists);
  d.addEventListener('toggle', () => { if (d.open) S.collapsed.delete(key); else S.collapsed.add(key); saveViewState(); updateStickyTop(); });
  return d;
}
function groupedLists(entries, highlight) {
  const listOf = (items) => {
    let prev = null;
    return h('ol', { class: 'list' }, items.map((x) => {
      if (x.type === 'gap') return gapRow(x.g);
      if (x.type === 'nav') return navRow(x.n);
      if (x.type === 'mark') {
        return h('li', { class: 'jmark' }, icon('flag', { size: 12 }), ` ${x.m.j.name} ${x.m.edge === 'start' ? 'started' : 'ended'} · ${fmtShort(x.m.edge === 'start' ? x.m.j.from : x.m.j.to)} `,
          h('button', { type: 'button', class: 'link', 'aria-label': `Rename ${x.m.j.name}`, title: 'Rename journey', onclick: (ev) => renameJourney(ev.currentTarget, S.viewedId, x.m.j) }, icon('edit', { size: 12 })));
      }
      const d = prev == null ? null : x.ts - prev;
      prev = x.ts;
      return h('li', {}, eventRow(x.e, { delta: d, match: highlight && x.match }));
    }));
  };
  if (S.journeyGroup === 'journey') {
    const out = [];
    let cur = null;
    for (const x of entries.filter((y) => y.type !== 'mark')) {
      const j = x.type === 'event' ? journeyOf(x.ts) : cur?.j ?? null;
      const key = j?.journey_id ?? 'none';
      if (!cur || cur.key !== key) { cur = { key, j, items: [] }; out.push(cur); }
      cur.items.push(x);
    }
    return out.filter((g) => g.items.some((x) => x.type === 'event')).map((g, i) => {
      const n = g.items.filter((x) => x.type === 'event').length;
      const title = g.j ? `${g.j.name} · ${fmtShort(g.j.from)}–${g.j.to ? fmtShort(g.j.to) : 'now'} (${n})` : `Outside journeys (${n})`;
      return groupSection(`journey:${g.key}:${i}`, title, listOf(g.items));
    });
  }
  if (S.journeyGroup === 'tab') {
    const out = [];
    for (const [id, t] of S.tabs) {
      const items = entries.filter((x) => x.tab === id || x.type === 'gap');
      const n = items.filter((x) => x.type === 'event').length;
      if (n) out.push(groupSection(`tab:${id}`, `${t.badge} · ${t.title} (${n})`, listOf(items)));
    }
    return out;
  }
  if (S.journeyGroup === 'page') {
    const groups = [], open = {}, out = [];
    for (const x of entries) {
      if (x.type === 'gap') { groups.push({ gap: x }); continue; }
      if (x.type === 'nav' || !open[x.tab]) {
        const g = { key: x.type === 'nav' ? `nav:${x.n.navigation_id}` : `first:${x.tab}`, head: x.type === 'nav' ? x.n : { tab_id: x.tab, kind: 'unknown', url: x.e.page_url ?? '' }, items: [] };
        groups.push(g);
        open[x.tab] = g;
        if (x.type === 'nav') continue;
      }
      open[x.tab].items.push(x);
    }
    for (const g of groups) {
      if (g.gap) { out.push(h('ol', { class: 'list' }, gapRow(g.gap.g))); continue; }
      if (!g.items.length) continue;
      const kind = { document: 'page load', history: 'SPA route', fragment: 'fragment', unknown: 'before first navigation' }[g.head.kind];
      out.push(groupSection(`page:${g.key}`, `${(S.tabs.get(g.head.tab_id) ?? NO_TAB).badge} · ${kind} · ${hostPath(g.head.url)} (${g.items.length})`, listOf(g.items)));
    }
    return out;
  }
  return [listOf(entries)];
}

// ---------- rule editor (filter profiles) ----------
function rulesEditor(rules, label) {
  const box = h('div', { class: 'rules' });
  const draw = () => box.replaceChildren(
    ...rules.map((r, i) => h('div', { class: 'editor-row', role: 'group', 'aria-label': `${label} rule ${i + 1}` },
      h('input', { list: 'rule-fields', 'aria-label': `${label} rule ${i + 1} field`, value: r.field, oninput: (e) => { r.field = e.target.value.trim(); } }),
      h('select', { 'aria-label': `${label} rule ${i + 1} operator`, onchange: (e) => { r.op = e.target.value; } }, OPS.map((o) => h('option', { selected: o === r.op }, o))),
      h('input', { 'aria-label': `${label} rule ${i + 1} value`, value: r.value ?? '', oninput: (e) => { r.value = e.target.value; } }),
      h('button', { type: 'button', onclick: () => { rules.splice(i, 1); draw(); } }, 'Remove rule'))),
    h('div', {}, h('button', { type: 'button', onclick: () => { rules.push({ field: 'event', op: 'equals', value: '' }); draw(); } }, `+ ${label} rule`)));
  draw();
  return box;
}

// Sessions
async function renderSessions() {
  const views = $('#views');
  if (!S.sessions.length) { views.replaceChildren(empty('No saved recordings.', 'Recordings are stored locally in this browser profile until you delete them.')); return; }
  const usage = h('p', { class: 'muted' }, 'Recordings are kept until you delete them.');
  navigator.storage?.estimate?.().then((est) => { usage.textContent = `Using ${(est.usage / 1048576).toFixed(1)} MB of browser storage. Recordings are kept until you delete them.`; }, () => {});
  const cards = S.sessions.map((s) => {
    const isViewed = s.session_id === S.viewedId, active = s.session_id === S.rec.active_session_id;
    const dur = (s.stopped_at ?? Date.now()) - s.started_at;
    const name = S.renaming === s.session_id
      ? h('form', { onsubmit: async (e) => {
        e.preventDefault();
        S.renaming = null;
        await command({ cmd: 'rename', session_id: s.session_id, name: e.target.elements.n.value });
      } }, h('input', { name: 'n', value: s.name, 'aria-label': 'Recording name', required: true }), ' ', h('button', { type: 'submit' }, 'Save'))
      : h('strong', {}, s.name, isViewed ? ' (shown)' : '');
    const tabsCount = h('span', {}, isViewed ? String(S.tabs.size) : '…');
    if (!isViewed) countBySession('tabs', s.session_id).then((n) => { tabsCount.textContent = String(n); }, () => { tabsCount.textContent = '?'; });
    const status = active ? (S.rec.status === 'paused' ? '❚❚ paused' : '● recording') : '■ stopped';
    return h('li', { class: 'card' }, name,
      h('span', { class: 'muted' }, `${status} · ${new Date(s.started_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} · ${clock(dur)} · ${s.counters.events} hits · `, tabsCount, ' tabs'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => viewSession(s.session_id, 'live') }, 'Open'),
        h('button', { type: 'button', onclick: () => { S.renaming = s.session_id; renderSessions(); $('#views input[name="n"]')?.focus(); } }, 'Rename'),
        h('button', { type: 'button', onclick: () => exportSession(s, 'json') }, 'Export JSON'),
        h('button', { type: 'button', onclick: () => exportSession(s, 'csv') }, 'Export CSV'),
        h('button', { type: 'button', disabled: active, title: active ? 'Stop the recording before deleting it' : null, onclick: () => deleteSessionUi(s) }, 'Delete')));
  });
  views.replaceChildren(h('div', { class: 'view' }, usage, h('ol', { class: 'list' }, cards)));
}
// Journey report (T-015): the hits Live currently shows, as a self-contained HTML timeline.
async function exportReport() {
  const items = liveItems();
  if (!items.length) { toast('No hits to report with the current filters.'); return; }
  const focus = S.journeyFocus === 'any' ? 'all journeys' : (S.session?.journeys ?? []).find((j) => j.journey_id === S.journeyFocus)?.name;
  const filters = [S.pageHost && `site ${S.pageHost}`, S.server && `server ${S.server}`, S.callType && CALL_TYPES[S.callType][0], S.search && `search "${S.search}"`,
    profile() && S.onlyMatching && `profile ${profile().name}`, S.warningsOnly && 'warnings only'].filter(Boolean);
  const entries = liveEntries(items).filter((x) => x.type !== 'gap').map((x) => {
    if (x.type === 'nav') return { type: 'nav', label: `${(S.tabs.get(x.n.tab_id) ?? NO_TAB).badge} · ${navKind[x.n.kind]} · ${hostPath(x.n.url)}` };
    if (x.type === 'mark') return { type: 'mark', label: `${x.m.j.name} ${x.m.edge === 'start' ? 'started' : 'ended'} · ${fmtShort(x.ts)}` };
    return x;
  });
  toast('Building report…');
  try {
    const html = await buildReport({
      title: focus && focus !== 'all journeys' ? `${focus} · ${S.session.name}` : S.session.name,
      subtitle: [`${items.length} hits`, focus ? `journey: ${focus}` : null, filters.length ? `filters: ${filters.join(', ')}` : null,
        `recorded ${new Date(S.session.started_at).toLocaleString()}`, `generated ${new Date().toLocaleString()}`].filter(Boolean).join(' · '),
      entries, tabOf, shotFor, nameOf, callTypeLabel: (e) => CALL_TYPES[callType(e)][0],
    });
    download(html, 'text/html', `aajr-report-${fileSafe(focus && focus !== 'all journeys' ? focus : S.session.name)}-${new Date().toISOString().slice(0, 10)}.html`);
  } catch (e) {
    console.error('[aajr] report', e?.message);
    toast(`Report failed: ${e.message}`);
  }
}
async function deleteAllUi() {
  const hits = S.sessions.reduce((n, s) => n + (s.counters?.events ?? 0), 0);
  if (!(await confirmDialog(`Delete all ${S.sessions.length} recordings with ${hits} hits and their screenshots from this browser? This cannot be undone.`, 'Delete all'))) return;
  try {
    await send({ cmd: 'delete-all' });
    S.cleared.clear();
    toast('All recordings deleted.');
    await refresh();
  } catch (e) { toast(`Could not delete: ${e.message}`); }
}
async function deleteSessionUi(s) {
  if (!(await confirmDialog(`Delete "${s.name}"? ${s.counters.events} hits are removed from this browser. This cannot be undone.`, 'Delete'))) return;
  try {
    await send({ cmd: 'delete', session_id: s.session_id });
    toast(`Deleted "${s.name}".`);
    await refresh();
  } catch (e) { toast(`Could not delete: ${e.message}`); }
}
function download(text, type, name) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// Export contracts: data-model.md §8.
async function exportSession(s, fmt) {
  const d = s.session_id === S.viewedId ? S : await sessionData(s.session_id);
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  const base = `aajr-session-${fileSafe(s.name)}-${new Date(s.started_at).toISOString().slice(0, 10)}`;
  if (fmt === 'json') {
    const strip = ({ badge, ...t }) => t;
    download(JSON.stringify({
      format: 'aajr-session', format_version: 1, exported_at: iso(Date.now()),
      session: s, tabs: [...d.tabs.values()].map(strip), navigations: d.navs, requests: [...d.requests.values()], events: d.events,
    }, null, 2), 'application/json', `${base}.json`);
    return;
  }
  const cell = (v) => {
    let t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const cols = ['timestamp_iso', 'tab', 'source', 'hit_type', 'rsid', 'measurement_id', 'page_name', 'page_url', 'link_name', 'events', 'evars', 'props', 'products', 'parse_status', 'capture_id'];
  const rows = d.events.map((e) => [iso(e.timestamp), (d.tabs.get(e.tab_id) ?? NO_TAB).badge, e.source, e.hit_type, (e.rsid ?? []).join(','), e.measurement_id, e.page_name, e.page_url, e.link_name,
    e.events.map((x) => x.name).join(','), e.evars, e.props, e.products.map((p) => p.raw), e.parse_status, e.capture_id].map(cell).join(','));
  download('﻿' + [cols.join(','), ...rows].join('\r\n'), 'text/csv', `${base}.csv`);
}

// Settings
const saveProfiles = () => chrome.storage.local.set({ filterProfiles: S.profiles });
function lineErrors(text, check) {
  const lines = text.split('\n').map((l, i) => [l.trim(), i + 1]).filter(([l]) => l);
  const bad = lines.find(([l]) => !check(l));
  return { values: lines.map(([l]) => l), bad: bad?.[1] ?? null };
}
function renderSettings() {
  if (S.editingProfile) { renderProfileEditor(); return; }
  const st = S.settings;
  const err = h('span', { class: 'error', role: 'alert' });
  const custom = h('textarea', { id: 'custom', 'aria-describedby': 'custom-help' }, st.detection.custom_patterns.join('\n'));
  const masking = h('textarea', { id: 'masking', 'aria-describedby': 'masking-help', placeholder: 'eVar12\nemail\nxdm.identityMap.*' }, st.masking.rules.join('\n'));
  const raw = h('input', { type: 'checkbox', checked: st.retain_raw });
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Import configuration file', onchange: (e) => importConfig(e.target.files[0]) });
  $('#views').replaceChildren(h('form', { class: 'view', onsubmit: async (e) => {
    e.preventDefault();
    const c = lineErrors(custom.value, (l) => { try { new URLPattern(l); return true; } catch { return false; } });
    if (c.bad) { err.textContent = `Pattern line ${c.bad} is not a valid URL pattern, e.g. https://*.example.com/collect*`; custom.focus(); return; }
    const m = lineErrors(masking.value, (l) => /^[\w.*[\]-]+$/.test(l));
    if (m.bad) { err.textContent = `Masking line ${m.bad}: use a parameter name or dotted path, * as wildcard.`; masking.focus(); return; }
    err.textContent = '';
    await saveSettings({ detection: { custom_patterns: c.values }, masking: { rules: m.values }, retain_raw: raw.checked });
    toast('Settings saved. They apply to new hits.');
  } },
  h('h3', {}, 'Detection'),
  h('ul', {}, BUILT_IN_PATTERNS.map((p) => h('li', {}, h('code', {}, p.pattern), ' ', p.source))),
  h('div', { class: 'field' }, h('label', { for: 'custom' }, 'Custom tracking URL patterns'), custom, h('small', { id: 'custom-help' }, 'One URL pattern per line. Matching requests are kept even if they cannot be decoded.')),
  h('h3', {}, 'Privacy'),
  h('label', { class: 'field' }, h('span', {}, raw, ' Keep raw requests (URL query, headers, body)')),
  h('div', { class: 'field' }, h('label', { for: 'masking' }, 'Mask these variables'), masking, h('small', { id: 'masking-help' }, 'One name or path per line. Values are replaced by [masked] before saving and cannot be restored. Empty by default.')),
  err,
  h('div', { class: 'controls' }, h('button', { type: 'submit', class: 'primary' }, 'Save settings')),
  h('h3', {}, 'Permissions'),
  h('p', {}, S.permission ? 'All-sites access: granted.' : 'All-sites access: not granted yet. Chrome asks when you start a recording.'),
  h('h3', {}, 'Filter profiles'),
  S.profiles.length ? h('ul', {}, S.profiles.map((p) => h('li', {}, h('strong', {}, p.name), ' ',
    h('button', { type: 'button', class: 'link', onclick: () => { S.editingProfile = structuredClone(p); renderSettings(); } }, 'Edit'), h('br'),
    h('span', { class: 'muted mono' }, `include any: ${p.include_rules.map(ruleText).join('; ') || 'all'}${p.exclude_rules.length ? ` · exclude: ${p.exclude_rules.map(ruleText).join('; ')}` : ''}`)))) : h('p', { class: 'muted' }, 'No filter profiles yet.'),
  h('p', {}, h('button', { type: 'button', onclick: () => { S.editingProfile = { profile_id: crypto.randomUUID(), name: 'New profile', include_rules: [{ field: 'event', op: 'equals', value: '' }], exclude_rules: [], show_matching_only: true, created_at: Date.now(), updated_at: Date.now() }; renderSettings(); } }, '+ New filter profile')),
  h('h3', {}, 'Adobe names'),
  adobeSection(),
  h('h3', {}, 'Recordings'),
  h('p', {}, h('button', { type: 'button', disabled: !!S.rec.active_session_id, title: S.rec.active_session_id ? 'Stop the recording first' : null, onclick: deleteAllUi }, 'Delete all recordings')),
  h('h3', {}, 'Import / export'),
  h('p', { class: 'muted' }, 'Settings and filter profiles as one JSON file. Import replaces items with the same id.'),
  h('div', { class: 'controls' }, h('button', { type: 'button', onclick: exportConfig }, 'Export configuration'), importInput)));
}
// Settings → Adobe names (ADR-0010). Network calls happen only on Load / Reload.
function adobeSection() {
  const box = h('div', { class: 'field' });
  const status = h('p', { class: 'muted', role: 'status' });
  const describe = () => {
    status.textContent = S.names
      ? `${Object.keys(S.names.dims).length} dimensions, ${Object.keys(S.names.metrics).length} metrics from ${S.names.rsid}, loaded ${new Date(S.names.fetched_at).toLocaleString()}.`
      : 'No names loaded.';
  };
  const curl = h('textarea', { id: 'adobe-curl', 'aria-describedby': 'adobe-help', placeholder: 'curl -H "Authorization: Bearer …" … https://…/reports/ranked' });
  const load = async (auth) => {
    status.textContent = 'Loading names from Adobe…';
    try {
      const names = await fetchNames(auth);
      await chrome.storage.local.set({ adobeNames: names });
      S.names = names;
      describe();
      toast('Adobe names loaded.');
    } catch (e) {
      console.error('[aajr] adobe names', e?.message);
      status.textContent = `Could not load names: ${e.message}`;
    }
  };
  const apiKey = h('input', { id: 'adobe-key', 'aria-describedby': 'adobe-key-help', autocomplete: 'off', placeholder: 'optional' });
  const show = h('input', { type: 'checkbox', checked: S.settings.show_names !== false, onchange: (e) => saveSettings({ show_names: e.target.checked }) });
  describe();
  box.append(
    h('label', { for: 'adobe-curl' }, 'Paste a Workspace request as cURL'), curl,
    h('small', { id: 'adobe-help' }, 'From Workspace: DevTools → Network → a reports request → Copy as cURL. The token is kept only until the browser closes; only the names are stored.'),
    h('label', { for: 'adobe-key' }, 'Developer Console client id (x-api-key)'), apiKey,
    h('small', { id: 'adobe-key-help' }, 'Only for analytics.adobe.io; the token must come from the same Console project.'),
    h('div', { class: 'controls' },
      h('button', { type: 'button', class: 'primary', onclick: async () => {
        let auth;
        try { auth = parseCurl(curl.value); } catch (e) { status.textContent = e.message; return; }
        auth.apiKey = apiKey.value.trim() || null;
        curl.value = '';
        apiKey.value = '';
        await chrome.storage.session.set({ adobeAuth: auth });
        await load(auth);
      } }, 'Load names'),
      h('button', { type: 'button', onclick: async () => {
        const { adobeAuth } = await chrome.storage.session.get('adobeAuth');
        if (!adobeAuth) { status.textContent = 'No token in this browser session. Paste the curl again.'; return; }
        await load(adobeAuth);
      } }, 'Reload'),
      h('button', { type: 'button', onclick: async () => { await chrome.storage.session.remove('adobeAuth'); toast('Token forgotten.'); } }, 'Forget token'),
      h('button', { type: 'button', onclick: async () => { await chrome.storage.local.remove('adobeNames'); S.names = null; describe(); } }, 'Delete names')),
    h('label', {}, show, ' Show Adobe names next to variables'),
    status);
  return box;
}
function renderProfileEditor() {
  const p = S.editingProfile;
  const err = h('p', { class: 'error', role: 'alert' });
  const exists = S.profiles.some((x) => x.profile_id === p.profile_id);
  $('#views').replaceChildren(h('div', { class: 'view' },
    h('label', { class: 'field' }, 'Profile name', h('input', { value: p.name, oninput: (e) => { p.name = e.target.value; } })),
    h('h3', {}, 'Include (any rule matches; none = all)'), rulesEditor(p.include_rules, 'Include'),
    h('h3', {}, 'Exclude (any rule matches removes the hit)'), rulesEditor(p.exclude_rules, 'Exclude'),
    h('label', { class: 'field' }, h('span', {}, h('input', { type: 'checkbox', checked: p.show_matching_only, onchange: (e) => { p.show_matching_only = e.target.checked; } }), ' Show matching only (off = highlight)')),
    err,
    h('div', { class: 'controls' },
      h('button', { type: 'button', class: 'primary', onclick: async () => {
        const msg = validateRules(p.include_rules) ?? validateRules(p.exclude_rules);
        if (msg) { err.textContent = msg; return; }
        p.name = p.name.trim() || 'Untitled profile';
        p.updated_at = Date.now();
        const i = S.profiles.findIndex((x) => x.profile_id === p.profile_id);
        if (i < 0) S.profiles.push(p); else S.profiles[i] = p;
        S.editingProfile = null;
        await saveProfiles();
        toast('Filter profile saved.');
        renderSettings();
      } }, 'Save'),
      h('button', { type: 'button', onclick: () => { S.editingProfile = null; renderSettings(); } }, 'Cancel'),
      exists ? h('button', { type: 'button', onclick: async () => {
        if (!(await confirmDialog(`Delete filter profile "${p.name}"? Recordings are not affected.`, 'Delete'))) return;
        S.profiles = S.profiles.filter((x) => x.profile_id !== p.profile_id);
        if (S.settings.active_filter_profile_id === p.profile_id) await saveSettings({ active_filter_profile_id: null });
        S.editingProfile = null;
        await saveProfiles();
        renderSettings();
      } }, 'Delete profile') : null)));
}
function exportConfig() {
  download(JSON.stringify({ format: 'aajr-config', format_version: 1, exported_at: new Date().toISOString(), settings: S.settings, filterProfiles: S.profiles }, null, 2),
    'application/json', 'aajr-config.json');
}
// Imported JSON is untrusted: validate shape and rules before saving.
async function importConfig(file) {
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (j?.format !== 'aajr-config') throw new Error('not an aajr-config file');
    const isRules = (r) => Array.isArray(r) && r.every((x) => x && typeof x === 'object') && !validateRules(r);
    const profiles = (j.filterProfiles ?? []).filter((p) => typeof p?.profile_id === 'string' && typeof p.name === 'string' && isRules(p.include_rules) && isRules(p.exclude_rules))
      .map((p) => ({ profile_id: p.profile_id, name: p.name, include_rules: p.include_rules, exclude_rules: p.exclude_rules, show_matching_only: p.show_matching_only !== false, created_at: Number(p.created_at) || Date.now(), updated_at: Date.now() }));
    const merge = (list, items, key) => { for (const it of items) { const i = list.findIndex((x) => x[key] === it[key]); if (i < 0) list.push(it); else list[i] = it; } };
    merge(S.profiles, profiles, 'profile_id');
    const s = j.settings ?? {};
    const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    await saveSettings({
      detection: { custom_patterns: strings(s.detection?.custom_patterns).filter((p) => { try { new URLPattern(p); return true; } catch { return false; } }) },
      masking: { rules: strings(s.masking?.rules).filter((l) => /^[\w.*[\]-]+$/.test(l)) },
      retain_raw: s.retain_raw !== false,
    });
    await chrome.storage.local.set({ filterProfiles: S.profiles });
    toast(`Imported ${profiles.length} filter profiles.`);
    renderSettings();
  } catch (e) { toast(`Import failed: ${e.message}`); }
}

// ---------- variable popover and pinned variables ----------
const KIND_LABEL = { ev: 'Event', evar: 'eVar', prop: 'Prop', list: 'List variable', hier: 'Hierarchy' };
const pinKey = (kind, name) => `${kind}:${name}`;
function valueOf(e, kind, name) {
  if (kind === 'ev') { const x = e.events.find((y) => y.name === name); return x ? x.value ?? '✓' : undefined; }
  const v = { evar: e.evars, prop: e.props, list: e.list_vars, hier: e.hierarchies }[kind]?.[name];
  return v === undefined ? undefined : String(plain(v) ?? '');
}
// One entry per value change, oldest first; hits without the variable are skipped.
function changes(events, kind, name) {
  const out = [];
  for (const e of events) {
    const v = valueOf(e, kind, name);
    if (v === undefined) continue;
    if (out.length && out.at(-1).v === v) out.at(-1).n += 1;
    else out.push({ v, ts: e.timestamp, n: 1 });
  }
  return out;
}
// Favorites: name=value chip on every hit row that sets it (T-006); other variables only appear as count pills.
function favChips(e, events) {
  return (S.settings.favorites ?? []).filter((key) => key.startsWith('ev:') === events).map((key) => {
    const i = key.indexOf(':'), kind = key.slice(0, i), name = key.slice(i + 1);
    const v = valueOf(e, kind, name);
    if (v === undefined) return null;
    return h('span', { class: 'fav-line' },
      h('button', { type: 'button', class: `chip ${kind} chip-btn`, title: `${nameOf(kind, name) ?? name}: ${v}`, 'aria-haspopup': 'dialog', onclick: (ev) => openPopover(ev.currentTarget, kind, name) }, name),
      nameTag(kind, name),
      h('span', { class: 'fav-val' }, ` = ${v.length > 80 ? v.slice(0, 79) + '…' : v}`));
  });
}
async function toggleFav(kind, name) {
  const key = pinKey(kind, name);
  const favs = S.settings.favorites ?? [];
  await saveSettings({ favorites: favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key] });
  rerenderView();
}
async function togglePin(kind, name) {
  const key = pinKey(kind, name);
  const pinned = S.settings.pinned ?? [];
  await saveSettings({ pinned: pinned.includes(key) ? pinned.filter((k) => k !== key) : [...pinned, key] });
  if (S.view === 'live') renderLiveList();
}
function closePopover() {
  const pop = $('#popover');
  if (pop.hidden) return;
  pop.hidden = true;
  S.popAnchor?.focus();
  S.popAnchor = null;
}
function openPopover(anchor, kind, name) {
  const pop = $('#popover');
  const pinned = (S.settings.pinned ?? []).includes(pinKey(kind, name));
  const fav = (S.settings.favorites ?? []).includes(pinKey(kind, name));
  pop.replaceChildren(
    h('div', {}, chip(kind, name), ' ', h('span', { class: 'muted' }, nameOf(kind, name) ?? KIND_LABEL[kind])),
    h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => { closePopover(); togglePin(kind, name).then(() => toast(pinned ? `${name} unpinned.` : `${name} pinned to the top of Live.`)); } }, icon('pin'), pinned ? ' Unpin' : ' Pin'),
      h('button', { type: 'button', onclick: () => { closePopover(); toggleFav(kind, name).then(() => toast(fav ? `${name} removed from favorites.` : `${name} now shown on every hit.`)); } }, icon('star', { filled: fav }), fav ? ' Unfav' : ' Fav'),
      h('button', { type: 'button', 'aria-label': 'Close', onclick: closePopover }, icon('close'))));
  showPopover(anchor);
  pop.querySelector('button').focus();
}
function showPopover(anchor, content) {
  const pop = $('#popover');
  if (content) pop.replaceChildren(...content);
  const frame = $('#panel').getBoundingClientRect(), r = anchor.getBoundingClientRect();
  pop.hidden = false;
  pop.style.top = `${r.bottom - frame.top + 4}px`;
  pop.style.left = `${Math.max(4, Math.min(r.left - frame.left, frame.width - pop.offsetWidth - 4))}px`;
  S.popAnchor = anchor;
}
document.addEventListener('click', (ev) => {
  if (!$('#popover').hidden && !ev.target.closest('#popover, .chip-btn, .title-btn, [title="Rename journey"]')) closePopover();
});
function renderPinned(events) {
  const box = $('#pinned');
  if (!box) return;
  const keys = S.settings.pinned ?? [];
  const pinNode = (key) => {
    const i = key.indexOf(':'), kind = key.slice(0, i), name = key.slice(i + 1);
    const ch = changes(events, kind, name);
    const last = ch.at(-1);
    const d = h('details', { class: 'pin', open: S.openPins?.has(key) },
      h('summary', { class: 'pin-sum', title: `${nameOf(kind, name) ?? name}: ${last ? last.v : 'not seen'}${ch.length > 1 ? ` (${ch.length} values)` : ''}` },
        chip(kind, name), nameTag(kind, name), ' ',
        h('span', { class: 'pin-val' }, last ? last.v : h('span', { class: 'muted' }, 'not seen')),
        ch.length > 1 ? h('span', { class: 'muted' }, ` · ${ch.length} values`) : '',
        h('button', { type: 'button', class: 'link pin-x', 'aria-label': `Unpin ${name}`, onclick: (ev) => { ev.preventDefault(); togglePin(kind, name); } }, icon('close', { size: 12 }))),
      ch.length ? h('ol', { class: 'pin-hist' }, [...ch].reverse().map((c) => h('li', {}, h('span', { class: 'mono muted' }, fmtShort(c.ts)), ' ', c.v || h('span', { class: 'muted' }, '(empty)'), c.n > 1 ? h('span', { class: 'muted' }, ` ×${c.n}`) : ''))) : h('p', { class: 'muted' }, 'Not set in the shown hits.'));
    d.addEventListener('toggle', () => { S.openPins ??= new Set(); if (d.open) S.openPins.add(key); else S.openPins.delete(key); saveViewState(); updateStickyTop(); });
    return d;
  };
  // With favorite columns (T-010): pinned events sit above the fav-events column, pinned dimensions above fav dimensions.
  const cols = (S.settings.favorites ?? []).length > 0 && keys.length > 0;
  box.classList.toggle('cols', cols);
  if (cols) {
    box.replaceChildren(
      h('div', { class: 'pin-label muted' }, 'Pinned'),
      h('div', { class: 'pin-col' }, keys.filter((k) => k.startsWith('ev:')).map(pinNode)),
      h('div', { class: 'pin-col' }, keys.filter((k) => !k.startsWith('ev:')).map(pinNode)),
      (S.shots ?? []).length ? h('div', {}) : null);
    box.classList.toggle('shots', (S.shots ?? []).length > 0);
  } else box.replaceChildren(...keys.map(pinNode));
  updateStickyTop();
}

// ---------- hit detail (expands inline under its row; groups are <details>) ----------
// The expanded row sticks below the (sticky) toolbar while its details scroll by.
function updateStickyTop() {
  const v = $('#views');
  v.style.setProperty('--sticky-top', `${$('#views > .toolbar')?.offsetHeight ?? 0}px`);
}
new ResizeObserver(updateStickyTop).observe(document.body);
function rerenderView() {
  if (S.view === 'live') renderLiveList();
}
function focusRow(id) { $(`#views .row[data-id="${CSS.escape(id)}"] .row-main`)?.focus(); }
function toggleHit(id) {
  S.expanded = S.expanded === id ? null : id;
  if (S.expanded) S.autoScroll = false;
  rerenderView();
  updateStickyTop();
  focusRow(id);
}
function longText(v) {
  v = String(v);
  if (v.length <= 200) return h('span', {}, v);
  const span = h('span', {}, v.slice(0, 200) + '… ');
  span.append(h('button', { type: 'button', class: 'link', onclick: (e) => { span.textContent = v; e.stopPropagation(); } }, 'Show all'));
  return span;
}
function valueNode(v) {
  if (v && typeof v === 'object' && 'raw' in v) {
    return h('span', {}, h('code', {}, v.raw), ' → ',
      v.resolved != null ? [longText(v.resolved), h('span', { class: 'ref' }, ` (from ${v.ref})`)] : h('span', { class: 'unresolved' }, `not in hit (${v.ref} set server-side or missing)`));
  }
  if (v && typeof v === 'object') return h('code', {}, JSON.stringify(v));
  if (v === '') return h('span', { class: 'muted' }, '(empty)');
  return longText(v);
}
const sortKeys = (o) => Object.keys(o).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
function kv(obj, emptyText, kind, pinnable = true) {
  const keys = sortKeys(obj ?? {});
  if (!keys.length) return h('p', { class: 'muted' }, emptyText);
  return h('dl', { class: 'kv' }, keys.map((k) => [h('dt', {}, kind ? (pinnable ? varChip(kind, k) : chip(kind, k)) : k, kind && pinnable ? nameTag(kind, k) : null), h('dd', {}, Array.isArray(obj[k]) && obj[k].every((x) => typeof x !== 'object') ? obj[k].join(' | ') : valueNode(obj[k]))]));
}
function hitDetail(e) {
  const r = S.requests.get(e.capture_id);
  const tab = tabOf(e);
  const copy = (txt, what) => h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(txt).then(() => toast(`${what} copied.`), () => toast('Copy failed: clipboard not available.')) }, `Copy ${what}`);
  const na = (v) => v ?? h('span', { class: 'muted' }, 'not in hit');
  const row = ([k, v]) => [h('dt', {}, k), h('dd', {}, v)];
  const group = (key, label, ...content) => {
    const d = h('details', { class: 'grp', open: S.openGroups.has(key) }, h('summary', {}, label), ...content);
    d.addEventListener('toggle', () => { if (d.open) S.openGroups.add(key); else S.openGroups.delete(key); lsSet('aajr.groups', JSON.stringify([...S.openGroups])); });
    return d;
  };
  const notice = e.parse_status !== 'complete'
    ? h('div', { class: 'notice ' + e.parse_status, role: 'note' }, h('strong', {}, icon(e.parse_status === 'partial' ? 'warn' : 'fail'), e.parse_status === 'partial' ? ' Partially decoded' : ' Not decoded'), h('ul', {}, e.parse_messages.map((m) => h('li', {}, m))))
    : null;
  const n = (o) => Object.keys(o ?? {}).length;
  const groups = [
    group('overview', 'Overview', h('dl', { class: 'kv' }, [
      ['Time', `${fmtTime(e.timestamp)} (${new Date(e.timestamp).toISOString()})`], ['Source', SRC[e.source]], ['Method', `${e.request_method} · ${r?.request_type ?? '?'}`],
      ['Hit type', e.event_type ? `${e.hit_type} (${e.event_type})` : e.hit_type],
      ['Call type', CALL_TYPES[callType(e)][0]],
      e.source === 'websdk' ? ['Datastream', na(e.datastream_id)] : e.source === 'ga4' || e.source === 'universal' ? ['Measurement ID', na(e.measurement_id)] : ['RSID', e.rsid ? e.rsid.join(', ') : na(null)],
      ['Server', e.tracking_server], ['Page name', na(e.page_name)], ['Page URL', e.page_url ? longText(e.page_url) : na(null)],
      ['Referrer', e.referrer ? longText(e.referrer) : na(null)], e.link_name ? ['Link name', e.link_name] : null,
      ['Tab', `${tab.badge} · ${tab.title}`], ['Parse status', e.parse_status],
    ].filter(Boolean).map(row)), h('p', {}, copy(JSON.stringify(e, null, 2), 'JSON'))),
    group('events', `Events (${e.events.length})`, e.events.length ? h('dl', { class: 'kv' }, e.events.map((x) => [h('dt', {}, varChip('ev', x.name), nameTag('ev', x.name)), h('dd', {}, x.value != null ? `value ${x.value}` : '', x.serial != null ? ` serial ${x.serial}` : '', x.value == null && x.serial == null ? h('span', { class: 'muted' }, 'counter') : '')])) : h('p', { class: 'muted' }, 'No events in this hit.')),
    group('variables', `Variables (${n(e.evars) + n(e.props) + n(e.list_vars) + n(e.hierarchies)})`,
      h('h3', {}, `eVars (${n(e.evars)})`), kv(e.evars, 'No eVars.', 'evar'),
      h('h3', {}, `Props (${n(e.props)})`), kv(e.props, 'No props.', 'prop'),
      n(e.list_vars) ? [h('h3', {}, 'List variables'), kv(e.list_vars, 'None.', 'list')] : null,
      n(e.hierarchies) ? [h('h3', {}, 'Hierarchies'), kv(e.hierarchies, 'None.', 'hier')] : null),
    n(e.context_data) ? group('context', `Context data (${n(e.context_data)})`, kv(e.context_data, 'None.')) : null,
    group('products', `Products (${e.products.length})`, e.products.length ? e.products.map((p, j) => h('div', { class: 'card' },
      h('strong', {}, `${j + 1}. ${p.product ?? '(no product id)'}`),
      h('dl', { class: 'kv' }, [['Category', na(p.category)], ['Quantity', na(p.quantity)], ['Price', na(p.price)]].map(row)),
      n(p.events) ? [h('h3', {}, 'Product events'), kv(p.events, 'None.', 'ev', false)] : null,
      n(p.evars) ? [h('h3', {}, 'Merchandising eVars'), kv(p.evars, 'None.', 'evar', false)] : null,
      h('pre', { class: 'wrap' }, p.raw))) : h('p', { class: 'muted' }, e.source === 'websdk' && e.xdm?.productListItems ? 'No AA products string. XDM productListItems are in XDM (not merged).' : 'No products in this hit.')),
    group('ids', `Visitor IDs & other (${n(e.visitor_ids) + n(e.other_params)})`,
      h('h3', {}, 'Visitor IDs'), kv(e.visitor_ids, 'None in this hit.'), h('h3', {}, 'Other parameters'), kv(e.other_params, 'None.')),
    e.xdm ? group('xdm', 'XDM', h('p', { class: 'muted' }, 'Original XDM, not merged into Analytics variables (mapping happens in the datastream).'), h('pre', {}, JSON.stringify(e.xdm, null, 2))) : null,
    group('raw', 'Raw request', rawRequest(r, copy, row)),
  ];
  return h('div', { class: 'hit-detail', role: 'region', 'aria-label': 'Hit details' }, notice, groups);
}
function rawRequest(r, copy, row) {
  if (!r) return h('p', { class: 'muted' }, 'Raw request not found.');
  let search = [];
  try { search = [...new URL(r.url).searchParams]; } catch { /* keep empty */ }
  const result = r.result ? (r.result.status_code != null ? String(r.result.status_code) : r.result.error) : 'not observed';
  const b = r.available_body;
  const bodyText = () => { if (b.encoding === 'base64') return `(binary, base64) ${b.data}`; try { return JSON.stringify(JSON.parse(b.data), null, 2); } catch { return b.data; } };
  return [h('dl', { class: 'kv' }, [['Method', r.method], ['Type', r.request_type], ['Capture', r.capture_method], ['Result', result], ['Initiator', r.initiator ?? '—'], ['Capture ID', r.capture_id]].map(row)),
    h('h3', {}, 'URL'), h('pre', { class: 'wrap' }, r.url), h('p', {}, copy(r.url, 'URL')),
    search.length ? [h('h3', {}, 'Query parameters (in order)'), h('pre', {}, search.map(([k, v]) => `${k}=${v}`).join('\n'))] : null,
    h('h3', {}, 'Headers available to the extension'),
    r.available_headers ? h('dl', { class: 'kv' }, r.available_headers.map((x) => row([x.name, x.value]))) : h('p', { class: 'muted' }, 'Not recorded (raw retention off or not observed).'),
    h('p', { class: 'muted' }, 'Cookie and authorization headers are never captured.'),
    h('h3', {}, 'Body'),
    !b ? h('p', { class: 'muted' }, r.method === 'GET' ? 'No body (GET).' : 'Not recorded (raw retention off).')
      : b.kind === 'unavailable' ? h('p', { class: 'unresolved' }, `Body not exposed by the browser for this request${b.note ? ` (${b.note})` : ''}.`)
        : [h('p', { class: 'muted' }, b.content_type ?? 'content type unknown'), h('pre', {}, bodyText())]];
}

// ---------- misc ----------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2600);
}
function confirmDialog(text, okLabel) {
  const d = $('#confirm');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  return new Promise((resolve) => {
    const finish = (v) => { d.close(); resolve(v); };
    $('#confirm-ok').onclick = () => finish(true);
    $('#confirm-cancel').onclick = () => finish(false);
    d.oncancel = () => resolve(false);
    d.showModal();
    $('#confirm-cancel').focus();
  });
}

// Re-render data views after store changes, but never while the user is editing.
async function refresh() {
  const before = S.events.length;
  await loadSessions();
  await loadViewed();
  renderHeader();
  if (S.events.length > before) $('#announce').textContent = `${S.events.length} hits.`;
  if (S.settingsOpen) return;
  // The journey select lives in the toolbar, so a new journey needs a full Live render.
  const journeys = (S.session?.journeys ?? []).map((j) => j.name).join('\n');
  if (S.view === 'live') { if ($('#live-list') && journeys === S.journeyCount) renderLiveList(); else renderLive(); }
  S.journeyCount = journeys;
  if (S.view === 'sessions' && !S.renaming) renderSessions();
}
let refreshT;
const scheduleRefresh = () => { clearTimeout(refreshT); refreshT = setTimeout(() => refresh().catch((e) => console.error('[aajr] refresh', e?.message)), 150); };

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'changed' && (msg.session_id == null || msg.session_id === S.viewedId || !S.sessions.some((s) => s.session_id === msg.session_id))) scheduleRefresh();
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.recordingState) {
    const prev = S.rec.active_session_id;
    S.rec = ch.recordingState.newValue ?? { active_session_id: null, status: null };
    if (S.rec.active_session_id && S.rec.active_session_id !== prev && S.viewedId === prev) S.viewedId = S.rec.active_session_id;
    scheduleRefresh();
  }
  if (ch.health) { S.health = ch.health.newValue ?? null; renderHeader(); }
  if (ch.settings) S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...ch.settings.newValue };
  if (ch.filterProfiles) S.profiles = ch.filterProfiles.newValue ?? [];
  if (ch.adobeNames) S.names = ch.adobeNames.newValue ?? null;
});
chrome.permissions.onAdded.addListener(() => { S.permission = true; renderHeader(); });
chrome.permissions.onRemoved.addListener(() => { chrome.permissions.contains({ origins: ['<all_urls>'] }).then((v) => { S.permission = v; renderHeader(); }); });

$('#tabs').addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t) setView(t.dataset.view); });
$('#tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = [...$('#tabs').querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  setView(n.dataset.view);
  n.focus();
});
$('#gear').replaceChildren(icon('gear', { size: 16 }));
$('#gear').addEventListener('click', () => { S.settingsOpen = !S.settingsOpen; S.editingProfile = null; renderAll(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#popover').hidden) { e.preventDefault(); closePopover(); return; }
  if (e.key !== 'Escape' || S.expanded == null || $('#confirm').open) return;
  e.preventDefault();
  toggleHit(S.expanded);
});

(async () => {
  try {
    await loadConfig();
    await loadSessions();
    await loadViewed();
    if (!loadViewState()) S.onlyMatching = profile()?.show_matching_only ?? true;
  } catch (e) {
    console.error('[aajr] load', e?.name, e?.message);
    S.banner = { text: 'Could not open the local recording database. Details in the console.', action: null };
  }
  if (!['live', 'sessions'].includes(S.view)) S.view = 'live';
  renderAll();
})();
