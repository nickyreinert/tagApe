// Journey report (T-015): one self-contained HTML file, vertical timeline top to bottom,
// screenshot left (only when it changed), decoded dimensions right. All captured values are escaped.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plain = (v) => (v && typeof v === 'object' ? v.resolved ?? v.raw : v);
const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(ms % 1000).padStart(3, '0');

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const CSS = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1b1d21; --muted: #5a616c; --line: #d6d9de; --soft: #f2f3f5; --accent: #6b4fd8;
  --ev: #14532d; --ev-bg: #dcf3e1; --evar: #5c4400; --evar-bg: #fdf1c2; --prop: #133e7c; --prop-bg: #dbe8fb; --list: #4f1d73; --list-bg: #efe0fa; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1f23; --fg: #e8eaed; --muted: #a8aeb8; --line: #3b3f46; --soft: #272a2f; --accent: #a593f2;
  --ev: #9be3ad; --ev-bg: #173a22; --evar: #f5d870; --evar-bg: #3d3310; --prop: #a8c7fa; --prop-bg: #172c4a; --list: #d7b5f5; --list-bg: #33204a; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 22px; }
.meta { color: var(--muted); margin: 0 0 24px; }
.timeline { position: relative; list-style: none; margin: 0; padding: 0 0 0 22px; border-left: 2px solid var(--line); }
.timeline > li { position: relative; margin: 0 0 18px; }
.timeline > li::before { content: ""; position: absolute; left: -29px; top: 6px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); }
.timeline > li.mark::before { background: #c2185b; }
.timeline > li.nav::before { background: var(--line); width: 8px; height: 8px; left: -27px; top: 7px; }
.mark { font-weight: 600; color: #c2185b; }
.nav { color: var(--muted); font-size: 12px; }
.hit { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 16px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; }
.hit.noshot { grid-template-columns: minmax(0, 1fr); }
.shot img { width: 100%; border: 1px solid var(--line); border-radius: 4px; }
.shot small { color: var(--muted); }
.head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.head .t { font-family: ui-monospace, Menlo, monospace; color: var(--muted); }
.head .title { font-weight: 700; font-size: 15px; overflow-wrap: anywhere; }
.badge { padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; font-size: 12px; color: var(--muted); }
dl { display: grid; grid-template-columns: minmax(90px, 28%) 1fr; gap: 3px 10px; margin: 8px 0 0; }
dt { overflow-wrap: anywhere; }
dd { margin: 0; overflow-wrap: anywhere; }
.chip { display: inline-block; padding: 0 6px; border-radius: 8px; font: 12px ui-monospace, Menlo, monospace; }
.ev { color: var(--ev); background: var(--ev-bg); } .evar { color: var(--evar); background: var(--evar-bg); }
.prop { color: var(--prop); background: var(--prop-bg); } .list { color: var(--list); background: var(--list-bg); }
.aname { color: var(--muted); font-size: 12px; margin-left: 4px; }
.warn { color: #b3261e; }
@media (width < 700px) { .hit { grid-template-columns: 1fr; } }
`;

// data: { title, subtitle, entries: [{type:'event'|'nav'|'mark', ...}], tabOf, shotFor, nameOf, callTypeLabel }
export async function buildReport(data) {
  const out = [];
  let lastShot = null;
  for (const x of data.entries) {
    if (x.type === 'mark') { out.push(`<li class="mark">⚑ ${esc(x.label)}</li>`); continue; }
    if (x.type === 'nav') { out.push(`<li class="nav">${esc(x.label)}</li>`); continue; }
    const e = x.e;
    const tab = data.tabOf(e);
    const shot = data.shotFor(e);
    let shotHtml = '';
    if (shot && shot.shot_id !== lastShot) {
      lastShot = shot.shot_id;
      shotHtml = `<div class="shot"><img alt="Screenshot" src="${esc(await blobToDataUrl(shot.image))}"><small>${esc(time(shot.timestamp))}</small></div>`;
    } else if (shot) shotHtml = '<div class="shot"><small>same screen as above</small></div>';
    const title = e.hit_type.startsWith('link') && e.link_name ? e.link_name : e.page_name ?? '(no page name)';
    const row = (kind, name, value) => {
      const n = data.nameOf(kind, name);
      return `<dt><span class="chip ${kind}">${esc(name)}</span>${n ? `<span class="aname">${esc(n)}</span>` : ''}</dt><dd>${esc(value)}</dd>`;
    };
    const vars = (kind, obj) => Object.keys(obj ?? {}).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((k) => row(kind, k, plain(obj[k]))).join('');
    const dl = [
      e.events.map((ev) => row('ev', ev.name, ev.value ?? '')).join(''),
      vars('evar', e.evars), vars('prop', e.props), vars('list', e.list_vars), vars('list', e.hierarchies),
      e.products.length ? `<dt>products</dt><dd>${esc(e.products.map((p) => p.raw).join(' , '))}</dd>` : '',
    ].join('');
    out.push(`<li><div class="hit${shot ? '' : ' noshot'}">${shot ? shotHtml : ''}<div>
      <div class="head"><span class="t">${esc(time(e.timestamp))}</span><span class="badge" title="${esc(tab.title)}">${esc(tab.badge)}</span>
      <span class="badge">${esc({ websdk: 'Web SDK', appmeasurement: 'AppMeasurement', ga4: 'Google Analytics 4', universal: 'Universal Analytics' }[e.source] ?? 'Unknown')}</span>
      <span class="badge">${esc(e.event_type ?? e.hit_type)}</span><span class="badge">${esc(data.callTypeLabel(e))}</span>
      ${e.parse_status !== 'complete' ? `<span class="warn">${esc(e.parse_status)}</span>` : ''}</div>
      <div class="head"><span class="title">${esc(title)}</span></div>
      ${e.page_url ? `<div class="meta" style="margin:0">${esc(e.page_url)}</div>` : ''}
      ${dl ? `<dl>${dl}</dl>` : ''}</div></div></li>`);
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title><style>${CSS}</style></head><body><main>
<h1>${esc(data.title)}</h1><p class="meta">${esc(data.subtitle)}</p>
<ol class="timeline">${out.join('\n')}</ol></main></body></html>`;
}
