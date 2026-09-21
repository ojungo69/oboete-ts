# oboete

## What it is

oboete captures what happens in a coding session on this machine, writes summaries in the
background, and injects the relevant decisions, discoveries, and next actions into the next
session of Claude Code, Codex, Grok Build, or Pi. What it injects is bounded, not everything it
knows: a pack is sized from an estimate of the model's context window, five percent of it by
default (`[injection] context_fraction`, up to 0.5), with a further cap of 10,000 characters for
Claude and Grok. It skips what this conversation already received in the current context epoch,
so a compaction lets a memory come back. A related memory that was injected once and left
untouched for ninety days stops being offered; one that was never injected stays a candidate. The
session-start pack draws its pinned memories and its checkpoint from a different path, which
retirement does not filter — though budget, privacy and duplicate checks still apply there, so
selection is eligibility, not a promise. Retirement is about the prompt, not the store — a retired
memory is still there, and `oboete search`, `oboete get` and `oboete why` still find it. All four agents share one SQLite store; the
boundaries are sensitivity and repository, never which agent produced a memory. There is no
subscription: capture and lexical search work with zero credentials, and a remote summarizer is
optional after an explicit consent screen.

## Status

This is milestone M1, version `0.1.0-alpha.0`. It is a self-use alpha: the maintainer dogfoods it
under an isolated Linux user, and it is not a supported public package. Install it from a packed
tarball built from a checkout. Publication to the npm registry is milestone M3.

Device sync exists and is not the M2 feature: `oboete sync` moves memories between your own
machines as encrypted bundles in a shared directory, and never opens a network connection.
Encrypted remote sync through R2 and semantic (vector) search are milestone M2 and are not
implemented.

macOS is partly qualified. The whole engine gate passes on an M1 iMac on both supported Node
versions; the macOS runner in continuous integration still fails the hook cold start on its timer
spread and occasionally a one-off timing test (#256), which are recorded rather than counted as
passes. Agent probes on macOS are unverified because neither machine has an agent command line
installed (#269). macOS therefore remains milestone M4 as a supported platform, and Windows
support is milestone M5.

The previous implementation is preserved under [`legacy/`](legacy/README.md) as read-only evidence.

## Shape

- One SQLite file, `~/.oboete/memory.db`, is the product. There is no remote procedure call, and
  the only port oboete ever binds is the loopback port of `oboete view` while that command runs in
  the foreground.
- Summarization runs in a detached worker. By default that worker stays resident between hooks and
  exits after fifteen minutes idle (`[worker] resident`, `idle_exit_ms`). `oboete observe
  --resident` starts one by hand, `oboete observe --stop` ends it, and a plain `oboete observe`
  is a single bounded run.
- Hooks are short-lived processes. A capture hook has 300 ms from process start; a native hook that
  also delivers an injection has 1,300 ms, because delivery has to wait for the pack. Pi splits the
  two: its session start gets 1,300 ms and each prompt injection gets 300 ms.
- All four agents share one store. Boundaries are sensitivity and repository, never the agent, and
  within a repository a memory is also scoped by audience: the project, one work item, or a
  personal projection you approved.
- Sensitivity is decided at capture and fails closed; availability fails open. Secrets captured
  here are redacted before the first write. Material that arrives through `oboete import` is
  stored in quarantine first and classified locally afterwards, so it should be sanitized before
  it reaches you.
- Observer LLM: Cloudflare Workers AI free tier by default, a named OpenAI-compatible preset
  otherwise, and a rule-based fallback when neither is reachable. There is no Anthropic preset
  (owner decision A19).
- TypeScript on Node.js >= 22.16 with `node:sqlite`; the schema and command-line contract are the
  seam for any later rewrite.

The full set of rules is in [`CONSTITUTION.md`](CONSTITUTION.md).

## Milestones

| Milestone | Scope |
| --- | --- |
| M1 | Self-use Alpha: four agents, web viewer, doctor, isolated dogfood |
| M2 | Encrypted R2 sync, hybrid lexical + vector search |
| M3 | npm publication |
| M4 | macOS, private MCP link |
| M5 | Windows |

## Requirements

| | |
| --- | --- |
| Node.js | 22.16 is the engine minimum (`engines.node` is `>=22.16`, and `node:sqlite` is unflagged there). 24.x is recommended and is what the isolated dogfood account runs, because Pi 0.84.4 requires Node.js >= 22.19. Continuous integration exercises 22.16.0 and 24.x. |
| Operating system | Linux today (including this Windows Subsystem for Linux host). The engine gate passes on an M1 iMac on both Node versions; the macOS CI runner still fails a cold-start timing check (#256), and agent probes there are unverified (#269), so macOS stays milestone M4 and Windows milestone M5. Paths go through `os.homedir()` and `node:path`; there is no Unix-socket, `flock`, or bash-only hook. |

## Install

From a checkout of this repository, after `npm ci` and `npm run build`:

```bash
npm pack
npm install -g ./oboete-0.1.0-alpha.0.tgz
```

The packed tarball name follows `package.json` `version`. `npm run pack-check` builds, packs,
installs into an empty prefix, and prints the installed size; the recorded pass on 2026-09-06 is
20.280 MB against a 30 MB limit ([docs/evidence/m1-resource-envelope.md](docs/evidence/m1-resource-envelope.md)).

Data lives in one directory: `~/.oboete/`, or the directory named by `OBOETE_HOME` when that
variable is set (a relative value is resolved against the home directory, so every process agrees).
That directory holds `memory.db`, `config.toml` (preset, model, consent record), `spool/` with its
`failed/` and `pi-ack/` subdirectories, `logs/`, the `paused` and `worker-stop` markers, a
`cache/compile` directory the launcher writes, and, once you configure device sync, a `sync/`
directory holding the space key. The key file is owner-readable only; treat it the way you would
treat an SSH private key.

Provider credentials never live in `config.toml`: they come from `OBOETE_*` environment variables.
Two things are deliberately outside that rule. The `agent-cli` preset has no credential of its
own — it runs the agent you already log into, and uses that login. And device sync reads its key
from the file above rather than from the environment.

The database migrates itself: an ordinary open applies any pending migrations up to schema 8, and
an active worker can hold that migration off until it finishes. A database that a newer bundle has
already migrated is refused by an older one, so keep a copy of `memory.db` before you install an
older build.

## Setup

```bash
oboete setup
oboete setup --agents claude,codex,grok,pi --provider workers-ai --accept-egress
oboete setup --provider ollama
oboete setup --provider none
oboete setup --yes
oboete setup --remove
oboete setup --agents claude --remove
```

`--agents` is a comma-separated list of `claude`, `codex`, `grok`, and `pi`. When omitted, setup
wires every installed agent. Named agents are reported even when they are not installed. `--provider`
is one of `workers-ai`, `ollama`, `nim`, `openrouter`, `gemini`, `agent-cli`, or `none`. `--json`
prints the same report as a JSON object.

What setup writes, one line each:

- Claude Code: oboete-owned handlers (`"oboete": true`) in `~/.claude/settings.json` (or
  `CLAUDE_CONFIG_DIR`), then `claude mcp add oboete --scope user -- <node> <bundle> mcp`.
- Codex: matcher groups in `~/.codex/hooks.json` (or `CODEX_HOME`) and a managed block in
  `config.toml` next to it, holding `[hooks.state."<path>:<event>:<group>:<handler>"]
  trusted_hash` rows plus `[mcp_servers.oboete]`.
- Grok Build: `~/.grok/hooks/oboete.json` (or `GROK_HOME`) and a managed block in `~/.grok/config.toml`
  with `[mcp_servers.oboete]` (`enabled = true`). Grok rewrites that file without comments on an
  update; setup recognizes its own table without the markers and puts the block back.
- Pi: the loader `~/.pi/agent/extensions/oboete.js`, which imports `piExtension` from the packed
  `pi-extension.mjs`. Setup writes that path only. If `PI_CODING_AGENT_DIR` points somewhere else,
  setup refuses rather than writing to a directory Pi may not read; unset it, or copy the loader
  into your own directory by hand.

The consent screen exists because a remote preset would send memory material off this machine.
Setup prints the tuple it is bound to — preset, destination host, credential source, cost class,
and sensitivity classes that would be sent — and refuses to write the destination until that tuple
is accepted. `--accept-egress` accepts the tuple shown now. `--yes` accepts only when the stored
consent hash already equals the hash of that same tuple; a changed host, credential source, cost
class, or egress class refuses `--yes`. Local presets (`ollama`) and `none` do not require that
confirmation. A refused run leaves the previous destination unchanged (exit 2) and prints:

```
Setup changed nothing: this destination has not been consented to.
Accept it with `oboete setup --accept-egress`, or with `oboete setup --yes` once a stored
record matches the tuple above. `oboete setup --provider ollama` keeps everything on this machine.
```

`oboete setup --provider ollama` keeps summarization on this machine (`127.0.0.1:11434`). That
preset ships no default model, so set one before it can summarize:

```toml
[observer]
preset = "ollama"
model = "llama3.1:8b"
```

The `agent-cli` preset also requires a non-empty `model` value, but it does not pass it on: the
agent's own command line chooses the model. Set it to the name you want recorded and expect the
agent's selection to win.

The `none` preset stores no provider: memories are written by rule alone. When the chosen preset
has no credentials, setup prints the Cloudflare free-account steps (for `workers-ai`) or `Export
that variable in the shell that runs the agents.`, then continues. If you have configured fallback
providers, setup reports which of them it will try instead; with none configured, capture keeps
working and summarization falls back to rules.

Every run that gets past the gate prints a per-agent table of `wired`, `probe`, `trust`, and
`native memory`, and this launch line:

> Open the memory viewer with `oboete view --open`.

Exit 1 if any probe failed or the database could not be opened. `--remove` takes the handlers back
out and keeps the consent record.

### Provider presets

| Preset | Destination host | Credential variables | Cost class | Daily cap |
| --- | --- | --- | --- | --- |
| `workers-ai` (default) | `api.cloudflare.com` | `OBOETE_CF_API_TOKEN` and `OBOETE_CF_ACCOUNT_ID` | `free-tier` | 150 HTTP attempts per Coordinated Universal Time day |
| `ollama` | `127.0.0.1:11434` | none | `local` | none |
| `nim` | `integrate.api.nvidia.com` | `OBOETE_NIM_API_KEY` | `remote` | 150, shared with the other capped presets |
| `openrouter` | `openrouter.ai` | `OBOETE_OPENROUTER_API_KEY` | `remote` | 150, shared |
| `gemini` | `generativelanguage.googleapis.com` | `OBOETE_GEMINI_API_KEY` | `remote` | 150, shared |
| `agent-cli` | `agent-cli child process` (`claude -p`, `codex exec`, or `grok -p`) | the agent's own login (`observer.agent_cli`, default `claude`) | `own-subscription` | none (the subscription is billed instead) |
| `none` | none | none | `none` | none |

There is no `anthropic` preset. Consent for `agent-cli` also prints that every summary is billed to
that subscription rather than to an oboete allowance. The default Workers AI model is
`@cf/zai-org/glm-4.7-flash`; the observer asks it not to emit its reasoning
(`chat_template_kwargs.enable_thinking = false`), which keeps a call at a few seconds and a few
neurons instead of 25 to 45 seconds and 60 to 136 neurons (measured on 2026-09-06). `[observer]
model` in `config.toml` overrides the model.

## Doctor

```bash
oboete doctor
oboete doctor --probe-provider
oboete doctor --no-probe-agents
oboete doctor --json
```

`--probe-provider` makes a live summarizer call. Most outcomes settle in one attempt; a retryable
HTTP failure or an unusable, empty or truncated answer is retried once, so a probe can cost two
attempts against the daily cap when the preset is capped. An answer over 1 MB is refused without a
retry. It can also send nothing at all —
a missing configuration, a consent mismatch or an exhausted allowance is reported before any
request. Without the flag, the `provider` item reports what it can decide from configuration alone
and otherwise quotes the last worker outcome. `--no-probe-agents` skips the headless wiring probe;
the static verdicts still apply, so an agent that is not installed is reported as such and one
whose wiring is missing is `degraded` without a probe.

Every item has the shape `{ item, status, reason, consequence, recovery }`. The four statuses are
`healthy`, `warning`, `unverified`, and `degraded`. `warning` and `unverified` do not change the
exit code. Exit 0 when nothing is `degraded` and storage integrity passed. Exit 1 when any item is
`degraded`. Exit 3 when storage integrity failed (the file is not a database, the header is
corrupt, or `PRAGMA quick_check` is other than `ok`). Invalid flags exit 2.

Items include the configuration-file check, `paused`, `storage`, `fts`, `migration`, `worker`,
`spool`, `provider`, `allowance`, `catalog` (Workers AI only), `agent:claude`, `agent:codex`,
`agent:grok`, `agent:pi`, `native-memory:<agent>` when that agent's own memory feature is on,
`unrecognized-agents`, and `pi` (Pi capture-child diagnostics). Doctor always prints:

> M1 search is lexical (word match). Semantic search arrives in M2.

> Open the memory viewer with `oboete view --open`.

Example of a degraded storage item (exit 3):

```
item     status    reason
storage  degraded  The file is not a SQLite database (its header is not the SQLite format).
  consequence: Hooks spool every event; nothing is summarized, injected or searchable until storage is repaired.
  recovery: Back up the file; run `oboete export` if it is readable; move the database aside; run `oboete setup`; then `oboete import` the export.
```

## Everyday commands

Exit codes shared by these commands: 0 success or an explicit empty result, 1 target not found or
partially degraded, 2 invalid input, 3 storage or input/output failure. Agent-invoked commands
(`hook`, `capture`, `inject`) always exit 0.

- `oboete search <query> [--limit N]` — same-repository active memories by lexical relevance
  (working directory); an empty result exits 0 with `No memories matched this query in the current
  repository.` and the lexical note. `--limit` accepts 1 to 50 and defaults to 10, and a very long
  query is indexed on at most 128 distinct terms, the longest ones first.
- `oboete timeline [--session <id>]` — sessions, turns, and memory metadata of the current
  repository; empty list exits 0. The list is the 50 most recent sessions, with no pagination past
  them.
- `oboete get <memory-id>` — one memory inside the current repository; exit 1 if absent or outside
  that boundary (`Memory <id> was not found in the current repository.`).
- `oboete pin <id> [--order N]` / `oboete unpin <id>` — pin state; exit 1 if the memory is not in
  the current repository.
- `oboete delete <id>` — tombstone; the same normalized title and body is not re-created; exit 1 if
  not found.
- `oboete why <session-id> [--turn N] [--json]` — injection ledger (included, omitted, trims,
  staleness, deferred deliveries, degraded sentence plus reason code); exit 1 if the session is not
  in this repository. Two of its sections are bounded: generation reports at most 100 sources, each
  with at most 20 linked memory identifiers and 20 deliveries, and the checkpoint section at most
  100 decisions with at most 50 source identifiers each and at most 20 historical actions per
  source. The injection ledger is not capped — every injection of the
  session is listed with its items.
- `oboete pause` / `oboete resume` — create or remove `~/.oboete/paused` without opening the
  database. Pause prints: "Capture and injection are paused. Run `oboete resume` to continue;
  existing memories are untouched." Exit 0.
- `oboete view [--port N] [--open]` — Preact viewer on `127.0.0.1` with a per-launch token in the
  printed URL (`http://127.0.0.1:<port>/?token=...`); `--open` launches the browser on that URL;
  a non-loopback host exits 2. Its lists show at most 200 memories, and at most 50 search or
  timeline rows.
- `oboete export [file|-] [--format 1|2]` — JSON Lines. Format 2 is the default and carries the
  provenance, context, work, visibility and proposal records as well as the memories; `--format 1`
  writes the older memory-only file for a destination that cannot read v2. Secret rows and
  tombstones travel as hashes with empty title and body in both.
- `oboete import [file|-] [--dry-run|--apply] [--json]` — a merge validated line by line for the
  native formats; a `--from claude-mem` file is one JSON object, read whole and adapted. **A
  format 2 file and a claude-mem file are previewed unless you pass `--apply`**; only the older
  format 1 applies by default. Since export now writes format 2, a restore is
  `oboete import backup.jsonl --apply` — into a database that already exists at the current schema.
  A format 2 apply checks the destination first and exits 2 with `destination_schema_not_ready`
  when it is missing, behind or ahead. On a new machine the database is created by a setup run that
  gets past the consent screen — `oboete setup --provider none` does, a bare `oboete setup` on the
  default remote preset stops there and writes nothing — so set up first, then restore.
  Newly inserted readable memories land quarantined, at `local_only` or stricter and
  `review_state = imported`, and stay out of search and injection until the worker classifies them;
  a row that matches a memory you already have keeps your review state, and an incoming label never
  weakens your sensitivity.
  The mappings differ by source. A native file takes `--map-repo <old-id>=<current-id>`, which
  maps a machine-local (`common_dir`) repository identity from another installation onto one here,
  and `--map-work <old-work-id>=<local-work-id>`. A claude-mem file takes `--map-project
  <exact-name>=<repo>` or `--map-project-hash <sha256>=<repo>` instead, and mixing the two sets is
  refused. `--map-context <local-repo-id>=<local-context-id>` names a privacy context in this
  installation, not one from the file. Each mapping list holds at most 1,000 entries. Limits differ by format: 64 KiB per line for v1, 4 MiB per line for v2, 256 MiB per
  native file, and 5 MiB with at most 20,000 records for a claude-mem file. A secret row that
  carries text or concepts is refused, and so is a source attached to it that carries evidence, a
  citation value, a capture root, source paths or a producing agent. Format 2 still carries that
  memory's source records with the content-bearing fields cleared and the rest of the provenance
  intact; format 1 has nowhere to put them and writes no sources at all, so a v1 backup of a
  secret or deleted memory restores less. Exit 2 on an invalid file.
- `oboete import promote <migration-record-id> --work <local-work-id>` / `oboete import promote
  --list` — promotes one imported **sharing proposal** that local classification has cleared,
  creating a pending proposal for you to approve; it is not a way to release arbitrary quarantined
  memories. `--list` prints up to 100 imported sharing-proposal records, each marked with whether
  it can be promoted, and says how many it left out.
- `oboete mcp` — stdio JSON-RPC server under the current working directory, exposing `search`,
  `timeline` and `get`, plus `work_status`, `work_choose`, `sharing_status` and `sync_status`. Of
  those, only `work_choose` changes anything. Approving a sharing proposal is done in the CLI or
  the viewer; pushing, pulling and resolving sync are CLI-only, because the viewer has no route
  for them. A repository identifier in the
  tool arguments is refused (JSON-RPC `-32602`); extra command arguments exit 2; otherwise exit 0
  when stdin closes. Pi keeps its own narrower surface of three tools.
- The status surfaces are listings, not inventories: `work status` returns at most 50 work items and
  50 bindings even with `--all`, `share status` at most 50 proposals, and `sync status` at most 200
  conflicts, withheld origins and unmapped repositories each. Each says that more exist.

`oboete observe` is the detached worker (a hook starts it when work is queued, and by default it
stays resident until fifteen minutes idle). `oboete sync init <dir>`, `join`, `push`, `pull`,
`status`, `resolve`, `key show`, `map-repo` and `leave` move memories between your own machines
through encrypted bundles in a shared directory; there is no network transport. The directory has
to exist already and may not sit inside — or contain — your oboete home, `key show` and `join`
need a terminal, and a pull reads at most 32 other replicas' bundles. A push writes the whole
revision log as one snapshot and refuses it rather than splitting it when it passes a bound: 256
MiB of plaintext, 4 MiB for a single line, a million revisions, or 4,096 repositories. A new space syncs the
`eligible`, `local_only` and `private` classes unless `--classes` narrows it.

## Privacy model

**What is captured.** Prompts, tool inputs and outputs, last assistant messages, and compaction
summaries, after secret detection. Observation granularity follows claude-mem: those events are
given to the observer; only summaries are stored as memories.

Not every agent supplies every event. Codex's Stop hook receives no assistant text — the final
message goes to `codex exec --output-last-message` instead — so a Codex turn is recorded as a turn
end with no message. Compaction summary text is missing for Codex and for Grok Build alike: both
contracts carry the fact that a compaction happened and no summary, so the record is the event
without its text. Claude and Pi supply both.

A hook keeps at most 256 KiB of the event from standard input — it reads one byte further only to
know that there was more — and it does this on every invocation, so replaying an oversized event
truncates it again. What happens to the retained prefix depends on it. If it is still valid JSON,
capture takes the ordinary path and the row is stored like any other — it carries no truncation
marker, because only the unparsed path records one. If it is not, the row is stored as a
partial capture, whose truncated text is kept out of the summarizer and never promoted into a
memory. If the session identifier itself fell beyond the prefix, nothing is stored at all and a
counter is incremented instead. In the partial case the metadata is not withheld the way the text
is — the paths a readable prefix named can still reach a rule-based change record or a session
summary — so read the guarantee as one about the text. An event well under that bound can lose
content too: the rendered input of a tool call is kept to 20,000 characters and its path list to 50
entries before the row is written. A shell command is not rendered that way and is not held to that
cap; the 256 KiB read above is what bounds it. A path past the fiftieth can still appear in text
the call carried, such as a patch.
Repository rules in `.oboete.toml` are bounded too: at most 64 entries of at most 256 characters
each.

**What never is.** Secret values (redacted to `[REDACTED:<rule>]` before the first write, including
the spool). Text wrapped in `<private>` tags, including an unclosed tag through the end of the
field (removed, not stored). Credentials of other agents' sessions or subscription stores (FR-016,
FR-043). The producing agent as an eligibility key. Injected pack text, which is marked
`oboete memory context` … `end of oboete memory context` and is not summarized again. Verbatim
tool output in a pack (packs quote summarizer output or rule-based records, each line prefixed
with `> `).

**Sensitivity classes** (lattice `secret` > `private` > `local_only` > `eligible`; stricter wins):

| Class | How it is reached | Where it may go |
| --- | --- | --- |
| `eligible` | A `local_only` row whose worker detector and entropy checks pass | Remote summarizer; local summarizer of the same repository; injection of the same repository; device sync |
| `local_only` | Default at capture | Local summarizer of the same repository; injection of the same repository; device sync when the space admits the class; never a remote summarizer until promotion |
| `private` | Never promoted once set; import may carry it. Capture does not assign this class: `<private>` tags are stripped instead | Local summarizer of the same repository; injection of the same repository; device sync when the space admits the class; never a remote summarizer |
| `secret` | Secretlint, gated entropy, a repository path rule in `.oboete.toml`, or a detector failure that fails closed | Nowhere. `isAllowed` returns false for every destination. The export file carries hashes only |

**Secret detection before any write.** The hook runs the detector (private strip, path rules,
`@secretlint/core` with the recommend preset, gated entropy, and the process's own credential
variables — `OBOETE_CF_ACCOUNT_ID` and any `OBOETE_*` name ending in `_API_KEY` or `_API_TOKEN`,
whose value is at least eight characters) before the first write anywhere, including the spool.
This is a guarantee about capture. Material that arrives through `oboete import` is written to
quarantine first and classified afterwards, by the same detector, in the worker. A detector throw, a deadline, or a
malformed `.oboete.toml` stores metadata only (`classification_state = failed`) and never the
unsanitized payload. Availability fails open: capture still exits 0.

**Path rules and symbolic links.** A path from an agent is matched as written and relative to the
repository, both with and without its symbolic links resolved; a path written absolute is also
matched in its resolved absolute form. At capture, an absolute rule is also compared with a relative
path (a Codex patch, a Pi read) made absolute against the agent's working directory; a relative rule
is not. The worker's later checks of
stored sources still resolve a relative path against the repository root (#260). An absolute rule in
`~/.oboete/config.toml` is matched both as written and resolved too. A rule in a repository's
`.oboete.toml` is matched only as written, because it arrives with a clone and oboete does not look
up paths a commit chose. Write repository rules relative to the repository (`secrets/**`); put
absolute rules in `config.toml`.

**Repository boundary.** Identity is the normalized git remote (userinfo, query, and fragment
removed) or the realpath of `git rev-parse --git-common-dir`. Injection, search, timeline, get,
the Model Context Protocol tools, and the viewer all use that same-repository scope, with one
exception: an approved personal projection is readable wherever you are, because you approved that
exact text. Nothing else widens the scope, and cross-repository search is milestone M2 or later.

**Audience inside a repository.** Being in the same repository is necessary, not sufficient. A
memory is readable when it belongs to the project, or to the work item you have selected, or is a
personal projection whose sharing proposal you approved — and a personal projection is the one
thing that crosses repositories, because you approved that exact text. When a worktree has more
than one active work item and nothing says which one you mean, work selection is withheld rather
than guessed: `oboete work status` shows the choice and `oboete work choose <binding-id>
<work-id|new>` makes it. `oboete share status`, `share approve` and `share reject` decide the
personal proposals. `share adopt <memory-id>` is a different move: it takes a memory of the work
you have selected and widens it to the whole project — and it needs
`--binding <binding-id>` in exactly the case above, since without a single active work item there
is no selection to widen.

**What leaves the machine.** Only after the consent screen, and only `eligible` rows plus an
opaque repository id, to the destination host of the consented remote preset (Cloudflare
`api.cloudflare.com` by default). `ollama` stays on `127.0.0.1:11434`. `none` and the rule-based
fallback make no network call. The consent hash is recomputed before every reservation and again
immediately before send; a mismatch makes no call and degrades with `consent_changed`.

**Agent boundary.** Another agent's memories are shared by design. The `agent` column is
provenance only. Eligibility is sensitivity and repository, never the producing agent (FR-005,
User Story 1). Setup and doctor warn when Claude auto-memory, Codex memories, or Grok native
memory is enabled; oboete neither reads those stores nor changes them (FR-032, FR-043).

**Export.** Format `oboete-export/2` by default, with `--format 1` for a destination that reads
only the older memory-only file. A secret row or a tombstone is written with empty `title`, `body`
and `concepts`; the hashes remain so the other side can still recognize the same content.

## Degraded modes

When no summarizer is reachable, or the daily allowance is exhausted, a rule-based observer writes
records in the same schema. Packs add a `> degraded:` line that is a full sentence; the reason
code stays in the ledger, `oboete why`, and `oboete doctor`.

Rule-based operation is a holding pattern, not a substitute. The sources it covers stay accepted
but unprocessed, waiting for a summarizer, and no work checkpoint is produced for them. That
matters for retention: a source that a summarizer processed gets a 30-day expiry, while an
unresolved one and the evidence a memory still cites are kept. Running with `preset = "none"`
indefinitely therefore keeps raw captured content indefinitely.

Before falling back, the worker tries the providers you configured as fallbacks, in order — at
most three entries, filtered by the cost policy, and included in the consent record, so adding one
is a change you accept in `oboete setup`. Three outcomes end the chain instead of moving to the
next target: a consent record that no longer matches the settings (`consent_changed`), an answer
the worker could not use (`unusable_output`), and an answer in the wrong language twice over
(`language_mismatch`), which goes straight to the rules. Otherwise the rules are used once every
admitted target has failed.

| Reason | Sentence in a pack | What doctor says |
| --- | --- | --- |
| `summary_pending` | Some information for the selected work is still waiting to be processed. Its checkpoint and recent activity may be incomplete. | Not a doctor item; the pack is built immediately and carries labelled recent activity — at most six entries, each excerpted to 200 characters of its own text, which a tool call carries after the tool name — rather than waiting for generation. |
| `index_unavailable` | The memory index could not be read this time, so some notes are missing. | `fts` degraded: "Search and injection return nothing until full-text search is back (packs say `index_unavailable`)." |
| `empty` | There is nothing recorded for this repository yet. | Not a doctor item. |
| `window_unknown` | The context window of this model is not documented yet, so a deliberately small amount of text was selected. | Not a doctor item; Grok Build reports no model, so the smallest verified window is used. |
| `no_tool_call` | This turn ran no tool, so these notes could not be handed over. | Not a doctor item; Grok Build deferred delivery, recorded in `oboete why`. |
| `not_delivered` | These notes could not be handed over during this turn and stay available for the next one. | Not a doctor item; Grok Build deferred delivery, recorded in `oboete why`. |
| `no_provider` | No summarizer is configured, so these are rule-based notes. | `provider` degraded: "No observer provider is configured." Consequence: "Summaries come from the rule-based fallback only (packs say `Degraded:`)." |
| `unreachable` | The summarizer could not be reached, so these are rule-based notes. | `provider` degraded with the worker's sentence (`Provider request failed.` or `… with HTTP <status>.`). |
| `unusable_output` | The summarizer returned an unusable answer, so these are rule-based notes. | `provider` degraded with the worker's sentence (for example `Provider response was not valid JSON.`). |
| `language_mismatch` | The summarizer answered in another language than the content, so these are rule-based notes. | Surfaced on the provider item when that was the last outcome; otherwise in `oboete why`. |
| `daily_cap` | Today's free summary quota is used up, so these are rule-based notes. | `allowance` / `provider` degraded: "The daily cap of 150 calls is used up." |
| `provider_exhausted` | The summarizer's free allowance is used up, so these are rule-based notes. | `allowance` / `provider` degraded: "The provider reported exhaustion today." |
| `provider_paid` | The configured model is not on the free plan, so these are rule-based notes. | `provider` degraded as `provider_paid`; `catalog` warns when the Workers AI list includes paid-only models. |
| `auth_failed` | The summarizer rejected the credentials, so these are rule-based notes. | `provider` degraded: `Provider authentication failed.` Recovery: the credential steps for the preset. |
| `consent_changed` | The summarizer settings changed after consent was given, so these are rule-based notes. | `provider` recovery: `oboete setup --accept-egress`. |
| `model_alias` | The configured model resolved to a different one, so these are rule-based notes. | `provider` degraded: `The provider returned a different model id.` |
| `timeout` | The summarizer did not answer in time, so these are rule-based notes. | `provider` degraded: `The provider call timed out after 30 seconds.` (the probe deadline; the worker allows 60 seconds). |
| `rule_based` | These notes were written by the built-in rules rather than by a summarizer. | Used when local-only rows went to the fallback by design next to a healthy remote preset. |

The daily cap is 150 HTTP attempts per Coordinated Universal Time day, summed across the capped
presets (`workers-ai`, `nim`, `openrouter`, `gemini`). Attempt 150 is allowed; attempt 151 is
refused and the batch is labelled `daily_cap`. When 10 or fewer calls remain, ten-turn batches go
to the fallback and the remainder is reserved for session-end batches. `ollama` and `agent-cli`
are not counted. A provider 429 with body code 3036 writes `exhausted_at` (labelled
`provider_exhausted`) even if the worker then loses the lease. Search is lexical in M1 (word
match, with a Chinese/Japanese/Korean bigram index); semantic search arrives in M2.

## Agents

**Claude Code.** Setup merges command handlers into `~/.claude/settings.json` and registers the
stdio server with `claude mcp add oboete --scope user`. Packs print on `SessionStart` when `source`
is `startup`, `clear`, or `compact`, and on `UserPromptSubmit`. Tools appear as
`mcp__oboete__search`, `mcp__oboete__timeline`, and `mcp__oboete__get`. Details:
[docs/agents/claude.md](docs/agents/claude.md).

**Codex.** Setup writes `~/.codex/hooks.json` and the `trusted_hash` rows Codex requires before it
will run a handler, plus `[mcp_servers.oboete]`. Injection is `hookSpecificOutput.additionalContext`
on `SessionStart` (`matcher` `startup|clear|compact`) and on `UserPromptSubmit`, which also carries
the session-start pack when the current epoch has none yet (A21). Tools appear as
`mcp__oboete__search` and the same for `timeline` and `get`. Details:
[docs/agents/codex.md](docs/agents/codex.md).

**Grok Build.** Setup writes `~/.grok/hooks/oboete.json` and `[mcp_servers.oboete]` in
`~/.grok/config.toml`. Session-start and prompt-submit packs are stored `pending` and delivered
with the first tool call of the turn that actually runs (FR-045). Tools appear to hooks as
`oboete__search`, `oboete__timeline`, and `oboete__get`. Details:
[docs/agents/grok.md](docs/agents/grok.md).

**Pi.** Setup writes `~/.pi/agent/extensions/oboete.js`. Capture is a detached `oboete capture`
child; injection is a bounded `oboete inject` child from `before_agent_start`. Tools are
`oboete_search`, `oboete_timeline`, and `oboete_get`, each spawning `oboete search|timeline|get
--json`. Details: [docs/agents/pi.md](docs/agents/pi.md).

## Troubleshooting

**A hook is not firing.** Run `oboete doctor` (without `--no-probe-agents`) and read the `agent:<name>`
item. Then run `oboete setup --agents <name>`. Doctor treats a missing Claude handler, a Codex
`untrusted` or `absent` hash, or a missing Grok/Pi file as `degraded` with consequence `<Agent>
sessions capture nothing and receive no memories.` and recovery `` `oboete setup --agents <name>` ``.

**The database is corrupt.** Doctor sets `storage` to `degraded` and exits 3. Recovery, quoted:

> Back up the file; run `oboete export` if it is readable; move the database aside; run `oboete setup`; then `oboete import` the export.

**Codex shows a trust prompt.** Codex skips a handler that has no matching
`[hooks.state."…"] trusted_hash` and says nothing, or the terminal user interface asks before
running an untrusted command. Setup writes those rows from the merged `hooks.json`. If the prompt
still appears, run `oboete setup --agents codex` again so the hash matches the handler JSON. The
isolated-user terminal user interface probe with matching rows started with hooks active and no trust prompt.

**Grok Build updated itself and doctor says it dropped the oboete markers.** Grok re-serializes
`~/.grok/config.toml` without comments, which removes the `# oboete:begin` and `# oboete:end` lines
around the MCP table. Run `oboete setup --agents grok`; setup recognizes the table it wrote and
restores the block. A table that runs another command is left alone and reported instead.

**Grok Build seems to have no memory at the start of a turn.** That is deferred delivery, not a
missed hook. Grok Build has no channel that reaches the model before a tool runs, so the pack
arrives with the first tool call of the turn. `oboete why` reports `deferred: delivered with tool
calls`. A turn with no tool call is labelled `no_tool_call` and the memories stay available for
the next turn.

## Development

```bash
npm ci
npm run build          # esbuild: dist/engine.mjs + dist/oboete.mjs launcher, build/test/*.mjs, viewer assets
npm run typecheck      # tsc --noEmit and the viewer project
npm run lint           # eslint
npm test               # node --test on the compiled tests
npm run pack-check     # npm pack, install into an empty prefix, unpacked size limit 30 MB
```

Measured on this host ([docs/evidence/m1-resource-envelope.md](docs/evidence/m1-resource-envelope.md)):
largest `--version` cold start 59.7 ms against a 100 ms budget; largest hook 252.1 ms against
300 ms (Node.js v24.16.0, secret-dense 200 KB stdin). Installed size after the bundled packages
became development dependencies: 29.152 MB by `du -k`; `pack-check` file-size sum 20.280 MB.

Automated end-to-end validation runs under a separate Linux user, `oboete-dogfood`, with its own
home and its own logins for all four agents (FR-041). oboete is not installed in the maintainer's
own agent environment during M1. The account creation steps, Node.js 24 for that user (Pi requires
>= 22.19), and per-agent login commands are in
[docs/research/isolated-user-setup.md](docs/research/isolated-user-setup.md). Daily dogfood
append-only evidence lives in [docs/evidence/m1-dogfood.md](docs/evidence/m1-dogfood.md).

## Layout

- `CONSTITUTION.md` — project principles and constraints (authoritative).
- `docs/research/` — verified third-party contracts (hook payloads, provider APIs); created with the M1 specification.
- `docs/agents/` — per-agent setup, detection, pack delivery, and removal notes.
- `docs/evidence/` — measured cold start, installed size, fixture replay, and isolated-user dogfood.
- `specs/` — Spec Kit features for oboete milestones (created per milestone).
- `scripts/` — build, pack-check, fixture replay, isolated-user probes, and the DCO checker.
- `legacy/` — the free-mem era, read-only.

## Current limitations

Implemented and verified here is not the same as qualified. At this version:

- **Agent coverage is uneven.** Codex records a turn end without the final assistant message,
  because its hook is not given one. Compaction summary text is missing for both Codex and Grok
  Build, whose contracts carry the event without a summary field. Claude and Pi supply both.
- **Work continuation between agents is not checked natively.** The daily run does launch two
  native agents in sequence, but it asserts only that the seeded facts reach the receiving agent.
  That the receiving agent is given the selected work item and its checkpoint, and no unrelated
  one, is exercised by generated pairs (#265).
- **Recall against a real summarizer is unverified at this revision.** The fixture evaluation in
  this repository runs with no provider, so its 0 of 40 is what the rules alone produce. Three
  receipts used a real one, all from earlier revisions: the M1 bundle passed 12 of 12 agent pairs
  on 2026-09-16; the 009 bundle (`6b683213`) passed 1 of 12 the next day with the same preset and
  model (#274); and a Workers AI replay at `d724d5df` recalled 8 of 40 planted facts against a 90%
  target. Retrieval has been repaired since the two failures; nothing re-measures it here.
- **Scale and long-run behaviour are open.** The resource sweep replays about a thousand events in
  roughly four minutes and then holds a reader open for 24.9 seconds against the resident worker;
  ten thousand and a hundred thousand events are #267, and seven days of real use is #268. Nothing
  here measures what a week of memories costs to hold or to search.
- **Device sync moves files, not a service.** It has no network transport, no signatures on
  bundles, and one pull reads at most 32 other replicas' bundles.
- **Search is lexical.** Word match with a Chinese/Japanese/Korean bigram index; semantic search is
  milestone M2.
- **Only Linux is supported.** The engine gate passes on an M1 iMac, the macOS CI runner still
  fails a cold-start timing check, and the agent wiring on macOS is unverified.

Historical measurements quoted above are dated and describe the build that produced them. Treat
them as receipts of that run, not as a guarantee about the current product.

## License

Apache-2.0. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and [`CONTRIBUTING.md`](CONTRIBUTING.md).
