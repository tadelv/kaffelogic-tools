// Compares the JS port against the known-good Python numbers for log0029.klog.
// Run: node web/test.mjs
import { readFileSync } from 'node:fs';
import { parseProfile, parseKlog, metrics, diff, applyEdits, buildBrief, serializeProfile } from './klt.js';

const profile = parseProfile(readFileSync(new URL('./fixtures/Guji-74110-washed-v2.kpro', import.meta.url), 'utf8'));
const log = parseKlog(readFileSync(new URL('./fixtures/log0029.klog', import.meta.url), 'utf8'));

const m = metrics(log);
const d = diff(log, profile);

const expect = {
  charge_to_drop_s: 358.6,
  dry_pct: 44.1,
  first_crack_s: 316.8,
  development_pct: 11.6569,
  drop_delta: -0.7,
  profile: 'GujiWashed',
};
let failures = 0;
for (const [k, want] of Object.entries(expect)) {
  const got = m[k];
  const ok = typeof want === 'number' ? Math.abs(got - want) < 0.15 : got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${k}: js=${got} py=${want}`);
}
console.log(`\nphases: ${d.phases.map((p) => `${p.phase} ${p.mean_delta_c >= 0 ? '+' : ''}${p.mean_delta_c}`).join(' | ')}`);
console.log(`untuned phases: ${d.untuned.join(', ') || 'none'}`);
console.log(`zone coverage: ${d.zone_cover_s}s`);

const edited = applyEdits(profile, [
  { key: 'preheat_nominal_temperature', value: 248, why: 'test' },
  { key: 'preheat_nominal_temperature', value: 420, why: 'out of bounds' },
  { key: 'nope', value: 1, why: 'unknown' },
]);
console.log(`applied ${edited.applied.length}, rejected ${edited.rejected.map((r) => `${r.key}:${r.reason}`).join('; ')}`);
const serialized = serializeProfile(edited.profile);
console.log(`serialized keys: ${serialized.trim().split('\n').length} (profile has ${profile.order.length})`);
const brief = buildBrief(profile, log, ['flat', 'peanutty']);
console.log(`brief: ${brief.attributes.join('/')} | guide keys ${Object.keys(brief.symptom_guide).join(',')} | edit_surface ${brief.edit_surface.length}`);

if (failures) {
  console.error(`\n${failures} metric(s) differ from the Python implementation`);
  process.exit(1);
}
console.log('\nall metrics match the Python implementation');
