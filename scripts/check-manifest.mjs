// Checks extension/manifest.json: Manifest V3, a valid version, and every file it names exists inside extension/.
// Pages it names may load only local scripts and styles. No network, no dependencies.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

if (!existsSync('extension') || lstatSync('extension').isSymbolicLink()) {
  console.error(existsSync('extension') ? 'extension: a symlinked extension/ is not followed' : 'extension: directory not found');
  process.exit(1);
}
const root = realpathSync(resolve('extension'));
const problems = [];
let manifest;
try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); } catch (e) {
  console.error(`manifest.json: ${e.code === 'ENOENT' ? 'not found' : `not valid JSON (${e.message})`}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) problems.push('manifest.json: manifest_version must be 3');
for (const key of ['name', 'version', 'description']) if (typeof manifest[key] !== 'string' || !manifest[key].trim()) problems.push(`manifest.json: "${key}" is missing`);
// Chrome accepts one to four dot-separated integers, each 0-65535 without leading zeros.
if (typeof manifest.version === 'string' && !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(manifest.version)) problems.push(`manifest.json: version "${manifest.version}" is not 1-4 dot-separated integers`);

const values = (v) => v === undefined ? [] : typeof v === 'string' ? [v] : Array.isArray(v) ? v : Object.values(v);
const named = [
  ...values(manifest.action?.default_popup), ...values(manifest.action?.default_icon), ...values(manifest.icons),
  ...values(manifest.background?.service_worker), ...values(manifest.background?.scripts), ...values(manifest.background?.page),
  ...values(manifest.options_page), ...values(manifest.options_ui?.page), ...values(manifest.side_panel?.default_path),
  ...values(manifest.devtools_page), ...values(manifest.sidebar_action?.default_panel),
  ...(manifest.content_scripts ?? []).flatMap((c) => [...values(c.js), ...values(c.css)]),
  ...(manifest.web_accessible_resources ?? []).flatMap((w) => values(w.resources)).filter((p) => !p.includes('*')),
];
const local = (from, ref) => {
  const target = resolve(from, ref.replace(/^\//, ''));
  if (!existsSync(target)) return null;
  const real = realpathSync(target);
  return real.startsWith(root + sep) ? real : false;
};
const pages = [];
for (const ref of named) {
  if (typeof ref !== 'string' || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) { problems.push(`manifest.json: "${ref}" must be a file inside extension/ (no remote code)`); continue; }
  const file = local(root, ref.split(/[?#]/)[0]);
  if (file === null) problems.push(`manifest.json: "${ref}" does not exist`);
  else if (file === false) problems.push(`manifest.json: "${ref}" points outside extension/`);
  else if (file.endsWith('.html')) pages.push(file);
}
for (const page of new Set(pages)) {
  const name = page.slice(root.length + 1), html = readFileSync(page, 'utf8');
  if (/<script(?![^>]*\ssrc=)[^>]*>\s*\S/i.test(html)) problems.push(`${name}: inline scripts are refused by the extension CSP; move them to a .js file`);
  for (const [, tag, ref] of html.matchAll(/<(script|link)\b[^>]*\s(?:src|href)="([^"]*)"/gi)) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) { if (tag.toLowerCase() === 'script') problems.push(`${name}: remote script "${ref}" is refused; ship it inside extension/`); continue; }
    const file = local(dirname(page), ref.split(/[?#]/)[0]);
    if (!file) problems.push(`${name}: "${ref}" ${file === null ? 'does not exist' : 'points outside extension/'}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check-manifest: Manifest V3, ${named.length} file(s) and ${new Set(pages).size} page(s) resolve`);
