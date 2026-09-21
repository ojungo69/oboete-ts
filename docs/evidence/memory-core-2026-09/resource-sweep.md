# Retained-history resource sweep (T042, SC-008)

What a worker costs while a reader holds the database open and capture keeps arriving. The harness is
`scripts/measure-resources.mjs`; it runs the product's own binaries against a temporary home and reads
only what the product writes or what this run itself started: `logs/observe.log` (including the
`run start pid=` the worker records there), `/proc/<pid>/stat` and `/proc/<pid>/status` of the
processes the harness spawned or that log names, each child's peak resident size as the kernel
reports it through `/usr/bin/time -f %M`, the database and its WAL.

Run on 2026-09-21 against `8f4715a8`, on both supported Node versions. The harness refuses to start
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
  hooks and the wait for a worker batch to overlap it, so the measured holds were 24.9 s on both versions - while 20
  sessions of 9 prompts each keep capturing, sampling the database size, the WAL size, the spool and
  the worker's `VmRSS`/`VmHWM` about every 250 ms, then drains, stops and samples once more.

`preset = "none"` means no summarizer runs, so every source ends `waiting` as a deferred
`no_provider`. That is the point of the sweep: it measures the cost of holding retained history, not
the cost of generating from it. SC-009 recall is 0/40 for the same reason and is reported, not gated.

## Results

| | Node 24.16.0 | Node 22.23.1 | Bound |
|---|---|---|---|
| peak `VmHWM`, any process of the run | 110,008 KiB (107.43 MiB) | 103,172 KiB (100.75 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase A, from the replay) | 110,008 KiB (107.43 MiB) | 103,172 KiB (100.75 MiB) | same bound |
| replay peak `%M` (covers its 1,143 hooks) | 109,896 KiB (107.32 MiB) | 102,272 KiB (99.88 MiB) | same bound |
| worst of the 240 phase B hooks (`%M`) | 109,532 KiB (106.96 MiB) | 96,520 KiB (94.26 MiB) | same bound |
| worker peak `VmHWM` (phase B, all stages) | 102,412 KiB (100.01 MiB) | 95,440 KiB (93.20 MiB) | same bound |
| worker peak `VmHWM` (during the hold itself) | 100,932 KiB (98.57 MiB) | 93,536 KiB (91.34 MiB) | reported |
| growth per 1,000 events | 4,840,472 bytes | 4,820,986 bytes | recorded, not gated |
| capture hooks (phase A) | p99 175.0 ms, 100.0% ≤ 300 ms (n=717) | p99 160.5 ms, 100.0% ≤ 300 ms (n=717) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 211 ms, max 896 ms, none over 1 s, 0 non-zero | n=240, p50 209 ms, max 862 ms, none over 1 s, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 29,482,752 bytes → 0 after the stop | 0 → peak 29,408,592 bytes → 0 | grows under a held reader, recycles after |
| spool files, highest sample or the end | 0 | 0 | 0, and the check reads the peak |
| load average at start | 0.56 0.41 0.68 | 0.85 0.91 0.86 | — |

Gated checks, both runs **pass**:

- `retained` — all 1,322 rows phase A left are still there after phase B, no missing and no
  duplicate source, no failed classification, and every session stored its `session_start`,
  `session_end`, `last_assistant_message` and `turn_end` exactly once; spool empty. A phase-A row
  whose classification failed is counted separately from one that failed closed on the hook's own
  300 ms budget: the first is the detector failing and fails the check, while the second is
  `src/capture.ts` refusing to store unscanned content (FR-018) and is load-dependent - neither leg
  of this pair produced one, while an earlier run of the same harness produced one on 24.x and none
  on 22.x, which is how the distinction came to be measured at all.
- `not-stuck` — `pending=0`, `liveBatches=0`, `endReason=stopped` and nothing else (the run throws
  when `observe --stop` fails, so an `idle_exit` end would mean the stop path never ran),
  `workerErrors=0`, no bad end reason, and no `worker-stop` sentinel left behind: a worker that
  cannot remove it only logs that, and the next worker would stop on it. 1,119 sources waiting and
  4 parked on each version, which is what `preset = "none"` produces - the check requires nothing
  to have been processed and something to be waiting, since with no summarizer neither could be
  otherwise. The spool count includes `spool/failed/`, so an entry recovery quarantined is a
  failure rather than an empty spool.
- `wal-recycled` — the WAL grows from 0 under the held reader (peak 29,482,752 bytes on 24.x and
  29,408,592 on 22.x) and is back to 0
  after the product's own stop path runs `wal_checkpoint(TRUNCATE)`; the check passes when the final
  size is at most a quarter of the peak. Seven `info batch` lines on each version were logged
  while the reader was held, so the growth is a worker writing against the held snapshot rather than an idle file.
- `rss-bound` — peak `VmHWM` under the 150 MiB bound on both versions, across every process of the
  run - 110,008 KiB (107.43 MiB) on 24.x and 103,172 KiB (100.75 MiB) on 22.x: the resident worker
  from the samples, and each of the 245 children from the kernel's own figure at exit (the replay,
  240 hooks, three `doctor` runs and `observe --stop`). A child that leaves no reading fails the
  check; none did. So does a resident the worker log names from the first sample onwards that no
  sample ever saw - a hook spawns its resident detached, so the hook's own `%M` does not cover it -
  and on both versions that count was 0. What the resident's figure cannot carry is growth inside
  the last interval of its life: `VmHWM` is a high-water mark, so every sample carries every peak
  before it, but once the process is gone `/proc` is gone with it, and the worker does not record
  its own peak when it ends. The gap is one sample interval, nominally 250 ms and longer whenever
  the timer is delayed: each run had one gap far wider than the rest, 928 ms on 24.x and 901 ms on
  22.x, both inside the hold, while every other gap was at most 252 ms. Load or a synchronous read
  can stretch it further. A wide gap matters only where it is the last one before a process exits.
  Closing that properly is #307.

Reported, not gated:

- injection p99 296.4 ms on 24.x with 98.9% ≤ 300 ms (n=378) and 290.0 ms with 99.5% on 22.x; the
  worst group is grok/`UserPromptSubmit` at p99 339.5 ms (24.x) and 326.8 ms (22.x).
- session start: ready max 254.0 ms (24.x) and 211.7 ms (22.x), n=1; pending max 220.9 ms and
  218.8 ms (n=48), with 46 of 48 packs carrying `summary_pending`.
- SC-009 recall 0/40, by construction of `preset = "none"`.
- no phase B hook on either version ran over a second in this pair of runs: the slowest was 896 ms
  on 24.x and 862 ms on 22.x, and all 480 exited 0. Earlier runs of this same harness did produce
  one to three hooks of around three seconds, so whether they appear at all varies between runs, the
  cause is not isolated, and hook cold start is tracked in #210.
- the phase B hook durations carry the `/usr/bin/time` wrapper's own startup, because the harness
  spawns those hooks itself. The phase A capture numbers do not: the replay is wrapped, but it times
  its hooks from inside.

## 10,000 events (#267)

The same harness, fed a 10,048-line fixture with `--fixture`. The fixture is generated with
`node scripts/fixtures/generate-1000-events.mjs --events 10000 --out <file>`, sha256 `758e26a0…`. The
phase A timeout scales with the line count.

| | Node 24.16.0 (`c075b647`) | Node 22.23.1 (`64e16e5a`) | Bound |
|---|---|---|---|
| peak `VmHWM`/`%M`, any process of the run | 131,132 KiB (128.06 MiB) | 134,220 KiB (131.07 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase A) | 114,644 KiB (111.96 MiB) | 108,884 KiB (106.33 MiB) | same bound |
| growth per 1,000 events | 4,870,125 bytes | 4,871,348 bytes | recorded, not gated |
| capture hooks (phase A) | p99 182.1 ms, 100.0% ≤ 300 ms (n=6,870) | p99 156.8 ms, 100.0% ≤ 300 ms (n=6,870) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 242 ms, max 460 ms, 0 non-zero | n=240, p50 220 ms, max 3,453 ms, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 33,145,432 bytes → 0 | 0 → peak 36,544,432 bytes → 0 | recycles after the stop |
| rows phase A left, kept after phase B | 12,761 / 12,761 | 12,761 / 12,761 | all |
| load average at start | 0.78 1.00 1.24 | 0.25 0.79 1.39 | — |

All four gated checks pass on both legs. Injection p99 (417.9 / 386.2 ms) is reported, not gated,
as in the 1,000-event run.

**What it took to get here.**

- The first pair of runs at `db346d3d` failed `rss-bound`: 178,952 KiB on 24.x and 180,688 KiB on
  22.x. Every product process was within the bound. Polling the replay driver's own `VmHWM` showed
  it flat at 125,204 KiB through the whole line loop, then stepping up in the last seconds. That was
  the evaluation reading `memory.db` (51 MB) and the other written files whole to search them for
  the planted secrets.
- #332 scans them a chunk at a time through one reused buffer. On the kept database: reading it
  whole cost +49.0 MiB, one `Buffer.concat` per chunk +50.5 MiB, and the reused buffer +1.3 MiB.
  That fix is what both rows above measure.
- The 24.x leg ran three times after #332. Two of them (v2 and v3, on `64e16e5a`) ended with the
  harness's own error, exit 2. In both, the resident worker logged `ERR_SQLITE_ERROR` during phase
  B's held-reader window, 3 s and 9 s into the hold. In the 2 s it then took to exit
  `storage_error`, captures from the phase B sessions went to the spool.
- The cause of that SQLite error is not identified: the logs carry only node:sqlite's generic code,
  not the result code. It did not occur in the third 24.x run or in either 22.x run.
- What made the run stop is separate and is #336. Spool recovery bound the spooled opening prompts
  of a phase B session to a `late_source` span with no work, as `contracts/work.md` requires. The
  harness then waited for a `pending = 0` that no run reaches without a work choice.
- #336 counts such sources apart from `pending` and makes the harness report them, not wait on them.
  It also logs the SQLite result code next to `ERR_SQLITE_ERROR`.
- The third run is the row above. `c075b647` is `64e16e5a` plus that logging change to
  `errorCode()`, made to name the error. No error occurred in it.

## What this run cannot say

- **Long-run growth.** A half-minute hold cannot show it. The seven-day run is #268.
- **Scale beyond 10,000.** The 100,000-event run is not measured (#267). The replay driver holds
  the whole fixture in memory. At 10,000 events its own peak during the line loop was 125,204 KiB,
  so a tenfold fixture is expected to exceed the bound. That is a projection, not a measurement.
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
  --json-out /var/tmp/oboete-t042/v30-24.16.0.json > /var/tmp/oboete-t042/v30-24.16.0.md
echo "exit=$?"
```

`node scripts/measure-resources.mjs --self-check` runs the harness's own assertions without touching
a temporary home. A run takes about seven minutes, four of them in the phase A replay. A failed run
keeps its temporary home and prints the path.

## Receipts

`/var/tmp/oboete-t042/v30-24.16.0.{md,json,observe.log}` and `v30-22.23.1.{md,json,observe.log}` (1,000
events). For 10,000 events: `10k-v4-24.16.0.*` and `10k-v2-22.23.1.*`. The runs before the fix are
`10k-24.16.0.*` and `10k-22.23.1.*`, with the driver poll in `10k-22.23.1.driver-vmhwm.txt`. The two
24.x runs that stopped are `10k-v2-24.16.0.*` and `10k-v3-24.16.0.*`, with their kept homes in
`10k-v2-24.16.0-home/` and `10k-v3-24.16.0-home/`. The
Markdown is the harness's own report; the JSON is the same data unrounded; `observe.log` is the
worker's log for the run, which is where `endReason`, `workerErrors` and the bad-end set are read
from.
