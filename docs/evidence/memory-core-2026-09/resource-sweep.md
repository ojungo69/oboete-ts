# Retained-history resource sweep (T042, SC-008)

What a worker costs while a reader holds the database open and capture keeps arriving. The harness is
`scripts/measure-resources.mjs`; it runs the product's own binaries against a temporary home and reads
only what the product writes or what this run itself started: `logs/observe.log` (including the
`run start pid=` the worker records there), `/proc/<pid>/stat` and `/proc/<pid>/status` of the
processes the harness spawned or that log names, each child's peak resident size as the kernel
reports it through `/usr/bin/time -f %M`, the database and its WAL.

Run on 2026-09-21 against `fb805013`, on both supported Node versions. An interactive session was
running on the same machine; the load at the start of each run is in the table.

## What it measures

- **Phase A** replays `test/fixtures/events-1000.jsonl` (1,051 lines) through the real hooks, with
  `[observer] preset = "none"`, and reads the replay's own bounds. The replay drives one-shot worker
  runs - 38 of them, `hookWorkerRuns` 0 - not a resident. Its 1,143 hooks are the replay's own
  children, and `%M` for the replay covers them: it is the kernel's peak for a command and the
  descendants it waits for, taken at exit rather than sampled.
- **Phase B** runs against the resident worker the hooks spawn, and holds a read-only connection
  open for at least 20 seconds - `--hold-ms` is a floor, and the hold also carries the session-end
  hooks and the wait for a worker batch to overlap it, so the measured holds were 24.0 s - while 20
  sessions of 9 prompts each keep capturing, sampling the database size, the WAL size, the spool and
  the worker's `VmRSS`/`VmHWM` about every 250 ms, then drains, stops and samples once more.

`preset = "none"` means no summarizer runs, so every source ends `waiting` as a deferred
`no_provider`. That is the point of the sweep: it measures the cost of holding retained history, not
the cost of generating from it. SC-009 recall is 0/40 for the same reason and is reported, not gated.

## Results

| | Node 24.16.0 | Node 22.23.1 | Bound |
|---|---|---|---|
| peak `VmHWM`, any process of the run | 110,584 KiB (107.99 MiB) | 102,828 KiB (100.42 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase A, from the replay) | 110,584 KiB (107.99 MiB) | 102,828 KiB (100.42 MiB) | same bound |
| replay peak `%M` (covers its 1,143 hooks) | 110,312 KiB (107.73 MiB) | 101,572 KiB (99.19 MiB) | same bound |
| worst of the 240 phase B hooks (`%M`) | 109,812 KiB (107.24 MiB) | 96,304 KiB (94.05 MiB) | same bound |
| worker peak `VmHWM` (phase B, all stages) | 102,444 KiB (100.04 MiB) | 95,244 KiB (93.01 MiB) | same bound |
| worker peak `VmHWM` (during the hold itself) | 100,896 KiB (98.53 MiB) | 93,004 KiB (90.82 MiB) | reported |
| growth per 1,000 events | 4,832,677 bytes | 4,836,575 bytes | recorded, not gated |
| capture hooks (phase A) | p99 183.8 ms, 100.0% ≤ 300 ms (n=717) | p99 154.7 ms, 100.0% ≤ 300 ms (n=717) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 195 ms, max 275 ms, 0 non-zero | n=240, p50 198 ms, max 279 ms, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 28,749,392 bytes → 0 after the stop | 0 → peak 28,407,432 bytes → 0 | grows under a held reader, recycles after |
| spool files at any sample | 0 | 0 | 0 |
| load average at start | 0.99 1.35 1.33 | 1.65 1.39 1.34 | — |

Gated checks, both runs **pass**:

- `retained` — all 1,322 rows phase A left are still there after phase B, no missing and no
  duplicate source, no failed classification, and every session stored its `session_start`,
  `session_end`, `last_assistant_message` and `turn_end` exactly once; spool empty.
- `not-stuck` — `pending=0`, `liveBatches=0`, `endReason=stopped`, `workerErrors=0`, no bad end
  reason. 1,119 sources waiting and 4 parked, which is what `preset = "none"` produces.
- `wal-recycled` — the WAL grows from 0 under the held reader (peak ≈ 28.5 MB) and is back to 0
  after the product's own stop path runs `wal_checkpoint(TRUNCATE)`; the check passes when the final
  size is at most a quarter of the peak. Six `info batch` lines were logged while the reader was
  held, so the growth is a worker writing against the held snapshot rather than an idle file.
- `rss-bound` — peak `VmHWM` under the 150 MiB bound on both versions, across every process of the
  run: the resident worker from the samples, and each of the 245 children from the kernel's own
  figure at exit (the replay, 240 hooks, three `doctor` runs and `observe --stop`). A child that
  leaves no reading fails the check; none did.

Reported, not gated:

- injection p99 273.9 ms on 24.x with 99.7% ≤ 300 ms (n=378) and 284.3 ms with 99.5% on 22.x; the
  worst group is grok/`UserPromptSubmit` at p99 299.0 ms (24.x) and 316.6 ms (22.x).
- session start: ready max 189.5 ms (24.x) and 197.2 ms (22.x), n=1; pending max 206.8 ms and
  202.7 ms (n=48), with 46 of 48 packs carrying `summary_pending`.
- SC-009 recall 0/40, by construction of `preset = "none"`.
- no phase B hook ran over 300 ms in this run. Other runs of this harness produced one to three
  hooks between 1.3 s and 3.2 s while everything else stayed under 300 ms; it did not reproduce
  here, the cause is not isolated, and hook cold start is tracked in #210.
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
  --json-out /var/tmp/oboete-t042/v12-24.16.0.json > /var/tmp/oboete-t042/v12-24.16.0.md
echo "exit=$?"
```

`node scripts/measure-resources.mjs --self-check` runs the harness's own assertions without touching
a temporary home. A run takes about seven minutes, four of them in the phase A replay. A failed run
keeps its temporary home and prints the path.

## Receipts

`/var/tmp/oboete-t042/v12-24.16.0.{md,json,observe.log}` and `v12-22.23.1.{md,json,observe.log}`. The
Markdown is the harness's own report; the JSON is the same data unrounded; `observe.log` is the
worker's log for the run, which is where `endReason`, `workerErrors` and the bad-end set are read
from.
