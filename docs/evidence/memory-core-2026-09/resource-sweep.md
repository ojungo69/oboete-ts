# Retained-history resource sweep (T042, SC-008)

What a worker costs while a reader holds the database open and capture keeps arriving. The harness is
`scripts/measure-resources.mjs`; it runs the product's own binaries against a temporary home and reads
only what the product writes or what this run itself started: `logs/observe.log` (including the
`run start pid=` the worker records there), `/proc/<pid>/stat` and `/proc/<pid>/status` of the
processes the harness spawned or that log names, each child's peak resident size as the kernel
reports it through `/usr/bin/time -f %M`, the database and its WAL.

Run on 2026-09-21 against `2f24c005`, on both supported Node versions. The harness refuses to start
with a modified tracked file, builds the two files it runs - the launcher and the engine it imports
- and records their digest, so the commit names what ran: both legs report `c43e809d227a3621`. An interactive session was
running on the same machine; the load at the start of each run is in the table.

## What it measures

- **Phase A** replays `test/fixtures/events-1000.jsonl` (1,051 lines) through the real hooks, with
  `[observer] preset = "none"`, and reads the replay's own bounds. The replay drives one-shot worker
  runs - 38 of them, `hookWorkerRuns` 0 - not a resident. Its 1,143 hooks are the replay's own
  children, and `%M` for the replay covers them: it is the kernel's peak for a command and the
  descendants it waits for, taken at exit rather than sampled.
- **Phase B** runs against the resident worker the hooks spawn, and holds a read-only connection
  open for at least 20 seconds - `--hold-ms` is a floor, and the hold also carries the session-end
  hooks and the wait for a worker batch to overlap it, so the measured holds were 24.3 s on both versions - while 20
  sessions of 9 prompts each keep capturing, sampling the database size, the WAL size, the spool and
  the worker's `VmRSS`/`VmHWM` about every 250 ms, then drains, stops and samples once more.

`preset = "none"` means no summarizer runs, so every source ends `waiting` as a deferred
`no_provider`. That is the point of the sweep: it measures the cost of holding retained history, not
the cost of generating from it. SC-009 recall is 0/40 for the same reason and is reported, not gated.

## Results

| | Node 24.16.0 | Node 22.23.1 | Bound |
|---|---|---|---|
| peak `VmHWM`, any process of the run | 111,316 KiB (108.71 MiB) | 102,540 KiB (100.14 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase A, from the replay) | 111,316 KiB (108.71 MiB) | 102,540 KiB (100.14 MiB) | same bound |
| replay peak `%M` (covers its 1,143 hooks) | 110,544 KiB (107.95 MiB) | 101,624 KiB (99.24 MiB) | same bound |
| worst of the 240 phase B hooks (`%M`) | 109,100 KiB (106.54 MiB) | 96,428 KiB (94.17 MiB) | same bound |
| worker peak `VmHWM` (phase B, all stages) | 105,848 KiB (103.37 MiB) | 95,520 KiB (93.28 MiB) | same bound |
| worker peak `VmHWM` (during the hold itself) | 99,388 KiB (97.06 MiB) | 93,476 KiB (91.29 MiB) | reported |
| growth per 1,000 events | 4,824,883 bytes | 4,820,986 bytes | recorded, not gated |
| capture hooks (phase A) | p99 178.0 ms, 100.0% ≤ 300 ms (n=717) | p99 167.5 ms, 100.0% ≤ 300 ms (n=717) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 213 ms, max 290 ms, none over 1 s, 0 non-zero | n=240, p50 210 ms, max 295 ms, none over 1 s, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 29,008,952 bytes → 0 after the stop | 0 → peak 28,518,672 bytes → 0 | grows under a held reader, recycles after |
| spool files at any sample | 0 | 0 | 0 |
| load average at start | 0.30 0.26 0.53 | 1.97 1.82 1.14 | — |

Gated checks, both runs **pass**:

- `retained` — all 1,322 rows phase A left are still there after phase B, no missing and no
  duplicate source, no failed classification, and every session stored its `session_start`,
  `session_end`, `last_assistant_message` and `turn_end` exactly once; spool empty.
- `not-stuck` — `pending=0`, `liveBatches=0`, `endReason=stopped` and nothing else (the run throws
  when `observe --stop` fails, so an `idle_exit` end would mean the stop path never ran),
  `workerErrors=0`, no bad end reason, and no `worker-stop` sentinel left behind: a worker that
  cannot remove it only logs that, and the next worker would stop on it. 1,118 sources waiting on
  24.x and 1,119 on 22.x, with 4 parked on each, which is what `preset = "none"` produces - the check requires nothing
  to have been processed and something to be waiting, since with no summarizer neither could be
  otherwise. The spool count includes `spool/failed/`, so an entry recovery quarantined is a
  failure rather than an empty spool.
- `wal-recycled` — the WAL grows from 0 under the held reader (peak 29,008,952 bytes on 24.x and
  28,518,672 on 22.x) and is back to 0
  after the product's own stop path runs `wal_checkpoint(TRUNCATE)`; the check passes when the final
  size is at most a quarter of the peak. Seven `info batch` lines on 24.x and six on 22.x were logged
  while the reader was held, so the growth is a worker writing against the held snapshot rather than an idle file.
- `rss-bound` — peak `VmHWM` under the 150 MiB bound on both versions, across every process of the
  run - 111,316 KiB (108.71 MiB) on 24.x and 102,540 KiB (100.14 MiB) on 22.x: the resident worker
  from the samples, and each of the 245 children from the kernel's own figure at exit (the replay,
  240 hooks, three `doctor` runs and `observe --stop`). A child that leaves no reading fails the
  check; none did. So does a resident the worker log names from the first sample onwards that no
  sample ever saw - a hook spawns its resident detached, so the hook's own `%M` does not cover it -
  and on both versions that count was 0. What the resident's figure cannot carry is growth inside
  the last interval of its life: `VmHWM` is a high-water mark, so every sample carries every peak
  before it, but once the process is gone `/proc` is gone with it, and the worker does not record
  its own peak when it ends. The gap is one sample interval, nominally 250 ms and longer whenever the
  timer is delayed - the widest gap between two samples in these runs was 252 ms, and load or a
  synchronous read can stretch it further. Closing it properly is #307.

Reported, not gated:

- injection p99 308.1 ms on 24.x with 98.7% ≤ 300 ms (n=378) and 294.4 ms with 98.9% on 22.x; the
  worst group is grok/`UserPromptSubmit` at p99 341.4 ms (24.x) and 329.3 ms (22.x).
- session start: ready max 217.0 ms (24.x) and 211.3 ms (22.x), n=1; pending max 226.3 ms and
  213.0 ms (n=48), with 46 of 48 packs carrying `summary_pending`.
- SC-009 recall 0/40, by construction of `preset = "none"`.
- no phase B hook on either version ran over a second in this pair of runs: the slowest was 290 ms
  on 24.x and 295 ms on 22.x, and all 480 exited 0. Earlier runs of this same harness did produce
  one to three hooks of around three seconds, so whether they appear at all varies between runs, the
  cause is not isolated, and hook cold start is tracked in #210.
- the phase B hook durations carry the `/usr/bin/time` wrapper's own startup, because the harness
  spawns those hooks itself. The phase A capture numbers do not: the replay is wrapped, but it times
  its hooks from inside.

## What this run cannot say

- **Long-run growth.** A half-minute hold cannot show it. The seven-day run is #268.
- **Scale.** 1,051 events is the fixture, not the 10,000- and 100,000-event runs of #267.
- **A real summarizer.** With `preset = "none"` nothing is generated, so neither the provider's cost
  nor recall is exercised here.

## How to re-run

The harness builds the bundle it measures and needs GNU time, so there is nothing to build first;
give each Node version its own `--json-out`. The harness's own exit code is the result - 0 all gated
checks passed, 1 a check or a hook failed, 2 the run could not be completed - so do not pipe it
away. It refuses to start with a modified tracked file, since the commit it records has to be the
code it ran:

```sh
mkdir -p /var/tmp/oboete-t042
~/.nvm/versions/node/v24.16.0/bin/node scripts/measure-resources.mjs \
  --json-out /var/tmp/oboete-t042/v27-24.16.0.json > /var/tmp/oboete-t042/v27-24.16.0.md
echo "exit=$?"
```

`node scripts/measure-resources.mjs --self-check` runs the harness's own assertions without touching
a temporary home. A run takes about seven minutes, four of them in the phase A replay. A failed run
keeps its temporary home and prints the path.

## Receipts

`/var/tmp/oboete-t042/v27-24.16.0.{md,json,observe.log}` and `v27-22.23.1.{md,json,observe.log}`. The
Markdown is the harness's own report; the JSON is the same data unrounded; `observe.log` is the
worker's log for the run, which is where `endReason`, `workerErrors` and the bad-end set are read
from.
