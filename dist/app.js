import {
  parseProfile, serializeProfile, parseKlog, metrics, phases, diff,
  applyEdits, buildBrief, editSurface, profileZones, SYMPTOM_GUIDE,
} from './klt.js?v=39dec671ce';
import { roastCharts, profileSchematic } from './chart.js?v=39dec671ce';

const $ = (id) => document.getElementById(id);
const state = { log: null, logName: '', profile: null, profileName: '', attrs: new Set() };

// Keys surfaced in the UI — the ones that actually move the curve.
const EDIT_KEYS = [
  ['preheat_nominal_temperature', 'drum start temperature'],
  ['preheat_power', 'preheat heater power'],
  ['roast_required_power', 'roast power ceiling'],
  ['roast_min_desired_rate_of_rise', 'RoR floor'],
  ['expect_fc', 'expected first crack'],
  ['roast_end_by_time_ratio', 'drop trigger ratio'],
  ['zone1_multiplier_Kp', 'zone1 Kp'],
  ['zone2_multiplier_Kp', 'zone2 Kp'],
];

// Directional nudges for the taste attributes. Deliberately small: one roast
// should be able to attribute the effect.
const NUDGES = {
  'preheat_nominal_temperature:+': { key: 'preheat_nominal_temperature', delta: 8 },
  'roast_required_power:+': { key: 'roast_required_power', delta: 100 },
  'roast_required_power:-': { key: 'roast_required_power', delta: -100 },
  'roast_min_desired_rate_of_rise:+': { key: 'roast_min_desired_rate_of_rise', delta: 2 },
  'roast_end_by_time_ratio:+': { key: 'roast_end_by_time_ratio', delta: 0.05 },
  'roast_end_by_time_ratio:-': { key: 'roast_end_by_time_ratio', delta: -0.05 },
  'zone*_multiplier_Kp:-': { key: 'zone1_multiplier_Kp', delta: -0.1 },
};

function warn(msg) {
  const el = $('warn');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function readFile(file) {
  return await file.text();
}

async function loadLog(file) {
  const text = await readFile(file);
  try {
    state.log = parseKlog(text);
    state.logName = file.name;
    $('logName').textContent = `${file.name} — ${state.log.rows.length} samples`;
    warn('');
    render();
  } catch (err) {
    warn(`Could not read ${file.name}: ${err.message}`);
  }
}

async function loadProfile(file) {
  const text = await readFile(file);
  try {
    state.profile = parseProfile(text);
    state.profileName = file.name;
    $('profileName').textContent = `${file.name} — ${state.profile.order.length} keys`;
    warn('');
    render();
  } catch (err) {
    warn(`Could not read ${file.name}: ${err.message}`);
  }
}

function table(rows, head) {
  const thead = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr>${r.map((c) => `<td class="${typeof c === 'object' ? c.cls : ''}">${typeof c === 'object' ? c.text : c}</td>`).join('')}</tr>`).join('');
  return `<thead>${thead}</thead><tbody>${body}</tbody>`;
}

const sign = (v) => (v > 0 ? { text: `+${v}`, cls: 'num pos' } : v < 0 ? { text: `${v}`, cls: 'num neg' } : { text: '0', cls: 'num' });
const num = (v, suffix = '') => ({ text: v == null ? '–' : `${v}${suffix}`, cls: 'num' });

function render() {
  if (!state.log) {
    renderProfileOnly();
    return;
  }
  const m = metrics(state.log);
  $('summary').classList.remove('hidden');
  $('chartSection').classList.remove('hidden');
  const zones = state.profile ? profileZones(state.profile.kv) : [];
  $('charts').innerHTML = roastCharts(m, state.log, zones);
  $('summaryTable').innerHTML = table(
    [
      ['profile', m.profile, m.level ? `level ${m.level}` : ''],
      ['charge → drop', num(m.charge_to_drop_s, ' s'), ''],
      ['drying', num(m.dry_s, ' s'), m.dry_pct != null ? `${m.dry_pct}%` : ''],
      ['first crack', num(m.first_crack_s, ' s'), m.fc_temp != null ? `${m.fc_temp} °C` : ''],
      ['development', num(m.development_s, ' s'), m.development_pct != null ? `${m.development_pct}% DTR` : ''],
      ['drop', num(m.drop_temp, ' °C'), sign(m.drop_delta)],
      ['RoR pre-FC', num(m.ror.start, ' → '), m.ror.end != null ? `${m.ror.end} °C/min` : ''],
      ['power', num(m.power.mean, ' kW avg'), m.power.max != null ? `${m.power.max} kW peak` : ''],
      ['fan', num(m.fan.min, '–'), m.fan.max != null ? `${m.fan.max} RPM` : ''],
      ['PID', `Kp ${m.pid.kp[0]}→${m.pid.kp[1]}`, `Ki ${m.pid.ki[0]} · Kd ${m.pid.kd[0]}→${m.pid.kd[1]}`],
      ['worst tracking', sign(m.worst_deviation.delta_c), `${m.worst_deviation.at_s} s`],
    ],
    ['', '', '']
  );

  // taste chips are useful as soon as a log is loaded
  $('tasteSection').classList.remove('hidden');
  const chips = $('chips');
  if (!chips.childElementCount) {
    for (const key of Object.keys(SYMPTOM_GUIDE)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = key;
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => {
        if (state.attrs.has(key)) state.attrs.delete(key); else state.attrs.add(key);
        b.setAttribute('aria-pressed', state.attrs.has(key) ? 'true' : 'false');
        renderEditNote();
        render();
      };
      li.appendChild(b);
      chips.appendChild(li);
    }
  }

  if (!state.profile) {
    $('phaseSection').classList.add('hidden');
    $('editSection').classList.add('hidden');
    return;
  }
  const d = diff(state.log, state.profile);
  $('phaseSection').classList.remove('hidden');
  $('phaseTable').innerHTML = table(
    d.phases.map((p) => [
      p.phase,
      `${p.from_s}–${p.to_s} s`,
      sign(p.mean_delta_c),
      sign(p.worst_delta_c),
      p.governed_by_zone ?? 'nothing (flat multipliers)',
    ]),
    ['phase', 'window', 'mean Δ', 'worst Δ', 'governed by']
  );
  $('phaseNote').textContent = d.untuned.length
    ? `Error in ${d.untuned.join(' and ')} sits outside any tuning zone — zone multipliers cannot fix it; the energy keys below can.`
    : `Every phase is inside a tuning zone.`;

  renderEditRows();
  $('editSection').classList.remove('hidden');
  renderEditNote();
}

function renderProfileOnly() {
  if (!state.profile) return;
  const zones = profileZones(state.profile.kv);
  $('chartSection').classList.remove('hidden');
  $('charts').innerHTML = profileSchematic(state.profile.kv, zones);
}

function renderEditRows() {
  const surface = Object.fromEntries(editSurface(state.profile.kv).map((e) => [e.key, e]));
  const host = $('editRows');
  host.innerHTML = '';
  for (const [key, hint] of EDIT_KEYS) {
    if (!(key in state.profile.kv)) continue;
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.style.flex = '1';
    label.innerHTML = `<span>${hint}</span><br><span class="hint">${key}</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = surface[key]?.min === 0 && surface[key]?.max >= 100 ? '1' : '0.01';
    input.value = state.profile.kv[key];
    input.dataset.key = key;
    input.oninput = renderEditNote;
    row.appendChild(label);
    row.appendChild(input);
    host.appendChild(row);
  }
}

function currentEdits() {
  const out = [];
  for (const input of $('editRows').querySelectorAll('input[data-key]')) {
    const key = input.dataset.key;
    const base = parseFloat(state.profile.kv[key]);
    const val = parseFloat(input.value);
    if (Number.isFinite(val) && Math.abs(val - base) > 1e-9) out.push({ key, value: val, why: 'manual' });
  }
  return out;
}

function renderEditNote() {
  const note = $('editNote');
  const edits = currentEdits();
  const attrs = [...state.attrs];
  const causes = attrs.filter((a) => a in SYMPTOM_GUIDE).map((a) => `${a}: ${SYMPTOM_GUIDE[a][0]}`);
  const hints = attrs.flatMap((a) => (SYMPTOM_GUIDE[a] ? SYMPTOM_GUIDE[a][1] : []));
  const parts = [];
  if (causes.length) parts.push(causes.join(' · '));
  if (hints.length) parts.push(`levers: ${[...new Set(hints)].join(', ')}`);
  parts.push(edits.length ? `${edits.length} key(s) changed — download writes a new file, nothing is overwritten` : 'change a value to enable download');
  note.textContent = parts.join(' — ');
  $('downloadBtn').disabled = edits.length === 0;
}

function download() {
  const edits = currentEdits();
  const { profile, applied, rejected } = applyEdits(state.profile, edits);
  if (rejected.length) warn(`Rejected: ${rejected.map((r) => `${r.key} (${r.reason})`).join(', ')}`);
  const text = serializeProfile(profile);
  const name = state.profileName.replace(/\.kpro$/i, '') + '-edit.kpro';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  $('editNote').textContent = `wrote ${name}: ${applied.map((x) => `${x.key} ${x.before}→${x.after}`).join(', ')}`;
}

async function copyBrief() {
  const brief = buildBrief(state.profile, state.log, [...state.attrs]);
  brief.notes = $('comment').value.trim() || null;
  brief.proposed_edits = currentEdits();
  const text = JSON.stringify(brief, null, 2);
  const pre = $('briefOut');
  pre.textContent = text;
  pre.classList.remove('hidden');
  try {
    await navigator.clipboard.writeText(text);
    $('editNote').textContent = 'brief copied to clipboard — paste it to your agent along with the tasting notes';
  } catch {
    $('editNote').textContent = 'clipboard blocked — select the JSON below and copy manually';
  }
}

// ---------------------------------------------------------------- wiring

function wireDrop(sectionId, inputId, handler) {
  const section = $(sectionId);
  const input = $(inputId);
  input.onchange = () => input.files[0] && handler(input.files[0]);
  ['dragenter', 'dragover'].forEach((e) => section.addEventListener(e, (ev) => { ev.preventDefault(); section.classList.add('active'); }));
  ['dragleave', 'drop'].forEach((e) => section.addEventListener(e, (ev) => { ev.preventDefault(); section.classList.remove('active'); }));
  section.addEventListener('drop', (ev) => {
    const f = ev.dataTransfer?.files?.[0];
    if (f) handler(f);
  });
}

wireDrop('logDrop', 'logInput', loadLog);
wireDrop('profileDrop', 'profileInput', loadProfile);
$('downloadBtn').onclick = download;
$('briefBtn').onclick = copyBrief;
$('comment').oninput = renderEditNote;
