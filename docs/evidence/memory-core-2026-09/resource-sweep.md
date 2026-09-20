# Retained-history resource sweep (T042, SC-008)

What a worker costs while a reader holds the database open and capture keeps arriving. The harness is
`scripts/measure-resources.mjs`; it runs the product's own binaries against a temporary home and reads
only what the product writes or what this run itself started: `logs/observe.log` (including the
`run start pid=` the worker records there), `/proc/<pid>/stat` and `/proc/<pid>/status` of the
processes the harness spawned or that log names, the database and its WAL.

Run on 2026-09-20 against `1a83a019`, on both supported Node versions. An interactive session was
running on the same machine; the load at the start of each run is in the table.

## What it measures

- **Phase A** replays `test/fixtures/events-1000.jsonl` (1,051 lines) through the real hooks and the
  resident worker, with `[observer] preset = "none"`, and reads the replay's own bounds.
- **Phase B** holds a read-only connection open for 20 seconds while 20 sessions of 9 prompts each
  keep capturing, sampling the database size, the WAL size, the spool and every one of the run's
  processes (`VmRSS`/`VmHWM`) about every 250 ms, then drains, stops and samples once more.

`preset = "none"` means no summarizer runs, so every source ends `waiting` as a deferred
`no_provider`. That is the point of the sweep: it measures the cost of holding retained history, not
the cost of generating from it. SC-009 recall is 0/40 for the same reason and is reported, not gated.

## Results

| | Node 24.16.0 | Node 22.23.1 | Bound |
|---|---|---|---|
| worker peak `VmHWM` (phase A) | 111,036 KiB (108.43 MiB) | 103,336 KiB (100.91 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase B hold) | 102,356 KiB (99.96 MiB) | 94,816 KiB (92.59 MiB) | same bound |
| hook process peak `VmHWM` (phase B) | 97,968 KiB (95.67 MiB) | 91,760 KiB (89.61 MiB) | same bound |
| growth per 1,000 events | 4,844,369 bytes | 4,836,575 bytes | recorded, not gated |
| capture hooks (phase A) | p99 166.1 ms, 100.0% ≤ 300 ms (n=717) | p99 162.1 ms, 100.0% ≤ 300 ms (n=717) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 196 ms, max 3,192 ms, 3 over 1 s, 0 non-zero | n=240, p50 196 ms, max 3,095 ms, 2 over 1 s, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 28,011,912 bytes → 0 after the stop | 0 → peak 28,938,912 bytes → 0 | grows under a held reader, recycles after |
| spool files at any sample | 0 | 0 | 0 |
| load average at start | 0.71 0.91 0.91 | 1.11 1.04 0.96 | — |

Gated checks, both runs **pass**:

- `retained` — no missing and no duplicate source, no failed classification, and every session stored
  its `session_start`, `session_end`, `last_assistant_message` and `turn_end` exactly once; spool
  empty.
- `not-stuck` — `pending=0`, `liveBatches=0`, `endReason=stopped`, `workerErrors=0`, no bad end
  reason. 1,119 sources waiting and 4 parked, which is what `preset = "none"` produces.
- `wal-recycled` — the WAL grows from 0 under the held reader (peak ≈ 28–29 MB) and is back to 0
  after the product's own stop path runs `wal_checkpoint(TRUNCATE)`; the check passes when the final
  size is at most a quarter of the peak. Six `info batch` lines were logged while the reader was
  held, so the growth is a worker writing against the held snapshot rather than an idle file.
- `rss-bound` — peak `VmHWM` under the 150 MiB bound on both versions, across every process of the
  run: the resident worker and the short-lived hook processes alike.

Reported, not gated:

- injection p99 276.1 ms with 99.7% ≤ 300 ms (n=378) on 24.x and 99.2% on 22.x; the worst group is
  grok/`UserPromptSubmit` at p99 301.7 ms (24.x) and 310.3 ms (22.x).
- session start: ready max 222.2 ms (n=1); pending max 213.5 ms (n=48), with 46 of 48 packs carrying
  `summary_pending`.
- SC-009 recall 0/40, by construction of `preset = "none"`.
- three phase B hooks on 24.x and two on 22.x took about 3 s while every other hook stayed under
  280 ms. All exited 0. The 2026-09-17 run of the same harness on an idle machine had none, and
  these runs shared the machine with an interactive session, so the outlier is not attributed here;
  hook cold start is #210.

## What this run cannot say

- **Long-run growth.** A 20-second hold cannot show it. The seven-day run is #268.
- **Scale.** 1,051 events is the fixture, not the 10,000- and 100,000-event runs of #267.
- **A real summarizer.** With `preset = "none"` nothing is generated, so neither the provider's cost
  nor recall is exercised here.

## Receipts

`/var/tmp/oboete-t042/v8-24.16.0.{md,json,observe.log}` and `v8-22.23.1.{md,json,observe.log}`. The
Markdown is the harness's own report; the JSON is the same data unrounded; `observe.log` is the
worker's log for the run, which is where `endReason`, `workerErrors` and the bad-end set are read
from.
