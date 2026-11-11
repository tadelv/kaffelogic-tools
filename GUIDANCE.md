# Symptom → cause → lever

Coarse heuristics, not settled fact. Each is a hypothesis to test with one roast;
the `diff` after that roast is what confirms or refutes it. Directions: `+` means
more/earlier, `-` means less/later.

| Cupping attribute | Usual cause | First levers |
|---|---|---|
| flat | not enough energy in drying/Maillard; curve sags early then chases | `preheat_nominal_temperature:+`, `roast_required_power:+`, add early zone `Kp>1` |
| baked | long, low-energy Maillard phase — same signature as flat | `preheat_nominal_temperature:+`, `roast_required_power:+` |
| peanutty | usually underdevelopment: pyrazines without enough sugar browning | verify `expect_fc`, `preheat_nominal_temperature:+`, longer development |
| green / grassy / raw | underdeveloped | verify `expect_fc`, `preheat_nominal_temperature:+` |
| sour | underdeveloped acidity | `preheat_nominal_temperature:+`, `roast_end_by_time_ratio:-` |
| bitter / ashy / burnt | overdeveloped or scorched finish | `roast_end_by_time_ratio:+`, `roast_required_power:-` |
| muddy | long finish, low energy into first crack | `roast_min_desired_rate_of_rise:+`, `roast_required_power:+` |
| dull | flat rate of rise through development | `roast_min_desired_rate_of_rise:+`, `roast_required_power:+` |
| hollow | fast rise then stall — energy pulled too early | `roast_required_power:+`, `fan_profile:-` |
| smoky | too hot late | `roast_required_power:-`, `zone*_multiplier_Kp:-` |

## How each lever actually acts on the Nano

- `preheat_nominal_temperature` — drum temperature at charge. The single biggest
  influence on the first three minutes, which is where profiles are usually
  under-tuned (their zones often start at 210 s).
- `preheat_power` / `preheat_min_time` / `preheat_max_time` — how hard and how long
  the machine preheats. Raising power with the same max time heats the drum faster
  but does not necessarily reach a higher temperature.
- `roast_required_power` — heater ceiling during the roast. Logs show mean power
  close to this ceiling, so it is a real constraint, not a target.
- `roast_min_desired_rate_of_rise` — the ROR floor the loop aims for. Raising it
  pushes more energy in; it is the practical lever for "dull" and "muddy".
- `roast_end_by_time_ratio` — drop trigger relative to the projected curve. Small
  moves change development time without touching the target temperature.
- `expect_fc` — first-crack temperature the loop uses. It must match the coffee;
  wrong values make development percentages lie.
- `zone*_time_start/end` — *when* a set of PID multipliers applies. A zone that
  does not cover a phase does nothing to that phase; check the diff output first.
- `zone*_multiplier_Kp/Kd` — per-window aggressiveness. `Kp>1` reacts harder,
  `Kd>1` damps more.
- `fan_profile` — control points, stored in an undocumented packed form. The CLI
  reports observed RPM from logs instead of guessing at the encoding.

## Reading the numbers

- Mean deviation is more useful than the drop temperature. A roast can land the
  drop within 1 °C while having been 5–10 °C off for the first half.
- `dry%` near 44 % with a sagging early curve means the machine spent the drying
  phase chasing rather than leading.
- DTR (development time ratio) of 10–15 % is the usual filter target; below ~9 %
  reads underdeveloped regardless of the curve.
- Power pinned near the ceiling for most of the roast means the profile is asking
  for more than the element can deliver — raising the ceiling may change nothing.
