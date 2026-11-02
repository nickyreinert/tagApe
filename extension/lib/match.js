// Rule matching for filter profiles; read-only views over events (data-model.md §4.6).

export const FIELDS = ['event', 'rsid', 'page_name', 'page_url', 'link_name', 'hit_type', 'source', 'parse_status', 'tab', 'evar:1', 'prop:1'];
export const OPS = ['equals', 'contains', 'exists', 'regex'];
const FIELD_RE = /^(event|rsid|page_name|page_url|link_name|hit_type|source|parse_status|tab|evar:\d+|prop:\d+)$/;

const plain = (v) => (v && typeof v === 'object' ? v.resolved ?? v.raw : v);

// tabOf(e) → { badge, title } for the "tab" field.
function fieldValues(e, f, tabOf) {
  if (f === 'event') return e.events.map((x) => x.name);
  if (f === 'rsid') return e.rsid ?? [];
  if (f === 'tab') { const t = tabOf(e); return [t.badge, t.title]; }
  if (f.startsWith('evar:')) return [plain(e.evars['eVar' + f.slice(5)])];
  if (f.startsWith('prop:')) return [plain(e.props['prop' + f.slice(5)])];
  return [e[f]];
}

export function matchRule(e, r, tabOf) {
  const vals = fieldValues(e, r.field, tabOf).filter((v) => v != null).map(String);
  if (r.op === 'exists') return vals.length > 0;
  const want = String(r.value ?? '');
  if (r.op === 'contains') return vals.some((v) => v.toLowerCase().includes(want.toLowerCase()));
  if (r.op === 'regex') {
    let re;
    try { re = new RegExp(want); } catch { return false; }
    return vals.some((v) => re.test(v));
  }
  return vals.includes(want);
}

export const matchesProfile = (e, p, tabOf) =>
  (!p.include_rules.length || p.include_rules.some((r) => matchRule(e, r, tabOf))) && !p.exclude_rules.some((r) => matchRule(e, r, tabOf));

export const ruleText = (r) => `${r.field} ${r.op}${r.op === 'exists' ? '' : ' ' + (r.value ?? '')}`;

export function validateRules(rules) {
  for (const [i, r] of rules.entries()) {
    if (!FIELD_RE.test(r.field ?? '')) return `Rule ${i + 1}: unknown field "${r.field}". Use ${FIELDS.join(', ')} (evar:N, prop:N).`;
    if (!OPS.includes(r.op)) return `Rule ${i + 1}: unknown operator "${r.op}".`;
    if (r.op !== 'exists' && !String(r.value ?? '').length) return `Rule ${i + 1}: value is empty.`;
    if (r.op === 'regex') { try { new RegExp(r.value); } catch { return `Rule ${i + 1}: invalid regular expression.`; } }
  }
  return null;
}
