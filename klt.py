#!/usr/bin/env python3
"""
kaffelogic-tools — read, analyse and edit Kaffelogic Nano 7 roast profiles and logs.

Formats (both plain text, no vendor tooling needed):
  .kpro  key:value lines. 60 keys: preheat, roast power, PID zone multipliers,
         expected first-crack, fan control points.
  .klog  key:value header, then TSV rows (letters in the column name carry
         #=^ prefixes), plus !marker:value event lines.

Commands:
  inspect <profile.kpro>              profile parameters, zones, fan points
  roast <log.klog>                    roast metrics
  diff <log.klog> <profile.kpro>      deviation per phase + the keys that govern it
  scan <dir-or-glob>                  one line per log
  edit <profile.kpro> --set k=v ...   write an edited copy + change note

Every command takes --json for agent consumption.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys

NUM = re.compile(r"^-?\d+(?:\.\d+)?$")

DRY_TEMP = 150.0  # Kaffelogic convention for the dry/end-of-drying milestone


# ---------------------------------------------------------------- .kpro


def parse_profile(path):
    if not os.path.exists(path):
        sys.exit(f"no such profile: {path}")
    kv = {}
    order = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if ":" not in line:
                continue
            k, _, v = line.partition(":")
            kv[k.strip()] = v.strip()
            order.append(k.strip())
    return kv


def profile_zones(kv):
    """Tuning zones: time windows in seconds with Kp/Kd multipliers."""
    zones = []
    for i in range(1, 8):
        start = kv.get(f"zone{i}_time_start")
        end = kv.get(f"zone{i}_time_end")
        if start is None or end is None:
            continue
        s, e = float(start), float(end)
        if e <= 0 and s <= 0:
            continue
        zones.append(
            {
                "zone": i,
                "start": s,
                "end": e,
                "kp": float(kv.get(f"zone{i}_multiplier_Kp", 1) or 1),
                "kd": float(kv.get(f"zone{i}_multiplier_Kd", 1) or 1),
                "boost": float(kv.get(f"zone{i}_boost", 0) or 0),
            }
        )
    return zones


GOVERNING = [
    ("preheat_nominal_temperature", "drum start temperature"),
    ("preheat_power", "preheat heater power"),
    ("preheat_min_time", "preheat minimum duration"),
    ("preheat_max_time", "preheat maximum duration"),
    ("roast_required_power", "heater power ceiling during the roast"),
    ("roast_min_desired_rate_of_rise", "ROR floor the loop aims for"),
    ("roast_target_in_future", "how far ahead the target curve is projected"),
    ("expect_fc", "first-crack temperature used by the loop"),
    ("reference_load_size", "load the profile was designed for"),
    ("fan_profile", "fan control points"),
]


def zone_at(zones, t):
    for z in zones:
        if z["start"] <= t <= z["end"]:
            return z
    return None


# ---------------------------------------------------------------- .klog


def parse_klog(path):
    if not os.path.exists(path):
        sys.exit(f"no such log: {path}")
    header, markers, columns, rows = {}, {}, [], []
    with open(path, encoding="utf-8", errors="replace") as fh:
        lines = fh.read().splitlines()

    i = 0
    for i, line in enumerate(lines):
        if line.startswith("time\t"):
            break
        if line.startswith("!"):
            k, _, v = line[1:].partition(":")
            markers[k.strip()] = v.strip()
            continue
        if ":" in line:
            k, _, v = line.partition(":")
            header[k.strip()] = v.strip()
    else:
        sys.exit(f"{path}: no TSV header found")

    columns = [c.lstrip("#=^") for c in lines[i].split("\t")]
    for line in lines[i + 1 :]:
        if line.startswith("!"):
            k, _, v = line[1:].partition(":")
            markers[k.strip()] = v.strip()
            continue
        fields = line.split("\t")
        if not fields or not NUM.match(fields[0] or "x"):
            continue
        row = {}
        for name, val in zip(columns, fields):
            row[name] = float(val) if NUM.match(val or "x") else None
        rows.append(row)
    return {"header": header, "markers": markers, "columns": columns, "rows": rows}


def _f(markers, key, default=None):
    try:
        return float(markers[key])
    except (KeyError, TypeError, ValueError):
        return default


def metrics(log):
    header, markers, rows = log["header"], log["markers"], log["rows"]
    end = _f(markers, "roast_end", rows[-1]["time"] if rows else 0.0)
    fc = _f(markers, "first_crack")
    roast_rows = [r for r in rows if 0 <= (r["time"] or 0) <= end]
    if not roast_rows:
        sys.exit("log has no rows inside the roast window")

    def row_at(t):
        return min(roast_rows, key=lambda r: abs((r["time"] or 0) - t))

    def col(r, name):
        v = r.get(name)
        return v if v is not None else 0.0

    dry = next((r["time"] for r in roast_rows if col(r, "mean_temp") >= DRY_TEMP), None)
    drop = row_at(end)
    dev = (end - fc) if fc is not None else None
    # ignore the first seconds: charge-up transients make ROR meaningless there
    ror_pre = [col(r, "actual_ROR") for r in roast_rows
               if 15 <= (r["time"] or 0) and (fc is None or (r["time"] or 0) < fc)]
    powers = [col(r, "power_kW") for r in roast_rows]
    fans = [col(r, "actual_fan_RPM") for r in roast_rows if r.get("actual_fan_RPM")]
    devs = [((r["time"] or 0), col(r, "mean_temp") - col(r, "profile")) for r in roast_rows if (r["time"] or 0) > 20]

    return {
        "file": os.path.basename(log.get("path", "")),
        "profile": header.get("profile_short_name") or header.get("profile_file_name") or "-",
        "level": header.get("roasting_level"),
        "mains": header.get("mains_voltage"),
        "firmware": header.get("firmware_version"),
        "charge_to_drop_s": round(end, 1),
        "dry_s": None if dry is None else round(dry, 1),
        "dry_pct": None if dry is None else round(100 * dry / end, 1),
        "first_crack_s": None if fc is None else round(fc, 1),
        "development_s": None if dev is None else round(dev, 1),
        "development_pct": _f(markers, "development_percent", None if dev is None else round(100 * dev / end, 2)),
        "drop_temp": round(col(drop, "mean_temp"), 1),
        "drop_target": round(col(drop, "profile"), 1),
        "drop_delta": round(col(drop, "mean_temp") - col(drop, "profile"), 1),
        "fc_temp": None if fc is None else round(col(row_at(fc), "mean_temp"), 1),
        "expect_fc": header.get("expect_fc"),
        "ror_pre_fc": {
            "start": None if not ror_pre else round(
                min(((abs((r["time"] or 0) - 60), col(r, "actual_ROR")) for r in roast_rows
                     if 15 <= (r["time"] or 0)), key=lambda x: x[0])[1], 1),
            "end": round(ror_pre[-1], 1) if ror_pre else None,
            "min": round(min(ror_pre), 1) if ror_pre else None,
            "max": round(max(ror_pre), 1) if ror_pre else None,
        },
        "power_kw": {
            "mean": round(sum(powers) / len(powers), 2) if powers else None,
            "max": round(max(powers), 2) if powers else None,
            "available": header.get("heater_power_available"),
        },
        "fan_rpm": {"min": round(min(fans)) if fans else None, "max": round(max(fans)) if fans else None},
        "pid": {
            "kp": [round(col(roast_rows[0], "Kp"), 3), round(col(roast_rows[-1], "Kp"), 3)],
            "ki": [round(col(roast_rows[0], "Ki"), 3), round(col(roast_rows[-1], "Ki"), 3)],
            "kd": [round(col(roast_rows[0], "Kd"), 3), round(col(roast_rows[-1], "Kd"), 3)],
        },
        "worst_deviation": None
        if not devs
        else {
            "at_s": round(max(devs, key=lambda d: abs(d[1]))[0], 1),
            "delta_c": round(max(devs, key=lambda d: abs(d[1]))[1], 1),
        },
        "_rows": roast_rows,
    }


def phases(m):
    """Phase boundaries in seconds, with the deviation stats inside each."""
    rows = m["_rows"]
    fc = m["first_crack_s"] or m["charge_to_drop_s"]
    dry = m["dry_s"] or 0.0
    out = []
    for name, lo, hi in (("drying", 0.0, dry), ("maillard", dry, fc), ("development", fc, m["charge_to_drop_s"])):
        devs = [((r["time"] or 0), (r.get("mean_temp") or 0) - (r.get("profile") or 0)) for r in rows if lo <= (r["time"] or 0) <= hi]
        if not devs:
            continue
        out.append(
            {
                "phase": name,
                "from_s": round(lo, 1),
                "to_s": round(hi, 1),
                "mean_delta_c": round(sum(d for _, d in devs) / len(devs), 1),
                "worst_delta_c": round(max(devs, key=lambda d: abs(d[1]))[1], 1),
                "worst_at_s": round(max(devs, key=lambda d: abs(d[1]))[0], 1),
            }
        )
    return out


# ---------------------------------------------------------------- commands


def cmd_inspect(args):
    kv = parse_profile(args.profile)
    zones = profile_zones(kv)
    data = {
        "file": os.path.basename(args.profile),
        "name": kv.get("profile_short_name"),
        "designer": kv.get("profile_designer"),
        "schema": kv.get("profile_schema_version"),
        "recommended_level": kv.get("recommended_level"),
        "reference_load_size": kv.get("reference_load_size"),
        "expect_fc": kv.get("expect_fc"),
        "expect_colour_change": kv.get("expect_colrchange"),
        "preheat": {k: kv.get(k) for k in sorted(kv) if k.startswith("preheat_")},
        "roast_power": kv.get("roast_required_power"),
        "ror_floor": kv.get("roast_min_desired_rate_of_rise"),
        "zones": zones,
        "keys_total": len(kv),
    }
    if args.json:
        print(json.dumps(data, indent=2))
        return
    print(f"{data['file']}  ({data['keys_total']} keys)")
    print(f"  profile        {data['name']} by {data['designer']} (schema {data['schema']})")
    print(f"  load/level     {data['reference_load_size']} g, recommended level {data['recommended_level']}")
    print(f"  expect_fc      {data['expect_fc']} °C   colour change {data['expect_colour_change']} °C")
    print(f"  preheat        {data['preheat'].get('preheat_nominal_temperature')} °C nominal, {data['preheat'].get('preheat_power')} W")
    print(f"  roast power    {data['roast_power']} W ceiling, ROR floor {data['ror_floor']}")
    if zones:
        print("  tuning zones")
        for z in zones:
            print(
                f"    zone{z['zone']}  {z['start']:6.0f}–{z['end']:6.0f} s   "
                f"Kp×{z['kp']:.2f}  Kd×{z['kd']:.2f}  boost {z['boost']:.1f}"
            )
        covered = sum(z["end"] - z["start"] for z in zones)
        print(f"    → {covered:.0f} s of the roast is inside a tuning zone")
    else:
        print("  tuning zones   none — flat PID multipliers for the whole roast")


def cmd_roast(args):
    log = parse_klog(args.log)
    log["path"] = args.log
    m = metrics(log)
    m.pop("_rows", None)
    if args.json:
        print(json.dumps(m, indent=2))
        return
    print(f"{m['file']} — {m['profile']} (level {m['level']}, firmware {m['firmware']})")
    print(f"  charge→drop  {m['charge_to_drop_s']:.0f} s   dry {m['dry_s']} s ({m['dry_pct']}%)")
    print(f"  first crack  {m['first_crack_s']} s at {m['fc_temp']} °C (expect_fc {m['expect_fc']})")
    print(f"  development  {m['development_s']} s = {m['development_pct']}% DTR")
    print(f"  drop         {m['drop_temp']} °C vs target {m['drop_target']} °C  ({m['drop_delta']:+.1f})")
    r = m["ror_pre_fc"]
    print(f"  ROR pre-FC   {r['start']} → {r['end']} C/min  (min {r['min']}, max {r['max']})")
    p = m["power_kw"]
    print(f"  power        mean {p['mean']} kW, peak {p['max']} of {p['available']} W available")
    print(f"  fan          {m['fan_rpm']['min']}–{m['fan_rpm']['max']} RPM")
    pid = m["pid"]
    print(f"  PID          Kp {pid['kp'][0]}→{pid['kp'][1]}  Ki {pid['ki'][0]}→{pid['ki'][1]}  Kd {pid['kd'][0]}→{pid['kd'][1]}")
    w = m["worst_deviation"]
    if w:
        print(f"  worst track  {w['delta_c']:+.1f} °C at {w['at_s']:.0f} s")


def cmd_diff(args):
    kv = parse_profile(args.profile)
    zones = profile_zones(kv)
    log = parse_klog(args.log)
    log["path"] = args.log
    m = metrics(log)
    ph = phases(m)
    report = {
        "log": os.path.basename(args.log),
        "profile": os.path.basename(args.profile),
        "phases": [],
        "untuned_windows": [],
    }
    for p in ph:
        z = zone_at(zones, p["worst_at_s"])
        p["governed_by_zone"] = None if z is None else f"zone{z['zone']} (Kp×{z['kp']:.2f}, Kd×{z['kd']:.2f})"
        report["phases"].append(p)
        if z is None:
            report["untuned_windows"].append({"phase": p["phase"], "worst_at_s": p["worst_at_s"]})
    report["suggested_keys"] = [
        {"key": k, "why": why, "current": kv.get(k)} for k, why in GOVERNING if kv.get(k) is not None
    ]

    if args.json:
        print(json.dumps(report, indent=2))
        return
    print(f"{report['log']} vs {report['profile']}")
    print(f"  {'phase':12s} {'window':>13s} {'mean Δ':>8s} {'worst Δ':>8s}  governed by")
    for p in report["phases"]:
        print(
            f"  {p['phase']:12s} {p['from_s']:5.0f}–{p['to_s']:5.0f}s "
            f"{p['mean_delta_c']:+7.1f} {p['worst_delta_c']:+7.1f}  {p['governed_by_zone'] or 'nothing (flat multipliers)'}"
        )
    if report["untuned_windows"]:
        print("\n  biggest error sits outside any tuning zone — these keys govern it:")
        for s in report["suggested_keys"]:
            print(f"    {s['key']:34s} {str(s['current'])[:28]:28s}  {s['why']}")


def cmd_scan(args):
    pattern = args.target
    files = sorted(glob.glob(os.path.join(pattern, "*.klog") if os.path.isdir(pattern) else glob.glob(pattern)))
    if not files:
        sys.exit(f"no .klog files matched {pattern}")
    rows = []
    for f in files:
        try:
            log = parse_klog(f)
            log["path"] = f
            m = metrics(log)
        except SystemExit:
            continue
        rows.append(
            {
                "file": os.path.basename(f),
                "profile": m["profile"],
                "level": m["level"],
                "total_s": m["charge_to_drop_s"],
                "dry_pct": m["dry_pct"],
                "dtr_pct": m["development_pct"],
                "drop_delta": m["drop_delta"],
                "worst_delta": (m["worst_deviation"] or {}).get("delta_c"),
            }
        )
    if args.json:
        print(json.dumps(rows, indent=2))
        return
    print(f"{len(rows)} logs\n")
    print(f"  {'file':22s} {'profile':18s} {'lvl':>4s} {'total':>6s} {'dry%':>5s} {'DTR%':>5s} {'dropΔ':>6s} {'worstΔ':>7s}")
    for r in rows:
        print(
            f"  {r['file'][:22]:22s} {str(r['profile'])[:18]:18s} {str(r['level'])[:4]:>4s} "
            f"{r['total_s']:6.0f} {str(r['dry_pct']):>5s} {str(r['dtr_pct']):>5s} "
            f"{r['drop_delta']:+6.1f} {str(r['worst_delta']):>7s}"
        )


def cmd_edit(args):
    kv = parse_profile(args.profile)
    changes = []
    for assignment in args.set or []:
        if "=" not in assignment:
            sys.exit(f"--set expects key=value, got {assignment!r}")
        k, _, v = assignment.partition("=")
        k = k.strip()
        if k not in kv:
            sys.exit(f"unknown key {k!r} (profile has {len(kv)} keys)")
        old = kv[k]
        kv[k] = v.strip()
        changes.append((k, old, kv[k]))
    if not changes:
        sys.exit("no --set given, nothing to do")

    out = args.out or re.sub(r"\.kpro$", "", args.profile) + "-edit.kpro"
    with open(out, "w", encoding="utf-8") as fh:
        for k, v in kv.items():
            fh.write(f"{k}:{v}\n")

    note = re.sub(r"\.kpro$", "", out) + ".changes.md"
    with open(note, "w", encoding="utf-8") as fh:
        fh.write(f"# Changes: {os.path.basename(args.profile)} → {os.path.basename(out)}\n\n")
        fh.write("| key | before | after |\n|---|---|---|\n")
        for k, old, new in changes:
            fh.write(f"| `{k}` | {old} | {new} |\n")
    if args.json:
        print(json.dumps({"out": out, "note": note, "changes": changes}, indent=2))
        return
    print(f"wrote {out}")
    for k, old, new in changes:
        print(f"  {k}: {old} → {new}")
    print(f"change note: {note}")


# ---------------------------------------------------------------- main


def main(argv=None):
    ap = argparse.ArgumentParser(prog="kaffelogic-tools", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("inspect", help="profile parameters, zones, fan points")
    p.add_argument("profile")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("roast", help="roast metrics")
    p.add_argument("log")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_roast)

    p = sub.add_parser("diff", help="deviation per phase and the keys that govern it")
    p.add_argument("log")
    p.add_argument("profile")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_diff)

    p = sub.add_parser("scan", help="one line per log in a folder")
    p.add_argument("target")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_scan)

    p = sub.add_parser("edit", help="write an edited profile copy")
    p.add_argument("profile")
    p.add_argument("--set", action="append", metavar="KEY=VALUE")
    p.add_argument("--out")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_edit)

    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
