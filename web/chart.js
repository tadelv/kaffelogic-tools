// Hand-rolled SVG charts — no dependencies, drawn from the same parsed rows.
// Fixed viewBox coordinates so text stays legible when scaled to phone width.

const PAD = { l: 34, r: 8, t: 10, b: 16 };
const W = 360;

function path(points, xOf, yOf) {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (y == null || !Number.isFinite(y)) continue;
    d += `${d ? 'L' : 'M'}${xOf(x).toFixed(1)} ${yOf(y).toFixed(1)}`;
  }
  return d;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(4));
  return out;
}

/**
 * series: [{name, color, points: [[x, y]], dash, width}]
 * zones:  [{start, end, label}]
 * markers:[{x, label, color}]
 */
export function chart({ series, height = 120, yLabel = '', zones = [], markers = [], unit = '', xMax }) {
  const pts = series.flatMap((s) => s.points.filter((p) => Number.isFinite(p[1])));
  if (!pts.length) return '<p class="hint">no data</p>';

  const xEnd = xMax ?? Math.max(...pts.map((p) => p[0]));
  const ys = pts.map((p) => p[1]);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMax - yMin < 1e-6) {
    yMin -= 1;
    yMax += 1;
  }
  const padY = (yMax - yMin) * 0.08;
  yMin -= padY;
  yMax += padY;

  const xOf = (x) => PAD.l + ((x - 0) / (xEnd || 1)) * (W - PAD.l - PAD.r);
  const yOf = (y) => PAD.t + (1 - (y - yMin) / (yMax - yMin)) * (height - PAD.t - PAD.b);

  const out = [];
  out.push(`<svg viewBox="0 0 ${W} ${height}" class="chart" role="img" aria-label="${yLabel}">`);

  // tuning zones
  for (const z of zones) {
    const x0 = xOf(z.start);
    const x1 = xOf(Math.min(z.end, xEnd));
    if (x1 <= x0) continue;
    out.push(`<rect x="${x0.toFixed(1)}" y="${PAD.t}" width="${(x1 - x0).toFixed(1)}" height="${height - PAD.t - PAD.b}" fill="var(--zone)" />`);
    if (x1 - x0 > 22) {
      out.push(
        `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${height - PAD.b - 4}" class="axis zone-label" text-anchor="middle">${z.label}</text>`
      );
    }
  }

  // grid + y axis
  for (const t of niceTicks(yMin, yMax, 4)) {
    const y = yOf(t);
    out.push(`<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W - PAD.r}" y2="${y.toFixed(1)}" class="grid" />`);
    out.push(`<text x="${PAD.l - 3}" y="${(y + 3).toFixed(1)}" class="axis" text-anchor="end">${t}</text>`);
  }
  // x axis
  const stepX = xEnd > 480 ? 120 : xEnd > 240 ? 60 : 30;
  for (let t = 0; t <= xEnd; t += stepX) {
    const x = xOf(t);
    out.push(`<line x1="${x.toFixed(1)}" y1="${height - PAD.b}" x2="${x.toFixed(1)}" y2="${(height - PAD.b + 3).toFixed(1)}" class="grid" />`);
    out.push(`<text x="${x.toFixed(1)}" y="${height - 5}" class="axis" text-anchor="middle">${t}</text>`);
  }

  // markers
  for (const m of markers) {
    if (m.x == null) continue;
    const x = xOf(m.x);
    const nearEdge = x > W - PAD.r - 34;
    out.push(`<line x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${height - PAD.b}" class="marker" style="stroke:${m.color ?? 'var(--muted)'}" />`);
    out.push(
      `<text x="${(nearEdge ? x - 2 : x + 2).toFixed(1)}" y="${PAD.t + 9}" class="axis marker-label" text-anchor="${nearEdge ? 'end' : 'start'}">${m.label}</text>`
    );
  }

  for (const s of series) {
    out.push(
      `<path d="${path(s.points, xOf, yOf)}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.6}"` +
        `${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" />`
    );
  }
  out.push('</svg>');

  const legend =
    series.map((s) => `<span class="lg"><i style="background:${s.color}"></i>${s.name}</span>`).join('') +
    (unit ? `<span class="lg unit">${unit}</span>` : '');
  return `<div class="chart-wrap">${out.join('')}<div class="legend">${legend}</div></div>`;
}

/** Temperature chart with target overlay, plus RoR and power/fan strips. */
export function roastCharts(m, log, zones) {
  const rows = m._roast;
  const xMax = m.charge_to_drop_s;
  const temp = [
    { name: 'bean temp', color: 'var(--c1)', points: rows.map((r) => [r.time, r.mean_temp ?? r.temp]) },
    { name: 'target', color: 'var(--c2)', points: rows.map((r) => [r.time, r.profile]), dash: '3 3' },
  ];
  const ror = [
    { name: 'actual RoR', color: 'var(--c3)', points: rows.map((r) => [r.time, r.actual_ROR]) },
    { name: 'desired RoR', color: 'var(--c2)', points: rows.map((r) => [r.time, r.desired_ROR]), dash: '3 3' },
  ];
  const power = [
    { name: 'power kW', color: 'var(--c4)', points: rows.map((r) => [r.time, r.power_kW]), width: 1.3 },
    { name: 'fan (k RPM)', color: 'var(--c5)', points: rows.map((r) => [r.time, r.actual_fan_RPM == null ? null : r.actual_fan_RPM / 1000]), width: 1.1 },
  ];
  const marks = [
    { x: m.dry_s, label: 'dry' },
    { x: m.first_crack_s, label: 'FC', color: 'var(--bad)' },
    { x: xMax, label: 'drop', color: 'var(--accent)' },
  ];
  const zoneBands = zones.map((z) => ({ start: z.start, end: z.end, label: `zone${z.zone}` }));

  return (
    `<div class="chart-block">${chart({ series: temp, height: 150, yLabel: 'temperature', unit: '°C', zones: zoneBands, markers: marks, xMax })}</div>` +
    `<div class="chart-block">${chart({ series: ror, height: 92, unit: '°C/min', markers: marks, xMax })}</div>` +
    `<div class="chart-block">${chart({ series: power, height: 92, unit: 'kW / kRPM', markers: marks, xMax })}</div>`
  );
}

/** Without a log: the profile's structure — zone windows and expectation marks. */
export function profileSchematic(kv, zones) {
  if (!zones.length) {
    return '<p class="hint">This profile declares no tuning zones, so the PID multipliers apply flat across the roast.</p>';
  }
  const end = Math.max(...zones.map((z) => z.end), 60);
  const bands = zones.map((z) => ({ start: z.start, end: z.end, label: `zone${z.zone} Kp×${z.kp}` }));
  const series = [{ name: 'declared coverage', color: 'var(--c1)', points: [[0, 0], [end, 0]] }];
  return chart({ series, height: 78, yLabel: 'profile zones', unit: 'seconds', zones: bands, xMax: end });
}
