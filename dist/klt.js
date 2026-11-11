// Pure text transforms for Kaffelogic Nano 7 .kpro / .klog files.
// No DOM, no fetch: usable from the browser and from node (see test.mjs).

export const NUM = /^-?\d+(\.\d+)?$/;
export const DRY_TEMP = 150.0;

// ---------------------------------------------------------------- .kpro

export function parseProfile(text) {
  const kv = {};
  const order = [];
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf(':');
    if (i < 0) continue;
    const k = raw.slice(0, i).trim();
    kv[k] = raw.slice(i + 1).trim();
    order.push(k);
  }
  return { kv, order };
}

export function serializeProfile({ kv, order }) {
  const keys = order.length ? order : Object.keys(kv);
  return keys.map((k) => `${k}:${kv[k]}`).join('\n') + '\n';
}

export function profileZones(kv) {
  const zones = [];
  for (let i = 1; i <= 7; i++) {
    const s = kv[`zone${i}_time_start`];
    const e = kv[`zone${i}_time_end`];
    if (s === undefined || e === undefined) continue;
    const start = parseFloat(s);
    const end = parseFloat(e);
    if (!(end > 0) && !(start > 0)) continue;
    zones.push({
      zone: i,
      start,
      end,
      kp: parseFloat(kv[`zone${i}_multiplier_Kp`] ?? 1) || 1,
      kd: parseFloat(kv[`zone${i}_multiplier_Kd`] ?? 1) || 1,
      boost: parseFloat(kv[`zone${i}_boost`] ?? 0) || 0,
    });
  }
  return zones;
}

export function zoneAt(zones, t) {
  return zones.find((z) => z.start <= t && t <= z.end) ?? null;
}

// Numeric guard rails by key shape, so an agent cannot write nonsense.
const BOUNDS = [
  [/_power$/, 0, 1500],
  [/temperature|_temp$|expect_fc|expect_colrchange/, 0, 300],
  [/multiplier_K[pid]/, 0.2, 3],
  [/zone\d+_time_(start|end)/, 0, 1200],
  [/roast_end_by_time_ratio/, 0.5, 1.5],
  [/roast_min_desired_rate_of_rise/, -5, 30],
  [/preheat_(min|max)_time|check_gradient_time/, 0, 300],
];

export function editSurface(kv) {
  const out = [];
  for (const [key, value] of Object.entries(kv)) {
    if (!NUM.test(value ?? '')) continue;
    let min = null;
    let max = null;
    for (const [re, lo, hi] of BOUNDS) {
      if (re.test(key)) {
        min = lo;
        max = hi;
        break;
      }
    }
    out.push({ key, value: parseFloat(value), min, max });
  }
  return out;
}

// ---------------------------------------------------------------- .klog

export function parseKlog(text) {
  const lines = text.split(/\r?\n/);
  const header = {};
  const markers = {};
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('time\t')) {
      idx = i;
      break;
    }
    if (l.startsWith('!')) {
      const j = l.indexOf(':');
      markers[l.slice(1, j).trim()] = l.slice(j + 1).trim();
      continue;
    }
    const j = l.indexOf(':');
    if (j > 0) header[l.slice(0, j).trim()] = l.slice(j + 1).trim();
  }
  if (idx < 0) throw new Error('no TSV header found');

  const columns = lines[idx].split('\t').map((c) => c.replace(/^[#=^]+/, ''));
  const rows = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('!')) {
      const j = l.indexOf(':');
      markers[l.slice(1, j).trim()] = l.slice(j + 1).trim();
      continue;
    }
    const f = l.split('\t');
    if (!f.length || !NUM.test(f[0] ?? 'x')) continue;
    const row = {};
    columns.forEach((name, c) => {
      const v = f[c];
      row[name] = v !== undefined && NUM.test(v) ? parseFloat(v) : null;
    });
    rows.push(row);
  }
  return { header, markers, columns, rows };
}

const fnum = (markers, key, dflt = null) => {
  const v = parseFloat(markers[key]);
  return Number.isFinite(v) ? v : dflt;
};
const col = (r, name) => (r?.[name] == null ? 0 : r[name]);

export function metrics(log) {
  const { header, markers, rows } = log;
  if (!rows.length) throw new Error('log has no rows');
  const end = fnum(markers, 'roast_end', rows[rows.length - 1].time);
  const fc = fnum(markers, 'first_crack', null);
  const roast = rows.filter((r) => r.time >= 0 && r.time <= end);
  const at = (t) => roast.reduce((a, b) => (Math.abs(b.time - t) < Math.abs(a.time - t) ? b : a));
  const dryRow = roast.find((r) => col(r, 'mean_temp') >= DRY_TEMP);
  const drop = at(end);
  const dev = fc == null ? null : end - fc;
  const ror = roast.filter((r) => r.time >= 15 && (fc == null || r.time < fc)).map((r) => col(r, 'actual_ROR'));
  const powers = roast.map((r) => col(r, 'power_kW'));
  const fans = roast.map((r) => r.actual_fan_RPM).filter((v) => v != null);
  const devs = roast.filter((r) => r.time > 20).map((r) => [r.time, col(r, 'mean_temp') - col(r, 'profile')]);
  const worst = devs.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a), devs[0] ?? [0, 0]);
  const rorStart = fc == null ? null : roast.filter((r) => r.time >= 15).sort((a, b) => Math.abs(a.time - 60) - Math.abs(b.time - 60))[0];

  return {
    profile: header.profile_short_name || header.profile_file_name || '-',
    level: header.roasting_level ?? null,
    mains: header.mains_voltage ?? null,
    firmware: header.firmware_version ?? null,
    charge_to_drop_s: round(end, 1),
    dry_s: dryRow ? round(dryRow.time, 1) : null,
    dry_pct: dryRow ? round((100 * dryRow.time) / end, 1) : null,
    first_crack_s: fc == null ? null : round(fc, 1),
    development_s: dev == null ? null : round(dev, 1),
    development_pct: fnum(markers, 'development_percent', dev == null ? null : round((100 * dev) / end, 2)),
    drop_temp: round(col(drop, 'mean_temp'), 1),
    drop_target: round(col(drop, 'profile'), 1),
    drop_delta: round(col(drop, 'mean_temp') - col(drop, 'profile'), 1),
    fc_temp: fc == null ? null : round(col(at(fc), 'mean_temp'), 1),
    expect_fc: header.expect_fc ?? null,
    ror: {
      start: rorStart ? round(col(rorStart, 'actual_ROR'), 1) : null,
      end: ror.length ? round(ror[ror.length - 1], 1) : null,
      min: ror.length ? round(Math.min(...ror), 1) : null,
      max: ror.length ? round(Math.max(...ror), 1) : null,
    },
    power: {
      mean: powers.length ? round(powers.reduce((a, b) => a + b, 0) / powers.length, 2) : null,
      max: powers.length ? round(Math.max(...powers), 2) : null,
      available: header.heater_power_available ?? null,
    },
    fan: { min: fans.length ? Math.round(Math.min(...fans)) : null, max: fans.length ? Math.round(Math.max(...fans)) : null },
    pid: {
      kp: [round(col(roast[0], 'Kp'), 3), round(col(roast[roast.length - 1], 'Kp'), 3)],
      ki: [round(col(roast[0], 'Ki'), 3), round(col(roast[roast.length - 1], 'Ki'), 3)],
      kd: [round(col(roast[0], 'Kd'), 3), round(col(roast[roast.length - 1], 'Kd'), 3)],
    },
    worst_deviation: { at_s: round(worst[0], 1), delta_c: round(worst[1], 1) },
    _roast: roast,
  };
}

export function phases(m) {
  const rows = m._roast;
  const fc = m.first_crack_s ?? m.charge_to_drop_s;
  const dry = m.dry_s ?? 0;
  const defs = [
    ['drying', 0, dry],
    ['maillard', dry, fc],
    ['development', fc, m.charge_to_drop_s],
  ];
  const out = [];
  for (const [name, lo, hi] of defs) {
    const devs = rows.filter((r) => r.time >= lo && r.time <= hi).map((r) => [r.time, col(r, 'mean_temp') - col(r, 'profile')]);
    if (!devs.length) continue;
    const mean = devs.reduce((a, b) => a + b[1], 0) / devs.length;
    const worst = devs.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
    out.push({
      phase: name,
      from_s: round(lo, 1),
      to_s: round(hi, 1),
      mean_delta_c: round(mean, 1),
      worst_delta_c: round(worst[1], 1),
      worst_at_s: round(worst[0], 1),
    });
  }
  return out;
}

export function diff(log, profile) {
  const m = metrics(log);
  const zones = profileZones(profile.kv);
  const ph = phases(m).map((p) => {
    const z = zoneAt(zones, p.worst_at_s);
    return { ...p, governed_by_zone: z ? `zone${z.zone} (Kp×${z.kp}, Kd×${z.kd})` : null };
  });
  return {
    metrics: m,
    phases: ph,
    untuned: ph.filter((p) => !p.governed_by_zone).map((p) => p.phase),
    zone_cover_s: zones.reduce((a, z) => a + (z.end - z.start), 0),
    zones,
  };
}

// ---------------------------------------------------------------- subjective

export const SYMPTOM_GUIDE = {
  flat: ['not enough energy in drying/Maillard; the curve sags early then chases', ['preheat_nominal_temperature:+', 'roast_required_power:+', 'add early zone Kp>1']],
  baked: ['long, low-energy Maillard phase — same signature as flat', ['preheat_nominal_temperature:+', 'roast_required_power:+', 'add early zone Kp>1']],
  peanutty: ['usually underdevelopment: pyrazines without enough sugar browning', ['verify expect_fc', 'preheat_nominal_temperature:+', 'longer development']],
  green: ['underdeveloped', ['verify expect_fc', 'preheat_nominal_temperature:+']],
  grassy: ['underdeveloped', ['verify expect_fc', 'preheat_nominal_temperature:+']],
  raw: ['underdeveloped', ['verify expect_fc', 'preheat_nominal_temperature:+']],
  sour: ['underdeveloped acidity', ['preheat_nominal_temperature:+', 'roast_end_by_time_ratio:-']],
  bitter: ['overdeveloped or scorched finish', ['roast_end_by_time_ratio:+', 'roast_required_power:-']],
  ashy: ['overdeveloped finish', ['roast_end_by_time_ratio:+', 'roast_required_power:-']],
  burnt: ['overdeveloped finish', ['roast_end_by_time_ratio:+', 'roast_required_power:-']],
  muddy: ['long finish, low energy into first crack', ['roast_min_desired_rate_of_rise:+', 'roast_required_power:+']],
  dull: ['flat rate of rise through development', ['roast_min_desired_rate_of_rise:+', 'roast_required_power:+']],
  hollow: ['fast rise then stall — energy pulled too early', ['roast_required_power:+', 'fan_profile:-']],
  smoky: ['too hot late', ['roast_required_power:-', 'zone*_multiplier_Kp:-']],
};

export function applyEdits(profile, edits) {
  const kv = { ...profile.kv };
  const bounds = Object.fromEntries(editSurface(kv).map((e) => [e.key, [e.min, e.max]]));
  const applied = [];
  const rejected = [];
  for (const e of edits) {
    if (!(e.key in kv)) {
      rejected.push({ ...e, reason: 'unknown key' });
      continue;
    }
    const val = parseFloat(e.value);
    if (!Number.isFinite(val)) {
      rejected.push({ ...e, reason: 'not numeric' });
      continue;
    }
    const [min, max] = bounds[e.key] ?? [null, null];
    if ((min != null && val < min) || (max != null && val > max)) {
      rejected.push({ ...e, reason: `outside ${min}..${max}` });
      continue;
    }
    const before = kv[e.key];
    kv[e.key] = `${val}`;
    applied.push({ key: e.key, before, after: kv[e.key], why: e.why ?? '' });
  }
  return { profile: { kv, order: profile.order }, applied, rejected };
}

export function buildBrief(profile, log, attrs = []) {
  const m = log ? metrics(log) : null;
  const zoneInfo = diff(log, profile);
  const attributes = attrs.map((a) => a.trim().toLowerCase()).filter(Boolean);
  return {
    kind: 'kaffelogic-brief',
    version: 1,
    profile: {
      name: profile.kv.profile_short_name,
      designer: profile.kv.profile_designer,
      level: profile.kv.recommended_level,
      load_g: profile.kv.reference_load_size,
      zones: profileZones(profile.kv),
      keys: profile.kv,
    },
    roast: m ? { ...m, _roast: undefined } : null,
    phases: zoneInfo.phases,
    untuned_phases: zoneInfo.untuned,
    attributes,
    symptom_guide: Object.fromEntries(attributes.filter((a) => a in SYMPTOM_GUIDE).map((a) => [a, { cause: SYMPTOM_GUIDE[a][0], levers: SYMPTOM_GUIDE[a][1] }])),
    edit_surface: editSurface(profile.kv),
    instructions: [
      'Propose edits as a JSON array: [{"key": <existing key>, "value": <number>, "why": "<one line>"}]',
      'Stay inside edit_surface min/max; prefer the smallest change addressing the named symptom.',
      'One or two keys per roast, so the next diff can attribute the effect.',
    ],
  };
}

function round(v, d = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}
