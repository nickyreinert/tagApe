// Detection, masking and decoding of tracking requests. Contracts: docs/spec/data-model.md §5, architecture.md §6.3.
// All input is untrusted: no eval, size-limited bodies, every hit decoded inside try/catch by the caller.

const MAX_BODY = 2 * 1024 * 1024;
const AM_PATH = /\/b\/ss\/([^/]+)\//;
const SDK_PATH = /\/ee\/(?:.+\/)?v\d+\/(?:interact|collect)/;
const GA4_PATH = /\/g\/collect\/?$/;
const UA_PATH = /^\/(?:r\/|j\/)?collect\/?$/;

export const BUILT_IN_PATTERNS = [
  { pattern: '/b/ss/', source: 'AppMeasurement' },
  { pattern: '/ee/…/v1/interact | collect', source: 'Web SDK' },
  { pattern: '/g/collect', source: 'Google Analytics 4' },
  { pattern: '/mp/collect', source: 'GA4 Measurement Protocol' },
  { pattern: '/collect | /r/collect | /j/collect', source: 'Universal Analytics' },
];

export function compilePatterns(list) {
  const out = [];
  for (const p of list ?? []) {
    try { out.push(new URLPattern(p)); } catch { /* validated on save; skip stale invalid entries */ }
  }
  return out;
}

export function detect(url, customPatterns) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (AM_PATH.test(u.pathname)) return 'appmeasurement';
  if (SDK_PATH.test(u.pathname)) return 'websdk';
  if (GA4_PATH.test(u.pathname) && u.searchParams.get('v') === '2' && /^G-[\w-]+$/i.test(u.searchParams.get('tid') ?? '')) return 'ga4';
  if (/^\/(?:debug\/)?mp\/collect\/?$/.test(u.pathname) && /^G-[\w-]+$/i.test(u.searchParams.get('measurement_id') ?? '')) return 'ga4mp';
  if (UA_PATH.test(u.pathname) && u.searchParams.get('v') === '1' && /^UA-\d+-\d+$/i.test(u.searchParams.get('tid') ?? '')) return 'universal';
  if (customPatterns.some((p) => p.test(url))) return 'custom';
  return null;
}

// webRequest requestBody → { kind, content_type, data, encoding }. content_type is not known at this stage.
export function readBody(rb) {
  if (!rb) return null;
  if (rb.formData) {
    const sp = new URLSearchParams();
    for (const [k, vals] of Object.entries(rb.formData)) for (const v of vals) sp.append(k, v);
    return { kind: 'formData', content_type: 'application/x-www-form-urlencoded', data: sp.toString(), encoding: 'utf8' };
  }
  const parts = (rb.raw ?? []).filter((p) => p.bytes);
  if (!parts.length) return { kind: 'unavailable', content_type: null, data: null, encoding: null };
  const size = parts.reduce((n, p) => n + p.bytes.byteLength, 0);
  if (size > MAX_BODY) return { kind: 'unavailable', content_type: null, data: null, encoding: null, note: `body larger than ${MAX_BODY} bytes` };
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { bytes.set(new Uint8Array(p.bytes), o); o += p.bytes.byteLength; }
  try {
    return { kind: 'raw', content_type: null, data: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' };
  } catch {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return { kind: 'raw', content_type: null, data: btoa(bin), encoding: 'base64' };
  }
}

// ---------- masking (applied before anything is stored) ----------
const MASK = '[masked]';
const globRe = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const amAlias = (k) => {
  let m;
  if ((m = /^v(\d+)$/.exec(k))) return 'eVar' + m[1];
  if ((m = /^c(\d+)$/.exec(k))) return 'prop' + m[1];
  return null;
};

function maskQuery(query, res) {
  const out = [];
  const stack = [];
  for (const [k, v] of new URLSearchParams(query)) {
    if (k.length > 1 && k.endsWith('.') && v === '') { stack.push(k.slice(0, -1)); out.push([k, v]); continue; }
    if (k.length > 1 && k.startsWith('.') && v === '') { stack.pop(); out.push([k, v]); continue; }
    const names = [k, amAlias(k), stack.length ? [...stack.slice(1), k].join('.') : null].filter(Boolean);
    out.push([k, names.some((n) => res.some((r) => r.test(n))) ? MASK : v]);
  }
  return new URLSearchParams(out).toString();
}

function maskJson(node, path, res) {
  if (!node || typeof node !== 'object') return node;
  for (const k of Object.keys(node)) {
    const full = path ? `${path}.${k}` : k;
    const rel = full.replace(/^events\.\d+\./, '');
    if (res.some((r) => r.test(k) || r.test(rel))) node[k] = MASK;
    else maskJson(node[k], full, res);
  }
  return node;
}

export function maskRequest({ url, body }, rules) {
  const res = ['api_secret', ...(rules ?? [])].filter(Boolean).map(globRe);
  const u = new URL(url);
  if (u.search) u.search = maskQuery(u.search, res);
  if (!body || body.kind === 'unavailable') return { url: u.href, body };
  if (body.encoding === 'base64') return { url: u.href, body: { kind: 'unavailable', content_type: null, data: null, encoding: null, note: 'binary body dropped because masking rules are active' } };
  let data;
  try { data = JSON.stringify(maskJson(JSON.parse(body.data), '', res)); } catch { data = maskQuery(body.data, res); }
  return { url: u.href, body: { ...body, data } };
}

export function stripQuery(url) {
  try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; } catch { return url; }
}

// ---------- decoding ----------
function amKey(k) {
  let m;
  if (k === 'v0') return [null, 'campaign'];
  if ((m = /^v(\d+)$/.exec(k))) return ['evars', 'eVar' + m[1]];
  if ((m = /^c(\d+)$/.exec(k))) return ['props', 'prop' + m[1]];
  if ((m = /^l(\d)$/.exec(k))) return ['list_vars', 'list' + m[1]];
  if ((m = /^h(\d)$/.exec(k))) return ['hierarchies', 'hier' + m[1]];
  return [null, { pageName: 'pageName', gn: 'pageName', g: 'pageURL', r: 'referrer', events: 'events', products: 'products', pe: 'pe', pev2: 'linkName', server: 'server', mid: 'mid', aid: 'aid', vid: 'vid', fid: 'fid' }[k] ?? null];
}
function sdkKey(k) {
  if (/^eVar\d+$/.test(k)) return ['evars', k];
  if (/^prop\d+$/.test(k)) return ['props', k];
  if (/^list\d$/.test(k)) return ['list_vars', k];
  if (/^hier\d$/.test(k)) return ['hierarchies', k];
  return [null, { pageName: 'pageName', pageURL: 'pageURL', referrer: 'referrer', events: 'events', products: 'products', linkName: 'linkName', server: 'server' }[k] ?? null];
}
function normalize(pairs, keyOf, msgs) {
  const n = { evars: {}, props: {}, list_vars: {}, hierarchies: {}, fields: {}, other_params: {} };
  const seen = new Map();
  for (const [k, v] of pairs) {
    if (seen.has(k)) {
      msgs.push(`parameter "${k}" repeated; first value used`);
      const prev = n.other_params[k];
      n.other_params[k] = Array.isArray(prev) ? [...prev, v] : [seen.get(k), v];
      continue;
    }
    seen.set(k, v);
    const [group, name] = keyOf(k);
    if (group) n[group][name] = v;
    else if (name) n.fields[name] = v;
    else n.other_params[k] = v;
  }
  return n;
}
function lookupRef(n, ref) {
  let [g, name] = amKey(ref);
  if (!g && !name) [g, name] = sdkKey(ref);
  let v = g ? n[g][name] : name ? n.fields[name] : n.other_params[ref];
  if (v && typeof v === 'object') v = v.resolved;
  if (typeof v === 'string' && v.startsWith('D=')) return null;
  return v ?? null;
}
const refLabel = (ref) => amKey(ref)[1] ?? ref;
// D= references are resolved only from the same hit, never guessed (data-model.md §5.1).
function resolveRefs(n) {
  for (const g of ['evars', 'props', 'list_vars', 'hierarchies']) {
    for (const [k, v] of Object.entries(n[g])) {
      if (typeof v === 'string' && v.startsWith('D=')) n[g][k] = { raw: v, ref: refLabel(v.slice(2)), resolved: lookupRef(n, v.slice(2)) };
    }
  }
}
function parseEvents(s, msgs) {
  if (!s) return [];
  return s.split(',').filter(Boolean).map((t) => {
    const m = /^([^=:]+)(?:=([^:]*))?(?::(.+))?$/.exec(t.trim());
    if (!m) { msgs.push(`events: "${t}" not understood`); return { name: t, value: null, serial: null }; }
    return { name: m[1], value: m[2] ?? null, serial: m[3] ?? null };
  });
}
function parseProducts(s, msgs) {
  if (!s) return [];
  return s.split(',').map((raw, i) => {
    const [category = '', product = '', quantity = '', price = '', evs = '', vars = ''] = raw.split(';');
    if (price && !/^-?\d+(\.\d+)?$/.test(price)) msgs.push(`products[${i + 1}]: price "${price}" is not a number`);
    if (quantity && !/^\d+$/.test(quantity)) msgs.push(`products[${i + 1}]: quantity "${quantity}" is not a number`);
    const p = { category: category || null, product: product || null, quantity: quantity || null, price: price || null, events: {}, evars: {}, raw };
    for (const kv of evs.split('|').filter(Boolean)) { const j = kv.indexOf('='); p.events[j < 0 ? kv : kv.slice(0, j)] = j < 0 ? null : kv.slice(j + 1); }
    for (const kv of vars.split('|').filter(Boolean)) { const j = kv.indexOf('='); if (j > 0) p.evars[kv.slice(0, j)] = kv.slice(j + 1); }
    return p;
  });
}
function build(source, n, x, msgs) {
  return {
    source, hit_type: x.hit, rsid: x.rsid ?? null, datastream_id: x.datastream_id ?? null,
    page_name: n.fields.pageName ?? x.page_name ?? null,
    page_url: n.fields.pageURL ?? x.page_url ?? null,
    referrer: n.fields.referrer ?? x.referrer ?? null,
    link_name: n.fields.linkName ?? x.link_name ?? null,
    events: parseEvents(n.fields.events, msgs),
    products: parseProducts(n.fields.products, msgs),
    evars: n.evars, props: n.props, list_vars: n.list_vars, hierarchies: n.hierarchies,
    context_data: x.context_data ?? {},
    visitor_ids: x.visitor_ids ?? Object.fromEntries(['mid', 'aid', 'vid', 'fid'].filter((k) => n.fields[k]).map((k) => [k, n.fields[k]])),
    other_params: { ...(n.fields.campaign ? { campaign: n.fields.campaign } : {}), ...(n.fields.server ? { server: n.fields.server } : {}), ...(n.fields.pe ? { pe: n.fields.pe } : {}), ...n.other_params },
    xdm: x.xdm ?? null, data: x.data ?? null, event_type: x.event_type ?? null,
    parse_messages: msgs, parse_status: x.status ?? (msgs.length ? 'partial' : 'complete'),
  };
}
const empty = () => normalize([], sdkKey, []);
export const failedEvent = (msg) => build('unknown', empty(), { hit: 'unknown', status: 'failed' }, [msg]);
const textBody = (body) => (body && body.encoding === 'utf8' && body.kind !== 'unavailable' ? body.data : null);

function parseAM(r) {
  const u = new URL(r.url), msgs = [], ctx = {}, stack = [], pairs = [];
  const m = AM_PATH.exec(u.pathname);
  const posted = r.method === 'POST' ? textBody(r.body) : null;
  if (r.method === 'POST' && posted == null) msgs.push('request body not exposed by the browser; only the URL was decoded');
  for (const [k, v] of new URLSearchParams(posted ?? u.search)) {
    if (k.length > 1 && k.endsWith('.') && v === '') { stack.push(k.slice(0, -1)); continue; }
    if (k.length > 1 && k.startsWith('.') && v === '') { if (stack.pop() !== k.slice(1)) msgs.push(`context data: unexpected "${k}"`); continue; }
    if (stack.length) { ctx[[...stack.slice(1), k].join('.')] = v; continue; }
    pairs.push([k, v]);
  }
  if (stack.length) msgs.push('context data: unclosed block');
  const n = normalize(pairs, amKey, msgs);
  resolveRefs(n);
  const hit = n.fields.pe ? ({ lnk_o: 'link_custom', lnk_d: 'link_download', lnk_e: 'link_exit' }[n.fields.pe] ?? 'unknown') : pairs.length ? 'page_view' : 'unknown';
  let rsid = null;
  if (m) { try { rsid = decodeURIComponent(m[1]).split(','); } catch { rsid = m[1].split(','); } }
  return [build('appmeasurement', n, { rsid, context_data: ctx, hit }, msgs)];
}

function parseSDK(r) {
  const u = new URL(r.url);
  const datastream_id = u.searchParams.get('configId');
  const text = textBody(r.body);
  if (text == null) return [build('websdk', empty(), { hit: 'websdk_event', datastream_id, status: 'partial' }, ['body not exposed by browser'])];
  let j;
  try { j = JSON.parse(text); } catch { return [failedEvent('request body is not valid JSON')]; }
  if (!Array.isArray(j?.events) || !j.events.length) return [build('websdk', empty(), { hit: 'websdk_event', datastream_id, status: 'partial' }, ['no events[] in payload'])];
  return j.events.map((e) => {
    const msgs = [], a = e?.data?.__adobe?.analytics, x = e?.xdm ?? {};
    const n = normalize(a && typeof a === 'object' ? Object.entries(a).map(([k, v]) => [k, String(v)]) : [], sdkKey, msgs);
    resolveRefs(n);
    const hit = { 'web.webpagedetails.pageViews': 'page_view', 'web.webinteraction.linkClicks': 'link_custom' }[x.eventType] ?? 'websdk_event';
    return build('websdk', n, {
      hit, datastream_id, event_type: x.eventType ?? null, xdm: x, data: e?.data ?? null,
      page_name: x.web?.webPageDetails?.name, page_url: x.web?.webPageDetails?.URL, referrer: x.web?.webReferrer?.URL,
      link_name: x.web?.webInteraction?.name, visitor_ids: x.identityMap ?? {},
    }, msgs);
  });
}

function parseGeneric(r) {
  const u = new URL(r.url);
  const other = Object.fromEntries(u.searchParams);
  const text = textBody(r.body);
  if (text != null) {
    try { other.body = JSON.parse(text); } catch { Object.assign(other, Object.fromEntries(new URLSearchParams(text))); }
  }
  if (!Object.keys(other).length) return [failedEvent('no parser for this format and nothing could be decoded')];
  const n = empty();
  n.other_params = other;
  return [build('unknown', n, { hit: 'unknown', status: 'partial' }, ['no parser for this format; parameters decoded generically'])];
}

function parseGA4(r) {
  const u = new URL(r.url);
  const msgs = [];
  const params = new URLSearchParams(u.search);
  const posted = r.method === 'POST' ? textBody(r.body) : null;
  if (r.method === 'POST' && posted == null) msgs.push('request body not exposed by the browser; only the URL was decoded');
  if (posted != null) for (const [key, value] of new URLSearchParams(posted)) params.append(key, value);
  const name = params.get('en');
  if (!name) msgs.push('event name (en) is missing');
  const measurement_id = params.get('tid');
  const n = empty();
  n.fields.pageName = params.get('dt');
  n.fields.pageURL = params.get('dl');
  n.fields.referrer = params.get('dr');
  n.fields.linkName = name && name !== 'page_view' ? name : null;
  n.fields.events = name;
  n.other_params = Object.fromEntries(params);
  delete n.other_params.en;
  delete n.other_params.tid;
  delete n.other_params.dt;
  delete n.other_params.dl;
  delete n.other_params.dr;
  const hit = name === 'page_view' ? 'page_view' : 'ga4_event';
  const event = build('ga4', n, {
    hit, event_type: name, visitor_ids: Object.fromEntries(['cid', 'sid'].filter((key) => params.has(key)).map((key) => [key, params.get(key)])),
    status: msgs.length ? 'partial' : 'complete',
  }, msgs);
  event.measurement_id = measurement_id;
  return [event];
}

function parseGA4MP(r) {
  const u = new URL(r.url), text = textBody(r.body), measurement_id = u.searchParams.get('measurement_id');
  if (text == null) return [build('ga4', empty(), { hit: 'ga4_event', status: 'partial' }, ['body not exposed by browser'])].map((e) => ({ ...e, measurement_id }));
  let payload;
  try { payload = JSON.parse(text); } catch { return [build('ga4', empty(), { hit: 'ga4_event', status: 'failed' }, ['request body is not valid JSON'])].map((e) => ({ ...e, measurement_id })); }
  if (!Array.isArray(payload?.events) || !payload.events.length) return [build('ga4', empty(), { hit: 'ga4_event', status: 'partial' }, ['no events[] in payload'])].map((e) => ({ ...e, measurement_id }));
  return payload.events.map((item) => {
    const name = typeof item?.name === 'string' ? item.name : null;
    const params = item?.params && typeof item.params === 'object' && !Array.isArray(item.params) ? item.params : {};
    const msgs = name ? [] : ['event name is missing'];
    const n = empty();
    n.fields.pageName = params.page_title ?? null;
    n.fields.pageURL = params.page_location ?? null;
    n.fields.referrer = params.page_referrer ?? null;
    n.fields.linkName = name && name !== 'page_view' ? name : null;
    n.fields.events = name;
    n.other_params = { ...params };
    const e = build('ga4', n, { hit: name === 'page_view' ? 'page_view' : 'ga4_event', event_type: name,
      visitor_ids: Object.fromEntries(['client_id', 'user_id'].filter((key) => payload[key] != null).map((key) => [key, payload[key]])),
      status: msgs.length ? 'partial' : 'complete' }, msgs);
    e.measurement_id = measurement_id;
    return e;
  });
}

function parseUniversal(r) {
  const u = new URL(r.url), params = new URLSearchParams(u.search), msgs = [];
  const posted = r.method === 'POST' ? textBody(r.body) : null;
  if (r.method === 'POST' && posted == null) msgs.push('request body not exposed by the browser; only the URL was decoded');
  if (posted != null) for (const [key, value] of new URLSearchParams(posted)) params.append(key, value);
  const type = params.get('t');
  if (!type) msgs.push('hit type (t) is missing');
  const action = [params.get('ec'), params.get('ea')].filter(Boolean).join(':');
  const n = empty();
  n.fields.pageName = params.get('dt');
  n.fields.pageURL = params.get('dl');
  n.fields.referrer = params.get('dr');
  n.fields.linkName = type === 'event' ? action || params.get('el') : null;
  n.fields.events = type === 'event' ? 'event' : null;
  n.other_params = Object.fromEntries(params);
  const e = build('universal', n, { hit: type === 'pageview' ? 'page_view' : 'ga_event', event_type: type,
    visitor_ids: Object.fromEntries(['cid', 'uid'].filter((key) => params.has(key)).map((key) => [key, params.get(key)])),
    status: msgs.length ? 'partial' : 'complete' }, msgs);
  e.measurement_id = params.get('tid');
  if (type === 'event') e.events = [{ name: action || 'event', value: params.get('ev'), serial: null }];
  return [e];
}

// r = { url, method, body }; returns AnalyticsEvent field sets without ids.
export function parseRequest(r, detectedAs) {
  if (detectedAs === 'appmeasurement') return parseAM(r);
  if (detectedAs === 'websdk') return parseSDK(r);
  if (detectedAs === 'ga4') return parseGA4(r);
  if (detectedAs === 'ga4mp') return parseGA4MP(r);
  if (detectedAs === 'universal') return parseUniversal(r);
  return parseGeneric(r);
}
