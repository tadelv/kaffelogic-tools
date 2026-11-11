import { parseProfile, serializeProfile, editSurface } from './klt.js?v=39dec671ce';
import { BEAN_FIELDS, PROCESSES, slugId, suggestFromBean, beanCard } from './beans.js?v=39dec671ce';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'kaffelogic-beans';
const state = { profile: null, profileName: '', heuristics: null, bean: {}, edits: [], idTouched: false };

// ---------------------------------------------------------------- fields

function buildFields() {
  const host = $('beanFields');
  host.innerHTML = '';
  for (const [key, label, type, placeholder] of BEAN_FIELDS) {
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label');
    lab.style.flex = '1';
    lab.innerHTML = `<span>${label}</span>`;

    let input;
    if (type === 'select') {
      input = document.createElement('select');
      for (const p of PROCESSES) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = type;
      if (type === 'number') input.step = 'any';
    }
    input.id = `bean-${key}`;
    input.placeholder = placeholder;
    input.oninput = () => {
      if (key === 'id') state.idTouched = true;
      onBeanChange();
    };
    input.onchange = input.oninput;
    row.appendChild(lab);
    row.appendChild(input);
    host.appendChild(row);
  }
}

function readBean() {
  const bean = {};
  for (const [key] of BEAN_FIELDS) {
    const el = $(`bean-${key}`);
    if (el) bean[key] = el.value.trim();
  }
  return bean;
}

function onBeanChange() {
  const bean = readBean();
  if (!state.idTouched) {
    bean.id = slugId(bean, library().length + 1);
    const el = $('bean-id');
    if (el) el.value = bean.id;
  }
  state.bean = bean;
  $('beanIdHint').textContent = bean.id
    ? `bean id "${bean.id}" goes into profile_short_name and the file name — that is what the log will show`
    : '';
  $('suggestBtn').disabled = !(state.profile && bean.id);
  renderSuggestions();
}

// ---------------------------------------------------------------- suggestions

function renderSuggestions() {
  if (!state.profile || !state.bean.id) {
    $('suggestSection').classList.add('hidden');
    return;
  }
  const { edits, notes, skipped } = suggestFromBean(state.bean, state.profile, state.heuristics);
  state.edits = edits;

  $('suggestSection').classList.remove('hidden');
  const host = $('suggestRows');
  host.innerHTML = '';
  if (!edits.length) {
    host.innerHTML = '<p class="hint">No rule fired: this bean matches the profile’s assumptions, so roast it as-is.</p>';
  }
  for (const e of edits) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label style="flex:1"><span>${e.key}</span><br><span class="hint">${e.why}</span></label>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    const snap = Math.abs(e.value) >= 100 ? Math.round(e.value) : Math.round(e.value * 10) / 10;
    e.value = snap;
    input.value = snap;
    input.dataset.key = e.key;
    input.dataset.before = e.before;
    input.oninput = () => {
      e.value = parseFloat(input.value);
      updateOutputs();
    };
    row.appendChild(input);
    host.appendChild(row);
  }
  $('suggestNotes').textContent = notes.join(' · ') + (skipped.length ? ` — skipped: ${skipped.map((s) => s.key).join(', ')}` : '');
  updateOutputs();
}

function currentEdits() {
  return state.edits
    .filter((e) => Number.isFinite(e.value) && Math.abs(e.value - e.before) > 1e-9)
    .map((e) => ({ key: e.key, value: e.value, why: e.why }));
}

// ---------------------------------------------------------------- output

function beanSummary(bean) {
  return [bean.name, bean.origin, bean.variety, bean.process, bean.altitude && `${bean.altitude}m`,
    bean.density && `${bean.density} g/L`, bean.moisture && `${bean.moisture}%`, bean.load && `${bean.load} g`]
    .filter(Boolean)
    .join(' · ');
}

function buildProfile() {
  const kv = { ...state.profile.kv };
  for (const e of currentEdits()) kv[e.key] = `${e.value}`;
  kv.profile_short_name = state.bean.id;
  kv.profile_description = `${state.bean.id} — ${beanSummary(state.bean)}${state.bean.notes ? ` — ${state.bean.notes}` : ''}`;
  if (state.bean.origin) {
    // keep the provenance machine-readable for the CLI and for grepping logs
    kv.bean_origin = state.bean.origin;
    kv.bean_process = state.bean.process ?? '';
  }
  return { kv, order: state.profile.order };
}

function fileName() {
  const base = (state.profileName || 'profile').replace(/\.kpro$/i, '');
  return `${state.bean.id}_${base}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) + '.kpro';
}

function updateOutputs() {
  const edits = currentEdits();
  $('downloadBtn').disabled = !state.profile;
  $('cardBtn').disabled = !state.profile;
  $('resultNote').textContent = edits.length
    ? `${edits.length} key(s) changed · file ${fileName()} · short name ${state.bean.id}`
    : `no keys changed · file ${fileName()} carries the bean id only`;
}

function save(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- library

function library() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveBean() {
  const bean = readBean();
  if (!bean.id) return;
  const all = library().filter((b) => b.id !== bean.id);
  all.push(beanCard(bean, state.profileName));
  localStorage.setItem(LS_KEY, JSON.stringify(all));
  $('resultNote').textContent = `saved ${bean.id} to the bean library (${all.length} beans on this device)`;
}

function loadBean() {
  const all = library();
  if (!all.length) {
    $('resultNote').textContent = 'the bean library is empty on this device';
    return;
  }
  const id = prompt(`Load which bean?\n\n${all.map((b) => b.id).join('\n')}`);
  const bean = all.find((b) => b.id === id);
  if (!bean) return;
  for (const [key] of BEAN_FIELDS) {
    const el = $(`bean-${key}`);
    if (!el) continue;
    const v = bean[key === 'altitude' ? 'altitude_m' : key === 'density' ? 'density_g_per_l' : key === 'moisture' ? 'moisture_pct' : key === 'load' ? 'load_g' : key];
    if (v != null) el.value = v;
  }
  onBeanChange();
}

// ---------------------------------------------------------------- wiring

async function loadProfile(file) {
  state.profile = parseProfile(await file.text());
  state.profileName = file.name;
  $('profileName').textContent = `${file.name} — reference load ${state.profile.kv.reference_load_size || '?'} g, ${state.profile.order.length} keys`;
  onBeanChange();
}

function init() {
  buildFields();
  const drop = $('profileDrop');
  const input = $('profileInput');
  input.onchange = () => input.files[0] && loadProfile(input.files[0]);
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('active'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('active'); }));
  drop.addEventListener('drop', (ev) => {
    const f = ev.dataTransfer?.files?.[0];
    if (f) loadProfile(f);
  });

  $('suggestBtn').onclick = renderSuggestions;
  $('saveBean').onclick = saveBean;
  $('loadBean').onclick = loadBean;
  $('downloadBtn').onclick = () => save(fileName(), serializeProfile(buildProfile()));
  $('cardBtn').onclick = () => save(`${state.bean.id}.bean.json`,
    JSON.stringify({ ...beanCard(state.bean, state.profileName), base_profile: state.profileName, edits: currentEdits() }, null, 2),
    'application/json');

  fetch('./heuristics.json?v=39dec671ce')
    .then((r) => r.json())
    .then((h) => {
      state.heuristics = h;
      onBeanChange();
    })
    .catch(() => {
      $('beanIdHint').textContent = 'could not load heuristics.json — suggestions disabled';
    });

  // sensible defaults so the page is usable in one tap
  $('bean-load').value = '100';
  $('bean-altitude').value = '2000';
  $('bean-density').value = '700';
  $('bean-moisture').value = '11';
}

init();
