#!/usr/bin/env python3
"""
advise.py — the subjective half of kaffelogic-tools.

Taste is the signal the logs cannot give, so this records cupping attributes
against a roast, then packages a profile + roast + notes into one JSON "brief"
that an agent can act on, and applies the agent's proposed edits inside bounds.

  advise.py note <log.klog> --profile p.kpro --attrs flat,peanutty --score 78
  advise.py brief <p.kpro> <log.klog>            → JSON for the agent
  advise.py apply <p.kpro> --edits edits.json --out next.kpro --hypothesis "..."
  advise.py guidance                             → symptom → cause → levers

Reuses klt.py for all parsing, so both halves read the same files the same way.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys

import klt

NOTES_DEFAULT = os.path.expanduser("~/.kaffelogic/notes.jsonl")

# Coarse, honest heuristics: a hypothesis to test with the next roast, not a claim
# of certainty. Directions follow how the Nano's loop uses each parameter.
SYMPTOM_GUIDE = {
    "flat": ("not enough energy in drying/Maillard; the curve sags early then chases",
             ["preheat_nominal_temperature:+", "roast_required_power:+", "add early zone Kp>1"]),
    "baked": ("long, low-energy Maillard phase — same signature as flat",
              ["preheat_nominal_temperature:+", "roast_required_power:+", "add early zone Kp>1"]),
    "peanutty": ("usually underdevelopment: pyrazines without enough sugar browning",
                 ["expect_fc (verify)", "preheat_nominal_temperature:+", "longer development"]),
    "green": ("underdeveloped", ["expect_fc (verify)", "preheat_nominal_temperature:+"]),
    "grassy": ("underdeveloped", ["expect_fc (verify)", "preheat_nominal_temperature:+"]),
    "raw": ("underdeveloped", ["expect_fc (verify)", "preheat_nominal_temperature:+"]),
    "sour": ("underdeveloped acidity", ["preheat_nominal_temperature:+", "roast_end_by_time_ratio:-"]),
    "bitter": ("overdeveloped or scorched finish", ["roast_end_by_time_ratio:+", "roast_required_power:-"]),
    "ashy": ("overdeveloped finish", ["roast_end_by_time_ratio:+", "roast_required_power:-"]),
    "burnt": ("overdeveloped finish", ["roast_end_by_time_ratio:+", "roast_required_power:-"]),
    "muddy": ("long finish, low energy into first crack", ["roast_min_desired_rate_of_rise:+", "roast_required_power:+"]),
    "dull": ("flat rate of rise through development", ["roast_min_desired_rate_of_rise:+", "roast_required_power:+"]),
    "hollow": ("fast rise then stall — energy pulled too early", ["roast_required_power:+", "fan_profile:-"]),
    "smoky": ("too hot late", ["roast_required_power:-", "zone*_multiplier_Kp:-"]),
}

# Numeric guard rails by key shape, so an agent cannot write nonsense.
BOUNDS = [
    (re.compile(r"_power$"), 0.0, 1500.0),
    (re.compile(r"temperature|_temp$|expect_fc|expect_colrchange"), 0.0, 300.0),
    (re.compile(r"multiplier_K[pid]"), 0.2, 3.0),
    (re.compile(r"zone\d+_time_(start|end)"), 0.0, 1200.0),
    (re.compile(r"roast_end_by_time_ratio"), 0.5, 1.5),
    (re.compile(r"roast_min_desired_rate_of_rise"), -5.0, 30.0),
    (re.compile(r"preheat_(min|max)_time|check_gradient_time"), 0.0, 300.0),
]


def load_notes(store):
    if not os.path.exists(store):
        return []
    out = []
    with open(store, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def edit_surface(kv):
    """Numeric keys an agent may touch, with bounds where a rule applies."""
    surface = []
    for k, v in kv.items():
        if not klt.NUM.match(v or ""):
            continue
        lo = hi = None
        for pat, a, b in BOUNDS:
            if pat.search(k):
                lo, hi = a, b
                break
        surface.append({"key": k, "value": float(v), "min": lo, "max": hi})
    return surface


def cmd_note(args):
    os.makedirs(os.path.dirname(args.store), exist_ok=True)
    entry = {
        "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "log": os.path.abspath(args.log) if args.log else None,
        "profile": os.path.abspath(args.profile) if args.profile else None,
        "level": args.level,
        "attributes": [a.strip().lower() for a in (args.attrs or "").split(",") if a.strip()],
        "score": args.score,
        "comment": args.comment,
    }
    with open(args.store, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")
    if args.json:
        print(json.dumps(entry, indent=2))
        return
    print(f"noted {'/'.join(entry['attributes']) or '(none)'} for {os.path.basename(args.log) if args.log else 'no log'}")
    for attr in entry["attributes"]:
        if attr in SYMPTOM_GUIDE:
            cause, levers = SYMPTOM_GUIDE[attr]
            print(f"  {attr:10s} -> {cause}")
            print(f"             levers: {', '.join(levers)}")


def cmd_brief(args):
    """One JSON document holding everything an agent needs to propose an edit."""
    kv = klt.parse_profile(args.profile)
    zones = klt.profile_zones(kv)
    brief = {
        "kind": "kaffelogic-brief",
        "version": 1,
        "profile": {
            "file": os.path.abspath(args.profile),
            "name": kv.get("profile_short_name"),
            "designer": kv.get("profile_designer"),
            "level": kv.get("recommended_level"),
            "load_g": kv.get("reference_load_size"),
            "zones": zones,
            "keys": kv,
        },
    }

    notes = load_notes(args.store)
    if args.log:
        log = klt.parse_klog(args.log)
        log["path"] = args.log
        m = klt.metrics(log)
        m.pop("_rows", None)
        ph = klt.phases(klt.metrics(log))
        brief["roast"] = m
        brief["phases"] = ph
        brief["untuned_phases"] = [p["phase"] for p in ph if klt.zone_at(zones, p["worst_at_s"]) is None]
        target = os.path.abspath(args.log)
        brief["notes_for_this_roast"] = [n for n in notes if n.get("log") == target]

    same = [n for n in notes if args.profile and n.get("profile") and n["profile"].endswith(os.path.basename(args.profile))]
    brief["notes_recent_same_profile"] = same[-5:]

    attrs = []
    for n in brief.get("notes_for_this_roast", []) + brief["notes_recent_same_profile"]:
        attrs += n.get("attributes", [])
    brief["symptom_guide"] = {
        a: {"cause": SYMPTOM_GUIDE[a][0], "levers": SYMPTOM_GUIDE[a][1]}
        for a in dict.fromkeys(attrs)
        if a in SYMPTOM_GUIDE
    }
    brief["edit_surface"] = edit_surface(kv)
    brief["instructions"] = [
        'Propose edits as a JSON array: [{"key": <existing key>, "value": <number>, "why": "<one line>"}]',
        "Stay inside edit_surface min/max; prefer the smallest change that addresses the named symptom.",
        "One or two keys per roast, so the next diff can attribute the effect.",
        "Apply with: advise.py apply <profile> --edits edits.json --out next.kpro --hypothesis '...'",
    ]
    print(json.dumps(brief, indent=2))


def cmd_apply(args):
    kv = klt.parse_profile(args.profile)
    with open(args.edits, encoding="utf-8") as fh:
        edits = json.load(fh)
    if not isinstance(edits, list) or not edits:
        sys.exit("edits file must be a non-empty JSON array of {key,value,why}")

    bounds = {e["key"]: (e["min"], e["max"]) for e in edit_surface(kv)}
    applied, rejected = [], []
    for e in edits:
        k = e.get("key")
        if k not in kv:
            rejected.append({**e, "reason": "unknown key"})
            continue
        try:
            val = float(e["value"])
        except (TypeError, ValueError):
            rejected.append({**e, "reason": "value is not numeric"})
            continue
        lo, hi = bounds.get(k, (None, None))
        if (lo is not None and val < lo) or (hi is not None and val > hi):
            rejected.append({**e, "reason": f"outside bounds {lo}..{hi}"})
            continue
        old = kv[k]
        kv[k] = f"{val:g}"
        applied.append({"key": k, "before": old, "after": kv[k], "why": e.get("why", "")})

    if not applied:
        sys.exit("every edit was rejected:\n" + json.dumps(rejected, indent=2))

    out = args.out or re.sub(r"\.kpro$", "", args.profile) + "-edit.kpro"
    with open(out, "w", encoding="utf-8") as fh:
        for k, v in kv.items():
            fh.write(f"{k}:{v}\n")

    note = re.sub(r"\.kpro$", "", out) + ".changes.md"
    with open(note, "w", encoding="utf-8") as fh:
        fh.write(f"# {os.path.basename(args.profile)} -> {os.path.basename(out)}\n\n")
        if args.hypothesis:
            fh.write(f"**Hypothesis:** {args.hypothesis}\n\n")
        fh.write("| key | before | after | why |\n|---|---|---|---|\n")
        for a in applied:
            fh.write(f"| `{a['key']}` | {a['before']} | {a['after']} | {a['why']} |\n")
        fh.write(f"\nVerify by roasting one batch, then `klt.py diff <new log> {os.path.basename(out)}`.\n")
        if rejected:
            fh.write("\nRejected:\n")
            for r in rejected:
                fh.write(f"- `{r.get('key')}` = {r.get('value')} — {r['reason']}\n")

    if args.json:
        print(json.dumps({"out": out, "note": note, "applied": applied, "rejected": rejected}, indent=2))
        return
    print(f"wrote {out}")
    for a in applied:
        print(f"  {a['key']}: {a['before']} -> {a['after']}   {a['why']}")
    for r in rejected:
        print(f"  REJECTED {r.get('key')}={r.get('value')} - {r['reason']}")
    print(f"change note: {note}")


def cmd_guidance(args):
    if args.json:
        print(json.dumps({k: {"cause": v[0], "levers": v[1]} for k, v in SYMPTOM_GUIDE.items()}, indent=2))
        return
    print("symptom -> likely cause -> levers ('+' more/earlier, '-' less/later)\n")
    for sym, (cause, levers) in sorted(SYMPTOM_GUIDE.items()):
        print(f"  {sym:10s} {cause}")
        print(f"             {', '.join(levers)}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="advise.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("note", help="record cupping attributes for a roast")
    p.add_argument("log", nargs="?")
    p.add_argument("--profile")
    p.add_argument("--attrs", help="comma separated: flat,peanutty,sour ...")
    p.add_argument("--score")
    p.add_argument("--level")
    p.add_argument("--comment")
    p.add_argument("--store", default=NOTES_DEFAULT)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_note)

    p = sub.add_parser("brief", help="one JSON document an agent can act on")
    p.add_argument("profile")
    p.add_argument("log", nargs="?")
    p.add_argument("--store", default=NOTES_DEFAULT)
    p.set_defaults(func=cmd_brief)

    p = sub.add_parser("apply", help="apply agent-proposed edits with bounds checks")
    p.add_argument("profile")
    p.add_argument("--edits", required=True, help="JSON array of {key,value,why}")
    p.add_argument("--out")
    p.add_argument("--hypothesis", help="one line recorded in the change note")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_apply)

    p = sub.add_parser("guidance", help="symptom -> cause -> lever table")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_guidance)

    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
