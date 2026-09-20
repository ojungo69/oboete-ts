# Retained-history resource sweep (T042, SC-008)

What a worker costs while a reader holds the database open and capture keeps arriving. The harness is
`scripts/measure-resources.mjs`; it runs the product's own binaries against a temporary home and reads
only what the product writes or what this run itself started: `logs/observe.log` (including the
`run start pid=` the worker records there), `/proc/<pid>/stat` and `/proc/<pid>/status` of the
processes the harness spawned or that log names, the database and its WAL.

Run on 2026-09-20 against `2b633dab`, on both supported Node versions. An interactive session was
running on the same machine; the load at the start of each run is in the table.

## What it measures

- **Phase A** replays `test/fixtures/events-1000.jsonl` (1,051 lines) through the real hooks and the
  resident worker, with `[observer] preset = "none"`, and reads the replay's own bounds.
- **Phase B** holds a read-only connection open for at least 20 seconds - `--hold-ms` is a floor,
  and the hold also carries the session-end hooks and the wait for a worker batch to overlap it, so
  the measured holds were 25.4 s and 26.8 s - while 20 sessions of 9 prompts each keep capturing,
  sampling the database size, the WAL size, the spool and every one of the run's processes
  (`VmRSS`/`VmHWM`) about every 250 ms, then drains, stops and samples once more.

`preset = "none"` means no summarizer runs, so every source ends `waiting` as a deferred
`no_provider`. That is the point of the sweep: it measures the cost of holding retained history, not
the cost of generating from it. SC-009 recall is 0/40 for the same reason and is reported, not gated.

## Results

| | Node 24.16.0 | Node 22.23.1 | Bound |
|---|---|---|---|
| worker peak `VmHWM` (phase A) | 110,936 KiB (108.34 MiB) | 102,800 KiB (100.39 MiB) | < 150 MiB |
| worker peak `VmHWM` (phase B, all stages) | 101,512 KiB (99.13 MiB) | 94,908 KiB (92.68 MiB) | same bound |
| worker peak `VmHWM` (during the hold itself) | 100,188 KiB (97.84 MiB) | 93,052 KiB (90.87 MiB) | reported |
| hook process peak `VmHWM` (phase B) | 108,840 KiB (106.29 MiB) | 91,856 KiB (89.70 MiB) | same bound |
| growth per 1,000 events | 4,844,369 bytes | 4,852,164 bytes | recorded, not gated |
| capture hooks (phase A) | p99 162.2 ms, 100.0% ≤ 300 ms (n=717) | p99 155.0 ms, 100.0% ≤ 300 ms (n=717) | p99 ≤ 300 ms |
| phase B hooks | n=240, p50 214 ms, max 1,324 ms, 2 over 1 s, 0 non-zero | n=240, p50 196 ms, max 3,034 ms, 2 over 1 s, 0 non-zero | every hook exits 0 |
| WAL during the hold | 0 → peak 28,860,632 bytes → 0 after the stop | 0 → peak 28,984,232 bytes → 0 | grows under a held reader, recycles after |
| spool files at any sample | 0 | 0 | 0 |
| load average at start | 0.17 0.32 0.71 | 1.03 0.73 0.80 | — |

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

- injection p99 283.7 ms with 99.7% ≤ 300 ms (n=378) on 24.x and 279.2 ms with 99.5% on 22.x; the
  worst group is grok/`UserPromptSubmit` at p99 298.0 ms (24.x) and 313.9 ms (22.x).
- session start: ready max 197.5 ms (n=1); pending max 219.2 ms (n=48), with 46 of 48 packs carrying
  `summary_pending`.
- SC-009 recall 0/40, by construction of `preset = "none"`.
- two phase B hooks on 24.x (1,323 and 1,324 ms) and two on 22.x (3,030 and 3,034 ms) ran over a
  second; the slowest of all the others was 296 ms (24.x) and 271 ms (22.x). All exited 0. The 2026-09-17
  run of the same harness on an idle machine had none, and these runs shared the machine with an
  interactive session, so the outlier is not attributed here; hook cold start is #210.

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
  --json-out /var/tmp/oboete-t042/v9-24.16.0.json > /var/tmp/oboete-t042/v9-24.16.0.md
echo "exit=$?"
```

`node scripts/measure-resources.mjs --self-check` runs the harness's own assertions without touching
a temporary home. A run takes about seven minutes, four of them in the phase A replay.

## Receipts

`/var/tmp/oboete-t042/v9-24.16.0.{md,json,observe.log}` and `v9-22.23.1.{md,json,observe.log}`. The
Markdown is the harness's own report; the JSON is the same data unrounded; `observe.log` is the
worker's log for the run, which is where `endReason`, `workerErrors` and the bad-end set are read
from.
