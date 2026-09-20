# Retained-history resource sweep (T042, SC-008)

What a worker costs while a reader holds the database open and capture keeps arriving. The harness is
`scripts/measure-resources.mjs`; it runs the product's own binaries against a temporary home and reads
only what the product writes or what this run itself started: `logs/observe.log` (including the
`run start pid=` the worker records there), `/proc/<pid>/stat` and `/proc/<pid>/status` of the
processes the harness spawned or that log names, the database and its WAL.

Run on 2026-09-21 against `ccee8219`, on both supported Node versions. An interactive session was
running on the same machine; the load at the start of each run is in the table.

## What it measures

- **Phase A** replays `test/fixtures/events-1000.jsonl` (1,051 lines) through the real hooks, with
  `[observer] preset = "none"`, and reads the replay's own bounds. The replay drives one-shot worker
  runs - 38 of them, `hookWorkerRuns` 0 - not a resident.
- **Phase B** runs against the resident worker the hooks spawn, and holds a read-only connection
  open for at least 20 seconds - `--hold-ms` is a floor,
  and the hold also carries the session-end hooks and the wait for a worker batch to overlap it, so
  the measured holds were 24.0 s on both versions - while 20 sessions of 9 prompts each keep capturing,
  sampling the database size, the WAL size, the spool and every one of the run's processes
  (`VmRSS`/`VmHWM`) about every 250 ms, then drains, stops and samples once more.

`preset = "none"` means no summarizer runs, so every source ends `waiting` as a deferred
`no_provider`. That is the point of the sweep: it measures the cost of holding retained history, not
the cost of generating from it. SC-009 recall is 0/40 for the same reason and is reported, not gated.

## Results

| | Node 24.16.0 | Node 22.23.1 | Bound |
|---|---|---|---|
| worker peak `VmHWM` (phase A) | 110,396 KiB (107.81 MiB) | 102,556 KiB (100.15 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase B, all stages) | 102,364 KiB (99.96 MiB) | 95,384 KiB (93.15 MiB) | same bound |
| worker peak `VmHWM` (during the hold itself) | 100,880 KiB (98.52 MiB) | 93,156 KiB (90.97 MiB) | reported |
| child process peak `VmHWM` (245 hook and CLI runs, none unmeasured) | 110,460 KiB (107.87 MiB) | 101,776 KiB (99.39 MiB) | same bound |
| growth per 1,000 events | 4,848,266 bytes | 4,832,677 bytes | recorded, not gated |
| capture hooks (phase A) | p99 170.8 ms, 100.0% ≤ 300 ms (n=717) | p99 160.9 ms, 100.0% ≤ 300 ms (n=717) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 201 ms, max 291 ms, 0 non-zero | n=240, p50 197 ms, max 293 ms, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 28,576,352 bytes → 0 after the stop | 0 → peak 28,638,152 bytes → 0 | grows under a held reader, recycles after |
| spool files at any sample | 0 | 0 | 0 |
| load average at start | 0.52 0.44 0.58 | 1.36 0.90 0.74 | — |

Gated checks, both runs **pass**:

- `retained` — all 1,322 rows phase A left are still there after phase B, no missing and no
  duplicate source, no failed classification, and every session stored its `session_start`,
  `session_end`, `last_assistant_message` and `turn_end` exactly once; spool empty.
- `not-stuck` — `pending=0`, `liveBatches=0`, `endReason=stopped`, `workerErrors=0`, no bad end
  reason. 1,119 sources waiting and 4 parked, which is what `preset = "none"` produces.
- `wal-recycled` — the WAL grows from 0 under the held reader (peak ≈ 28–29 MB) and is back to 0
  after the product's own stop path runs `wal_checkpoint(TRUNCATE)`; the check passes when the final
  size is at most a quarter of the peak. Seven (24.x) and six (22.x) `info batch` lines were logged
  while the reader was held, so the growth is a worker writing against the held snapshot rather than
  an idle file.
- `rss-bound` — peak `VmHWM` under the 150 MiB bound on both versions, across every process of the
  run: 110,460 KiB (107.87 MiB) on 24.x and 102,556 KiB (100.15 MiB) on 22.x. Each of the 245 child
  processes is watched while it runs, so a hook that lives and dies between two home samples is
  measured rather than skipped, and a child with no reading at all fails the check.

Reported, not gated:

- injection p99 290.3 ms on 24.x and 297.7 ms on 22.x, both with 99.2% ≤ 300 ms (n=378); the worst
  group is grok/`UserPromptSubmit` at p99 319.6 ms (24.x) and 314.3 ms (22.x).
- session start: ready max 213.0 ms (24.x) and 193.2 ms (22.x), n=1; pending max 305.9 ms and
  207.6 ms (n=48), with 46 of 48 packs carrying `summary_pending`.
- SC-009 recall 0/40, by construction of `preset = "none"`.
- no phase B hook ran over 300 ms in this run. Earlier runs of the same harness on a busier machine
  produced two or three hooks between 1.3 s and 3.2 s while everything else stayed under 300 ms, so
  the outlier tracks the machine rather than the change; hook cold start is #210.

## What this run cannot say

- **Long-run growth.** A half-minute hold cannot show it. The seven-day run is #268.
- **Scale.** 1,051 events is the fixture, not the 10,000- and 100,000-event runs of #267.
- **A real summarizer.** With `preset = "none"` nothing is generated, so neither the provider's cost
  nor recall is exercised here.

## How to re-run

The harness runs the published bundle, so build first, and give each Node version its own
`--json-out`. The harness's own exit code is the result - 0 all gated checks passed, 1 a check or a
hook failed, 2 the run could not be completed - so do not pipe it away:

```sh
npm run build
mkdir -p /var/tmp/oboete-t042
~/.nvm/versions/node/v24.16.0/bin/node scripts/measure-resources.mjs \
  --json-out /var/tmp/oboete-t042/v10-24.16.0.json > /var/tmp/oboete-t042/v10-24.16.0.md
echo "exit=$?"
```

`node scripts/measure-resources.mjs --self-check` runs the harness's own assertions without touching
a temporary home. A run takes about seven minutes, four of them in the phase A replay.

## Receipts

`/var/tmp/oboete-t042/v10-24.16.0.{md,json,observe.log}` and `v10-22.23.1.{md,json,observe.log}`. The
Markdown is the harness's own report; the JSON is the same data unrounded; `observe.log` is the
worker's log for the run, which is where `endReason`, `workerErrors` and the bad-end set are read
from.
