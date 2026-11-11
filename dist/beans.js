// Green-bean → profile edits, plus the bean identity that has to travel with the
// profile so a later .klog can be traced back to the coffee.
//
// The Nano's logs record profile_file_name / profile_short_name but nothing about
// the green bean, so the bean id is written into both: the file name and
// profile_short_name. That is the link the stock toolchain is missing.

import { editSurface } from './klt.js?v=39dec671ce';

export const BEAN_FIELDS = [
  ['id', 'bean id', 'text', 'short, goes into the log — e.g. GUJI-W-2601'],
  ['name', 'name', 'text', 'Guji 74110'],
  ['origin', 'origin', 'text', 'Ethiopia, Guji'],
  ['variety', 'variety', 'text', '74110, Heirloom'],
  ['process', 'process', 'select', 'washed | natural | honey | anaerobic'],
  ['altitude', 'altitude (m)', 'number', '2050'],
  ['density', 'density (g/L)', 'number', '695'],
  ['moisture', 'moisture (%)', 'number', '11.9'],
  ['load', 'load (g)', 'number', '100'],
  ['notes', 'nutty / fruity / floral…', 'text', 'free text'],
];

export const PROCESSES = ['washed', 'natural', 'honey', 'anaerobic', 'pulverised natural', 'other'];

export function slugId(bean, index = 1) {
  const base = (bean.name || bean.origin || 'bean').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9) || 'BEAN';
  const proc = (bean.process || 'x').trim().charAt(0).toUpperCase() || 'X';
  return `${base}-${proc}-${String(index).padStart(2, '0')}`.slice(0, 16);
}

/** Applies a single rule's edits to a delta map. */
function addDeltas(map, edits) {
  for (const [k, v] of Object.entries(edits || {})) {
    map[k] = (map[k] ?? 0) + v;
  }
}

function matches(rule, bean) {
  const w = rule.when;
  const raw = bean[w.field];
  if (raw === undefined || raw === null || raw === '') return false;
  if (w.in) return w.in.includes(String(raw).toLowerCase());
  const val = parseFloat(raw);
  if (!Number.isFinite(val)) return false;
  if (w.lt !== undefined) return val < w.lt;
  if (w.lte !== undefined) return val <= w.lte;
  if (w.gt !== undefined) return val > w.gt;
  if (w.gte !== undefined) return val >= w.gte;
  return false;
}

/**
 * Returns { edits: [{key, value, before, why}], notes: [string], skipped: [{key, why}] }
 * Smallest change that reflects the bean: each rule contributes a delta, deltas are
 * summed per key, then clamped into the profile's own bounds.
 */
export function suggestFromBean(bean, profile, heuristics) {
  const deltas = {};
  const notes = [];
  const sources = {};

  for (const rule of heuristics.rules) {
    if (!matches(rule, bean)) continue;
    addDeltas(deltas, rule.edits);
    notes.push(rule.why);
    for (const k of Object.keys(rule.edits)) (sources[k] ??= []).push(rule.id);
  }

  const ref = parseFloat(profile.kv.reference_load_size);
  const load = parseFloat(bean.load);
  if (Number.isFinite(ref) && Number.isFinite(load) && ref > 0 && load > 0 && Math.abs(load - ref) >= 3) {
    const perGram = heuristics.load;
    deltas.roast_required_power = (deltas.roast_required_power ?? 0) + (load - ref) * perGram.power_per_gram;
    deltas.preheat_nominal_temperature = (deltas.preheat_nominal_temperature ?? 0) + (load - ref) * perGram.preheat_per_gram;
    notes.push(`${load} g vs profile reference ${ref} g: ${heuristics.load.why}`);
    (sources.roast_required_power ??= []).push('load');
    (sources.preheat_nominal_temperature ??= []).push('load');
  }

  const bounds = Object.fromEntries(editSurface(profile.kv).map((e) => [e.key, e]));
  const edits = [];
  const skipped = [];
  for (const [key, delta] of Object.entries(deltas)) {
    const b = bounds[key];
    if (!b) {
      skipped.push({ key, why: `${key} is not a numeric key in this profile` });
      continue;
    }
    const wanted = Math.round((b.value + delta) * 100) / 100;
    const clamped = Math.min(b.max ?? wanted, Math.max(b.min ?? wanted, wanted));
    if (clamped === b.value) {
      skipped.push({ key, why: `already at the ${delta > 0 ? 'upper' : 'lower'} bound for ${key}` });
      continue;
    }
    edits.push({
      key,
      before: b.value,
      value: clamped,
      delta: Math.round((clamped - b.value) * 100) / 100,
      why: `${delta > 0 ? '+' : ''}${Math.round(delta * 100) / 100} from ${[...new Set(sources[key] ?? [])].join(', ')}`,
    });
  }
  edits.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { edits, notes, skipped };
}

/** The bean card that should be stored next to the profile. */
export function beanCard(bean, profileName) {
  return {
    kind: 'kaffelogic-bean',
    version: 1,
    id: bean.id,
    name: bean.name ?? null,
    origin: bean.origin ?? null,
    variety: bean.variety ?? null,
    process: bean.process ?? null,
    altitude_m: bean.altitude ? Number(bean.altitude) : null,
    density_g_per_l: bean.density ? Number(bean.density) : null,
    moisture_pct: bean.moisture ? Number(bean.moisture) : null,
    load_g: bean.load ? Number(bean.load) : null,
    notes: bean.notes ?? null,
    base_profile: profileName ?? null,
    created: new Date().toISOString().slice(0, 10),
  };
}
