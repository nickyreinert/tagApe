// Optional Adobe name lookup (ADR-0010): parse a pasted Workspace curl, then fetch dimension/metric names.
// The pasted auth lives in chrome.storage.session only; local storage keeps just the names.

// Shell-like split: single/double quotes, backslash escapes, line continuations.
function shellWords(text) {
  const out = [];
  let cur = '', quote = null, has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (c === '\\') {
      const n = text[++i];
      if (n === '\n' || n === undefined) continue;
      cur += quote === '"' && !'"\\$`'.includes(n) ? '\\' + n : n;
      has = true;
      continue;
    }
    if (quote === '"') { if (c === '"') quote = null; else cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

const KEEP_HEADERS = /^(authorization|x-proxy-global-company-id|x-gw-ims-org-id|x-api-key|x-request-client-type|accept)$/i;

export function parseCurl(text) {
  const words = shellWords(String(text ?? '').trim());
  if (words[0] !== 'curl') throw new Error('Paste a command that starts with curl.');
  let url = null, body = null;
  const headers = {};
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-H' || w === '--header') {
      const hv = words[++i] ?? '';
      const j = hv.indexOf(':');
      if (j > 0 && KEEP_HEADERS.test(hv.slice(0, j).trim())) headers[hv.slice(0, j).trim().toLowerCase()] = hv.slice(j + 1).trim();
    } else if (/^(-d|--data(-raw|-binary)?)$/.test(w)) body = words[++i] ?? null;
    else if (w === '--url') url = words[++i];
    else if (/^https?:\/\//.test(w)) url = w;
    else if (/^-(X|-request|b|-cookie|A|-user-agent|e|-referer|o|u)$/.test(w)) i++;
  }
  if (!url) throw new Error('No https URL found in the curl.');
  if (!/^bearer\s+\S+/i.test(headers.authorization ?? '')) throw new Error('No "Authorization: Bearer …" header found.');
  let rsid = new URL(url).searchParams.get('rsid');
  try { rsid ??= JSON.parse(body)?.rsid ?? null; } catch { /* body not JSON */ }
  if (!rsid) throw new Error('No report suite (rsid) found in the curl body or URL.');
  // Candidate bases, tried in order (ADR-0010):
  // 1. the Workspace proxy host from the curl, which accepts the Workspace token, at likely 2.0-style paths;
  // 2. the documented API https://analytics.adobe.io/api/{company}/ (needs a Developer Console client id as x-api-key).
  const u = new URL(url);
  const company = headers['x-proxy-global-company-id'] ?? null;
  const i = u.pathname.indexOf('/reports');
  const prefix = i >= 0 ? u.pathname.slice(0, i) : u.pathname.replace(/\/[^/]*$/, '');
  const bases = [...new Set([
    `${u.origin}${prefix}/`,
    `${u.origin}${prefix.replace(/\/users$/, '')}/`,
    company ? `${u.origin}${prefix.replace(/\/users$/, '')}/${encodeURIComponent(company)}/` : null,
    company ? `https://analytics.adobe.io/api/${encodeURIComponent(company)}/` : null,
  ].filter(Boolean))];
  return { bases, headers, rsid };
}

async function getList(auth, base, what) {
  const url = `${base}${what}?rsid=${encodeURIComponent(auth.rsid)}&locale=en_US&limit=10000`;
  const headers = { ...auth.headers };
  if (new URL(base).host === 'analytics.adobe.io') { if (auth.apiKey) headers['x-api-key'] = auth.apiKey; } else delete headers['x-api-key'];
  const r = await fetch(url, { headers, credentials: 'omit' });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 100)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`not JSON: ${text.slice(0, 100)}`); }
  const list = Array.isArray(j) ? j : j.content ?? j[what] ?? [];
  const map = {};
  for (const x of list) if (x?.id && x?.name) map[String(x.id).toLowerCase()] = String(x.name);
  if (!Object.keys(map).length) throw new Error(`no {id, name} entries: ${text.slice(0, 100)}`);
  return map;
}

// Tries each base; the first one that returns both lists wins. On failure the error lists every attempt.
export async function fetchNames(auth) {
  const tried = [];
  for (const base of auth.bases) {
    if (new URL(base).host === 'analytics.adobe.io' && !auth.apiKey) { tried.push(`${base}: skipped (no Developer Console client id)`); continue; }
    try {
      const [dims, metrics] = await Promise.all([getList(auth, base, 'dimensions'), getList(auth, base, 'metrics')]);
      return { rsid: auth.rsid, fetched_at: Date.now(), source: base, dims, metrics };
    } catch (e) { tried.push(`${base}: ${e.message}`); }
  }
  throw new Error(`no endpoint returned names.\n${tried.join('\n')}`);
}

// Decoded variable → API id: eVar13 → variables/evar13, event10 → metrics/event10, prodView → metrics/productviews.
const STD_EVENTS = { prodview: 'productviews', scadd: 'cartadditions', scremove: 'cartremovals', scview: 'cartviews', scopen: 'carts', sccheckout: 'checkouts', purchase: 'orders' };
export function adobeName(names, kind, name) {
  if (!names) return null;
  const n = name.toLowerCase();
  if (kind === 'ev') return names.metrics[`metrics/${STD_EVENTS[n] ?? n}`] ?? null;
  const id = { evar: `variables/${n}`, prop: `variables/${n}`, list: `variables/listvar${n.replace(/^list/, '')}`, hier: `variables/${n}` }[kind];
  return id ? names.dims[id] ?? null : null;
}
