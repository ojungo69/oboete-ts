# Retained-history resource sweep (T042, SC-008)

What a worker costs while a reader holds the database open and capture keeps arriving. The harness is
`scripts/measure-resources.mjs`; it runs the product's own binaries against a temporary home and reads
only what the product writes or what this run itself started: `logs/observe.log` (including the
`run start pid=` the worker records there), `/proc/<pid>/stat` and `/proc/<pid>/status` of the
processes the harness spawned or that log names, each child's peak resident size as the kernel
reports it through `/usr/bin/time -f %M`, the database and its WAL.

Run on 2026-09-21 against `e77141d1`, on both supported Node versions. An interactive session was
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
| peak `VmHWM`, any process of the run | 109,884 KiB (107.31 MiB) | 103,228 KiB (100.81 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase A, from the replay) | 109,704 KiB (107.13 MiB) | 103,228 KiB (100.81 MiB) | same bound |
| replay peak `%M` (covers its 1,143 hooks) | 109,884 KiB (107.31 MiB) | 102,364 KiB (99.96 MiB) | same bound |
| worst of the 240 phase B hooks (`%M`) | 109,524 KiB (106.96 MiB) | 97,740 KiB (95.45 MiB) | same bound |
| worker peak `VmHWM` (phase B, all stages) | 101,340 KiB (98.96 MiB) | 95,296 KiB (93.06 MiB) | same bound |
| worker peak `VmHWM` (during the hold itself) | 99,312 KiB (97.00 MiB) | 93,112 KiB (90.93 MiB) | reported |
| growth per 1,000 events | 4,828,780 bytes | 4,832,677 bytes | recorded, not gated |
| capture hooks (phase A) | p99 179.5 ms, 100.0% ≤ 300 ms (n=717) | p99 165.7 ms, 100.0% ≤ 300 ms (n=717) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 215 ms, max 301 ms, none over 1 s, 0 non-zero | n=240, p50 213 ms, max 292 ms, none over 1 s, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 28,044,872 bytes → 0 after the stop | 0 → peak 28,959,512 bytes → 0 | grows under a held reader, recycles after |
| spool files at any sample | 0 | 0 | 0 |
| load average at start | 1.16 0.66 0.89 | 1.44 1.46 1.20 | — |

Gated checks, both runs **pass**:

- `retained` — all 1,322 rows phase A left are still there after phase B, no missing and no
  duplicate source, no failed classification, and every session stored its `session_start`,
  `session_end`, `last_assistant_message` and `turn_end` exactly once; spool empty.
- `not-stuck` — `pending=0`, `liveBatches=0`, `endReason=stopped` and nothing else (the run throws
  when `observe --stop` fails, so an `idle_exit` end would mean the stop path never ran),
  `workerErrors=0`, no bad end reason, and no `worker-stop` sentinel left behind: a worker that
  cannot remove it only logs that, and the next worker would stop on it. 1,119 sources waiting and
  4 parked on each version, which is what `preset = "none"` produces.
- `wal-recycled` — the WAL grows from 0 under the held reader (peak 28 MB on 24.x, 29 MB on 22.x) and is back to 0
  after the product's own stop path runs `wal_checkpoint(TRUNCATE)`; the check passes when the final
  size is at most a quarter of the peak. Six `info batch` lines on 24.x and seven on 22.x were logged
  while the reader was held, so the growth is a worker writing against the held snapshot rather than an idle file.
- `rss-bound` — peak `VmHWM` under the 150 MiB bound on both versions, across every process of the
  run - 109,884 KiB (107.31 MiB) on 24.x and 103,228 KiB (100.81 MiB) on 22.x: the resident worker
  from the samples, and each of the 245 children from the kernel's own figure at exit (the replay,
  240 hooks, three `doctor` runs and `observe --stop`). A child that leaves no reading fails the
  check; none did.

Reported, not gated:

- injection p99 310.6 ms on 24.x with 97.6% ≤ 300 ms (n=378) and 298.3 ms with 98.9% on 22.x; the
  worst group is grok/`UserPromptSubmit` at p99 350.1 ms (24.x) and 338.1 ms (22.x).
- session start: ready max 232.7 ms (24.x) and 207.8 ms (22.x), n=1; pending max 250.2 ms and
  212.4 ms (n=48), with 46 of 48 packs carrying `summary_pending`.
- SC-009 recall 0/40, by construction of `preset = "none"`.
- no phase B hook on either version ran over a second in this pair of runs: the slowest was 301 ms
  on 24.x and 292 ms on 22.x, and all 480 exited 0. Earlier runs of this same harness did produce
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

The harness runs the published bundle and needs GNU time, so build first, and give each Node version
its own `--json-out`. The harness's own exit code is the result - 0 all gated checks passed, 1 a
check or a hook failed, 2 the run could not be completed - so do not pipe it away:

```sh
npm run build
mkdir -p /var/tmp/oboete-t042
~/.nvm/versions/node/v24.16.0/bin/node scripts/measure-resources.mjs \
  --json-out /var/tmp/oboete-t042/v21-24.16.0.json > /var/tmp/oboete-t042/v21-24.16.0.md
echo "exit=$?"
```

`node scripts/measure-resources.mjs --self-check` runs the harness's own assertions without touching
a temporary home. A run takes about seven minutes, four of them in the phase A replay. A failed run
keeps its temporary home and prints the path.

## Receipts

`/var/tmp/oboete-t042/v21-24.16.0.{md,json,observe.log}` and `v21-22.23.1.{md,json,observe.log}`. The
Markdown is the harness's own report; the JSON is the same data unrounded; `observe.log` is the
worker's log for the run, which is where `endReason`, `workerErrors` and the bad-end set are read
from.
