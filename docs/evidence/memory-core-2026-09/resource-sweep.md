# Retained-history resource sweep (T042, SC-008)

What a worker costs while a reader holds the database open and capture keeps arriving. The harness is
`scripts/measure-resources.mjs`; it runs the product's own binaries against a temporary home and reads
only what the product writes or what this run itself started: `logs/observe.log` (including the
`run start pid=` the worker records there), `/proc/<pid>/stat` and `/proc/<pid>/status` of the
processes the harness spawned or that log names, each child's peak resident size as the kernel
reports it through `/usr/bin/time -f %M`, the database and its WAL.

Run on 2026-09-21 against `7ca83db7`, on both supported Node versions. An interactive session was
running on the same machine; the load at the start of each run is in the table.

## What it measures

- **Phase A** replays `test/fixtures/events-1000.jsonl` (1,051 lines) through the real hooks, with
  `[observer] preset = "none"`, and reads the replay's own bounds. The replay drives one-shot worker
  runs - 38 of them, `hookWorkerRuns` 0 - not a resident. Its 1,143 hooks are the replay's own
  children, and `%M` for the replay covers them: it is the kernel's peak for a command and the
  descendants it waits for, taken at exit rather than sampled.
- **Phase B** runs against the resident worker the hooks spawn, and holds a read-only connection
  open for at least 20 seconds - `--hold-ms` is a floor, and the hold also carries the session-end
  hooks and the wait for a worker batch to overlap it, so the measured holds were 24.0 s and 26.7 s - while 20
  sessions of 9 prompts each keep capturing, sampling the database size, the WAL size, the spool and
  the worker's `VmRSS`/`VmHWM` about every 250 ms, then drains, stops and samples once more.

`preset = "none"` means no summarizer runs, so every source ends `waiting` as a deferred
`no_provider`. That is the point of the sweep: it measures the cost of holding retained history, not
the cost of generating from it. SC-009 recall is 0/40 for the same reason and is reported, not gated.

## Results

| | Node 24.16.0 | Node 22.23.1 | Bound |
|---|---|---|---|
| peak `VmHWM`, any process of the run | 110,792 KiB (108.20 MiB) | 102,560 KiB (100.16 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase A, from the replay) | 110,792 KiB (108.20 MiB) | 102,560 KiB (100.16 MiB) | same bound |
| replay peak `%M` (covers its 1,143 hooks) | 110,348 KiB (107.76 MiB) | 101,512 KiB (99.13 MiB) | same bound |
| worst of the 240 phase B hooks (`%M`) | 109,596 KiB (107.03 MiB) | 96,508 KiB (94.25 MiB) | same bound |
| worker peak `VmHWM` (phase B, all stages) | 102,188 KiB (99.79 MiB) | 94,948 KiB (92.72 MiB) | same bound |
| worker peak `VmHWM` (during the hold itself) | 100,860 KiB (98.50 MiB) | 92,760 KiB (90.59 MiB) | reported |
| growth per 1,000 events | 4,863,855 bytes | 4,863,855 bytes | recorded, not gated |
| capture hooks (phase A) | p99 168.2 ms, 100.0% ≤ 300 ms (n=717) | p99 152.1 ms, 100.0% ≤ 300 ms (n=717) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 196 ms, max 269 ms, 0 non-zero | n=240, p50 195 ms, max 3,180 ms, 2 over 1 s, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 28,922,432 bytes → 0 after the stop | 0 → peak 28,617,552 bytes → 0 | grows under a held reader, recycles after |
| spool files at any sample | 0 | 0 | 0 |
| load average at start | 0.18 0.27 0.48 | 1.67 1.02 0.74 | — |

Gated checks, both runs **pass**:

- `retained` — all 1,322 rows phase A left are still there after phase B, no missing and no
  duplicate source, no failed classification, and every session stored its `session_start`,
  `session_end`, `last_assistant_message` and `turn_end` exactly once; spool empty.
- `not-stuck` — `pending=0`, `liveBatches=0`, `endReason=stopped` and nothing else (the run throws
  when `observe --stop` fails, so an `idle_exit` end would mean the stop path never ran),
  `workerErrors=0`, no bad end reason, and no `worker-stop` sentinel left behind: a worker that
  cannot remove it only logs that, and the next worker would stop on it. 1,119 sources waiting and
  4 parked, which is what `preset = "none"` produces.
- `wal-recycled` — the WAL grows from 0 under the held reader (peak ≈ 29 MB) and is back to 0
  after the product's own stop path runs `wal_checkpoint(TRUNCATE)`; the check passes when the final
  size is at most a quarter of the peak. Seven (24.x) and six (22.x) `info batch` lines were logged
  while the reader was held, so the growth is a worker writing against the held snapshot rather than an idle file.
- `rss-bound` — peak `VmHWM` under the 150 MiB bound on both versions, across every process of the
  run - 110,792 KiB (108.20 MiB) on 24.x and 102,560 KiB (100.16 MiB) on 22.x: the resident worker
  from the samples, and each of the 245 children from the kernel's own figure at exit (the replay,
  240 hooks, three `doctor` runs and `observe --stop`). A child that leaves no reading fails the
  check; none did.

Reported, not gated:

- injection p99 284.6 ms on 24.x with 98.9% ≤ 300 ms (n=378) and 276.0 ms with 99.5% on 22.x; the
  worst group is grok/`UserPromptSubmit` at p99 336.3 ms (24.x) and 316.7 ms (22.x).
- session start: ready max 200.9 ms (24.x) and 195.4 ms (22.x), n=1; pending max 213.6 ms and
  196.9 ms (n=48), with 46 of 48 packs carrying `summary_pending`.
- SC-009 recall 0/40, by construction of `preset = "none"`.
- two phase B hooks on 22.x took 3,156 and 3,180 ms, and no hook on 24.x went over 300 ms; the
  slowest of the rest was 269 ms and 268 ms. All exited 0. One to three such hooks appear in most
  runs of this harness and none in others, the cause is not isolated, and hook cold start is tracked
  in #210.
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
  --json-out /var/tmp/oboete-t042/v15-24.16.0.json > /var/tmp/oboete-t042/v15-24.16.0.md
echo "exit=$?"
```

`node scripts/measure-resources.mjs --self-check` runs the harness's own assertions without touching
a temporary home. A run takes about seven minutes, four of them in the phase A replay. A failed run
keeps its temporary home and prints the path.

## Receipts

`/var/tmp/oboete-t042/v15-24.16.0.{md,json,observe.log}` and `v15-22.23.1.{md,json,observe.log}`. The
Markdown is the harness's own report; the JSON is the same data unrounded; `observe.log` is the
worker's log for the run, which is where `endReason`, `workerErrors` and the bad-end set are read
from.
