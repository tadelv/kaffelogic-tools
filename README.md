# kaffelogic-tools

Read, analyse and edit Kaffelogic Nano 7 roast profiles and logs. No vendor
software, no hardware: both file formats are plain text.

```
.kpro   60 `key:value` lines — preheat, roast power, PID zone multipliers,
        expected first crack, fan control points
.klog   `key:value` header, then TSV rows, plus `!marker:value` events
```

## Two halves

`klt.py` — mechanical truth: parse, measure, diff, scan.

```
klt.py inspect <profile.kpro>            profile parameters, zones, gaps
klt.py roast   <log.klog>                charge/dry/FC/DTR, drop vs target, ROR, PID drift
klt.py diff    <log.klog> <profile.kpro> deviation per phase + which keys govern it
klt.py scan    <dir|glob>                one line per log; a folder becomes a trend
klt.py edit    <profile.kpro> --set k=v  plain edit (no bounds)
```

`advise.py` — the subjective layer: taste in, bounded edits out.

```
advise.py note   <log.klog> --profile p.kpro --attrs flat,peanutty --score 78
advise.py brief  <p.kpro> [log.klog]     one JSON document for an agent
advise.py apply  <p.kpro> --edits edits.json --out next.kpro --hypothesis "..."
advise.py guidance                       symptom -> cause -> lever table
```

Every command takes `--json`. Notes accumulate in `~/.kaffelogic/notes.jsonl`
(override with `--store`).

## The loop

1. Roast, pull the `.klog` off the stick.
2. `klt.py diff <log> <profile>` — see *where* the curve missed and whether that
   phase is even inside a tuning zone.
3. `advise.py note <log> --profile <profile> --attrs flat,peanutty` — record what
   you tasted.
4. `advise.py brief <profile> <log> --json` — hand the agent one document with the
   roast metrics, the phase deviations, your notes, the symptom heuristics and the
   exact keys it is allowed to move.
5. Agent answers with `[{"key": ..., "value": ..., "why": ...}]`.
6. `advise.py apply ... --out next.kpro --hypothesis "..."` — bounds-checked write,
   plus a `.changes.md` recording the hypothesis.
7. Roast one batch with `next.kpro`, then `klt.py diff` again. The hypothesis is
   either supported or refuted by the numbers, and that answer goes into the next
   note.

One or two keys per roast. More than that and the next diff cannot attribute the
effect to anything.

## Guard rails

`apply` rejects unknown keys, non-numeric values, and anything outside the bounds
implied by the key shape (power 0–1500, temperatures 0–300, PID multipliers
0.2–3.0, zone times 0–1200 s, end-by-time-ratio 0.5–1.5). A rejected edit is
recorded in the change note instead of silently dropped.

## Limits worth knowing

- The heuristics in `GUIDANCE.md` are coarse and directional. They are hypotheses
  to test, not settled fact; the `diff` after the next roast is what decides.
- `.klog` is the machine's own history. If a phase has no zone covering it, the
  profile's `zone*_multiplier_*` values cannot affect that phase — the diff says so
  explicitly, which is the fastest way to stop tuning the wrong window.
- `Ki` is 0 in every log seen so far, so steady-state error is never integrated
  out; the levers are `Kp`/`Kd` multipliers and the energy keys.
