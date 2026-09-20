#!/usr/bin/env node
// T042 / SC-008: retained-history resource run. Product checkpoints only; doctor generation predicate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLE = join(ROOT, 'dist', 'oboete.mjs');
const CONFIG = '[observer]\npreset = "none"\n\n[worker]\nidle_exit_ms = 60000\n';
const SAMPLE_MS = 250, RSS_BOUND_KIB = 150 * 1024, WAL_FRACTION = 0.25;
const TIME_BIN = '/usr/bin/time';
const HOOK_TIMEOUT_MS = 15_000, REPLAY_TIMEOUT_MS = 40 * 60_000;
const PENDING_TIMEOUT_MS = 3 * 60_000, STOPPED_TIMEOUT_MS = 2 * 60_000, BATCH_WAIT_MS = 60_000, DOCTOR_POLL_MS = 5_000;
const GATED = new Set(['hooks', 'SC-010', 'lifecycle', 'SC-003']);
const NO_MODEL = new Set(['SC-009', 'session start']);
const STAGES = ['hold', 'drain', 'stop', 'final'];
const SESSION_KINDS = ['session_start', 'session_end', 'last_assistant_message', 'turn_end'];
const CLOCK_TICK = clockTick();
const ownPids = new Map();
const childPeaks = [];
const groupSurvivors = new Map();
let rssDir;
let rssSeq = 0;
const loggedPids = new Set();
const WORKER_LOG_LAG_MS = 60_000;
let bootAt;
class HarnessError extends Error { constructor(message) { super(message); this.name = 'HarnessError'; } }
function usage() {
  return 'Usage: node scripts/measure-resources.mjs [--fixture test/fixtures/events-1000.jsonl] [--json-out <path>] [--sessions 20] [--prompts 9] [--hold-ms 20000] [--keep] [--self-check]\n';
}
function intOption(values, name, fallback) {
  const n = Number(values[name] ?? fallback);
  if (!Number.isInteger(n) || n <= 0) throw new HarnessError(`invalid --${name}: ${values[name] ?? fallback}`);
  return n;
}
function parseCli(argv) {
  let v;
  try {
    v = parseArgs({
      args: argv, strict: true,
      options: {
        fixture: { type: 'string' }, 'json-out': { type: 'string' },
        sessions: { type: 'string', default: '20' }, prompts: { type: 'string', default: '9' },
        'hold-ms': { type: 'string', default: '20000' }, keep: { type: 'boolean', default: false },
        'self-check': { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) { throw new HarnessError(`${error instanceof Error ? error.message : String(error)}\n${usage()}`); }
  return {
    fixture: resolve(v.fixture ?? join(ROOT, 'test', 'fixtures', 'events-1000.jsonl')),
    jsonOut: v['json-out'] === undefined ? undefined : resolve(v['json-out']),
    sessions: intOption(v, 'sessions', 20), prompts: intOption(v, 'prompts', 9),
    holdMs: intOption(v, 'hold-ms', 20_000), keep: v.keep === true, selfCheck: v['self-check'] === true,
  };
}
function childEnv(paths) {
  return { PATH: `${paths.bin}:/usr/bin:/bin`, HOME: paths.userHome, OBOETE_HOME: paths.oboeteHome, TMPDIR: paths.tmp, NODE_ENV: 'test' };
}
function gitHead() {
  const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: ROOT, GIT_CONFIG_NOSYSTEM: '1' } });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}
function loadAverage() { try { return readFileSync('/proc/loadavg', 'utf8').trim(); } catch { return 'unavailable'; } }
// A file that is not there yet is zero bytes; a file this run may not read is not, and reporting it
// as zero would read as a WAL the checkpoint had recycled.
function missing(error) { return error?.code === 'ENOENT'; }
function fileBytes(path) {
  try { return statSync(path).size; } catch (error) { if (missing(error)) return 0; throw error; }
}
function spoolCount(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).length;
  } catch (error) { if (missing(error)) return 0; throw error; }
}
function isBusy(error) {
  if (error === null || typeof error !== 'object') return false;
  return error.errcode === 5 || error.errcode === 6 || /database is locked|SQLITE_BUSY|SQLITE_LOCKED|\bbusy\b/i.test(`${error.errstr ?? ''} ${error instanceof Error ? error.message : error}`);
}
function readVm(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(text);
    const hwm = /^VmHWM:\s+(\d+) kB$/m.exec(text);
    return { rssKb: Number(rss?.[1] ?? 0), hwmKb: Number(hwm?.[1] ?? 0) };
  } catch { return null; }
}
// Only the processes this harness starts, plus the worker pids the product itself writes to the
// temp home's observe.log, are ever inspected. Scanning /proc for an OBOETE_HOME environment reads
// the environment - and so the credentials - of processes this run does not own.
// /proc/<pid>/stat field 22 counts clock ticks since boot, so a wall-clock start needs both.
function clockTick() {
  const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  const n = Number((r.stdout ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 100;
}
function bootMs() {
  if (bootAt === undefined) {
    const m = (() => { try { return readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m); } catch { return null; } })();
    bootAt = m === null ? null : Number(m[1]) * 1_000;
  }
  return bootAt;
}
// A process that a `run start` line names must have begun just before that line was written. Without
// this, a pid whose worker ended and whose number a stranger now carries would be adopted - and
// signalled - on the first pass that reads the old line.
function startedBefore(pid, atMs) {
  const ident = procIdent(pid);
  const boot = bootMs();
  if (ident === null || boot === null || !Number.isFinite(atMs)) return false;
  const began = boot + (Number(ident) / CLOCK_TICK) * 1_000;
  return began <= atMs + 2_000 && began >= atMs - WORKER_LOG_LAG_MS;
}
function procIdent(pid) {
  let text;
  try { text = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  // Field 22 of /proc/<pid>/stat, counted from the state that follows the comm: a reused pid has a
  // different start time, so a remembered pid never resolves to somebody else's process.
  return text.slice(close + 1).trim().split(' ')[19] ?? null;
}
function adopt(pid, observe, group = false) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const ident = procIdent(pid);
  if (ident === null) return;
  ownPids.set(pid, { ident, observe, group });
}
// A worker pid is taken from the log once. The line stays in the log after that process ends, and a
// pid carrying that number later belongs to somebody else.
function adoptLogged(pid, atMs) {
  if (loggedPids.has(pid)) return;
  loggedPids.add(pid);
  if (startedBefore(pid, atMs)) adopt(pid, true);
}
function readObserveLog(home) {
  try { return readFileSync(join(home, 'logs', 'observe.log'), 'utf8'); } catch { return ''; }
}
function workerPidsFrom(text) {
  return [...text.matchAll(/^(\S+) info run start\b.*\bpid=(\d+)/gm)].map((m) => ({ pid: Number(m[2]), at: Date.parse(m[1]) }));
}
function homeProcesses(home) {
  for (const run of workerPidsFrom(readObserveLog(home))) adoptLogged(run.pid, run.at);
  const live = [];
  for (const [pid, info] of ownPids) {
    if (procIdent(pid) === info.ident) live.push({ pid, ident: info.ident, observe: info.observe, group: info.group === true });
    else ownPids.delete(pid);
  }
  return live;
}
function pidsInHome(home) { return homeProcesses(home).map((proc) => proc.pid); }
function sampleHome(paths, at = Date.now()) {
  const processes = [];
  for (const { pid, observe } of homeProcesses(paths.oboeteHome)) {
    const vm = readVm(pid);
    if (vm === null) continue;
    processes.push({ pid, rssKb: vm.rssKb, hwmKb: vm.hwmKb, observe });
  }
  return {
    at, dbBytes: fileBytes(paths.db), walBytes: fileBytes(`${paths.db}-wal`), spool: spoolCount(paths.spool),
    rssKb: processes.reduce((m, p) => Math.max(m, p.rssKb), 0), hwmKb: processes.reduce((m, p) => Math.max(m, p.hwmKb), 0), processes,
  };
}
// A sample that cannot be taken - an unreadable database, a spool that is not a directory - must
// end the run through its own error path. An exception inside the timer would instead leave Node to
// exit on an uncaught error, with the resident still running and no report written.
function startSampler(paths, sink, stageOf) {
  let failure;
  const tick = () => { sink.push({ ...sampleHome(paths), stage: stageOf() }); };
  const guarded = () => {
    try { tick(); } catch (error) { failure ??= error; clearInterval(timer); }
  };
  tick();
  const timer = setInterval(guarded, SAMPLE_MS);
  let stopped = false;
  return {
    stop() { if (stopped) return; stopped = true; clearInterval(timer); guarded(); },
    failure() { return failure; },
  };
}
// The final sample is taken by `stop`, so it is the one a caller reading `failure` before stopping
// would miss: the run would report gates computed over samples that end early and say nothing.
function finishSampling(sampler) {
  sampler.stop();
  const failure = sampler.failure();
  if (failure !== undefined) {
    throw new HarnessError(`sampling stopped: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
}
function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b); const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function seriesStats(samples, key) {
  const values = samples.map((s) => s[key]).filter((v) => typeof v === 'number');
  return values.length === 0 ? { min: 0, median: 0, max: 0, n: 0 } : { min: Math.min(...values), median: median(values), max: Math.max(...values), n: values.length };
}
function pidStats(samples) {
  const map = new Map();
  for (const sample of samples) {
    for (const proc of sample.processes ?? []) {
      const cur = map.get(proc.pid);
      if (cur === undefined) map.set(proc.pid, { pid: proc.pid, firstRss: proc.rssKb, lastRss: proc.rssKb, n: 1, maxHwm: proc.hwmKb, observe: proc.observe === true });
      else { cur.lastRss = proc.rssKb; cur.n += 1; cur.maxHwm = Math.max(cur.maxHwm, proc.hwmKb); cur.observe = cur.observe || proc.observe === true; }
    }
  }
  return [...map.values()];
}
function writeConfig(home) {
  for (const dir of [home, join(home, 'spool'), join(home, 'logs')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.toml'), CONFIG, { mode: 0o600 });
}
// `%M` is the kernel's peak resident size for the command and every descendant it waits for, read
// at exit. Polling /proc cannot promise either: a spike after the last sample is invisible, and
// phase A's own hooks are the replay's children, not this process's.
function parseRss(text) {
  const m = text.match(/^(\d+)\s*$/m);
  return m === null ? 0 : Number(m[1]);
}
function readRss(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return 0; }
  try { rmSync(path, { force: true }); } catch { /* the home is removed anyway */ }
  return parseRss(text);
}
// The child leads its own process group, so a timeout reaches the command and not just the wrapper.
// The leader's start time is read again first: once the leader is gone the number is not proof of
// anything, and the group's survivors are tracked by pid instead.
function killGroup(child, signal, ident) {
  if (child.pid === undefined) return;
  if (ident !== undefined && procIdent(child.pid) !== ident) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}
// Takes the processes still in a group this run created, by pid and start time, so they can be
// stopped after the leader is gone - and remembers which group they came from, so a timeout can
// reach that group's survivors without touching anything else this run owns.
function adoptMembers(pgid) {
  if (!groupAlive(pgid)) return;
  const known = groupSurvivors.get(pgid) ?? new Set();
  for (const member of groupMembers(pgid)) {
    if (member === pgid) continue;
    adopt(member, false);
    known.add(member);
  }
  groupSurvivors.set(pgid, known);
}
function killMembers(pgid, signal) {
  for (const pid of groupSurvivors.get(pgid) ?? []) {
    const info = ownPids.get(pid);
    if (info === undefined || procIdent(pid) !== info.ident) continue;
    try { process.kill(pid, signal); } catch { /* gone */ }
  }
}
function spawnWait(file, args, { env, cwd, timeoutMs, stdin, inheritStderr }) {
  const t0 = Date.now();
  rssSeq += 1;
  const rssFile = join(rssDir ?? tmpdir(), `rss-${rssSeq}.txt`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TIME_BIN, ['-f', '%M', '-o', rssFile, '--', file, ...args], {
      cwd, env, detached: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    adopt(child.pid, false, true);
    const leader = procIdent(child.pid ?? 0);
    let stdout = ''; let stderr = ''; let timedOut = false; let hardTimer; let settled = false;
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      groupSurvivors.delete(child.pid);
      const hwmKb = readRss(rssFile);
      childPeaks.push({ pid: child.pid ?? 0, command: args[1] ?? file, hwmKb });
      resolvePromise({ status, signal, stdout, stderr, timedOut, hwmKb, pid: child.pid, ms: Date.now() - t0 });
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; if (inheritStderr === true) process.stderr.write(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      adoptMembers(child.pid ?? 0);
      killGroup(child, 'SIGTERM', leader);
      // The wrapper may already have died of the SIGTERM its command ignored, in which case the
      // group is no longer proof of anything and the survivors taken above are the way in.
      hardTimer = setTimeout(() => {
        adoptMembers(child.pid ?? 0);
        killGroup(child, 'SIGKILL', leader);
        killMembers(child.pid ?? 0, 'SIGKILL');
        // Whatever is left holding the pipes, the caller gets its answer: a harness that waits for
        // `close` forever reports nothing at all.
        setTimeout(() => settle(null, 'SIGKILL'), 5_000).unref();
      }, 2_000);
      hardTimer.unref();
    }, timeoutMs);
    child.on('error', (error) => { settled = true; clearTimeout(timer); clearTimeout(hardTimer); reject(error); });
    // `exit` fires when the process ends; `close` waits for the pipes, which a command that
    // outlives its wrapper can hold open. The survivors are taken here, while the group is still
    // named by a leader this run started.
    child.on('exit', () => {
      if (child.pid === undefined) return;
      adoptMembers(child.pid);
      ownPids.delete(child.pid);
    });
    child.stdin?.on('error', () => {});
    if (stdin !== undefined) child.stdin?.end(stdin);
    child.on('close', (status, signal) => { settle(status, signal); });
  });
}
function parseJsonStdout(text) {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try { return JSON.parse(trimmed); } catch { /* slice */ }
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; } }
  return null;
}
function claudePayload(repo, sessionId, event, extra) {
  return { session_id: sessionId, transcript_path: join(repo, '.oboete-t042', `${sessionId}.jsonl`), cwd: repo, permission_mode: 'bypassPermissions', hook_event_name: event, ...extra };
}
async function runHook(env, repo, event, payload) {
  return spawnWait(process.execPath, [BUNDLE, 'hook', '--agent', 'claude-or-grok', '--event', event], { env, cwd: repo, timeoutMs: HOOK_TIMEOUT_MS, stdin: JSON.stringify(payload) });
}
function hookFailed(row) { return row.timedOut || row.signal !== null || row.status !== 0; }
async function runSessions(env, repo, cli, runId) {
  const origin = Date.now();
  const gap = cli.sessions <= 1 ? 0 : cli.holdMs / cli.sessions;
  const hooks = []; const sessionIds = []; const markers = [];
  await Promise.all(Array.from({ length: cli.sessions }, async (_, s) => {
    const wait = origin + gap * s - Date.now();
    if (wait > 0) await sleep(wait);
    const sessionId = `t042-${runId}-s${s}`;
    sessionIds[s] = sessionId;
    const push = async (event, extra) => {
      hooks.push({ event, session: s, ...(await runHook(env, repo, event, claudePayload(repo, sessionId, event, extra))) });
    };
    await push('SessionStart', { source: 'startup' });
    for (let i = 0; i < cli.prompts; i += 1) {
      const marker = `t042:${runId}:${s}:${i};`;
      markers.push(marker);
      await push('UserPromptSubmit', { prompt_id: marker, prompt: `${marker} concurrent capture` });
    }
    await push('Stop', { prompt_id: `${sessionId}-stop`, stop_hook_active: false, last_assistant_message: 'done' });
  }));
  return { hooks, sessionIds, markers };
}
function holdReader(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2_000 });
  db.exec('BEGIN');
  db.prepare('SELECT 1 AS ok FROM raw_events LIMIT 1').get();
  let open = true;
  return {
    release() {
      if (!open) return;
      open = false;
      try { if (db.isTransaction) db.exec('COMMIT'); } catch { try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* close drops snapshot */ } }
      db.close();
    },
  };
}
function openRo(path, timeout) { return new DatabaseSync(path, { readOnly: true, timeout }); }
// Throws rather than swallowing: the temp home is deleted right after this, so a silently lost
// copy would leave the run with no worker log at all.
function copyObserveLog(home, jsonOut) {
  if (jsonOut === undefined) return;
  const source = join(home, 'logs', 'observe.log');
  if (!existsSync(source)) return;
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(`${jsonOut.replace(/\.json$/i, '')}.observe.log`, readFileSync(source));
}
function findReplayRepo(json, stderr, tmp) {
  const fromJson = typeof json?.repo === 'string' ? json.repo : undefined;
  const fromKeep = (stderr.match(/^kept home=\S+ repo=(\S+)\s*$/m) ?? [])[1];
  const reported = fromJson ?? fromKeep;
  if (reported !== undefined && existsSync(reported)) return { repo: reported, source: fromJson !== undefined ? 'replay-json' : 'replay-keep-stderr' };
  let names = [];
  try { names = readdirSync(tmp, { withFileTypes: true }); } catch { /* empty */ }
  const dirs = names.filter((e) => e.isDirectory() && e.name.startsWith('oboete-t068-repo-')).map((e) => join(tmp, e.name));
  if (dirs.length === 1) return { repo: dirs[0], source: 'replay-tmpdir (JSON has repoId only; replayArgv has --keep and no --repo)' };
  throw new HarnessError(`phase A --keep did not yield a repository path (replayArgv has no --repo); tmp=${dirs.join('|') || 'none'}`);
}
function endReasonFrom(text, afterMs = 0) {
  let last = null, lastAfter = null;
  for (const m of text.matchAll(/^(\S+) \S+ run end\b.*\breason=(\S+)/gm)) {
    last = m[2];
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && at >= afterMs) lastAfter = m[2];
  }
  return lastAfter ?? last;
}
// `error batch ... state=error` is a failure, not the overlap this looks for (src/worker/observe.ts).
function countBatchLines(text, fromMs, toMs) {
  let n = 0;
  for (const m of text.matchAll(/^(\S+) info batch\b/gm)) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && at >= fromMs && at <= toMs) n += 1;
  }
  return n;
}
function countErrorLines(text, fromMs) {
  let n = 0;
  for (const m of text.matchAll(/^(\S+) error\b/gm)) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && at >= fromMs) n += 1;
  }
  return n;
}
/** A run that ended for any other reason after the hold began is a worker failure this must fail on. */
function badEndReasons(text, fromMs) {
  const benign = new Set(['stopped', 'idle_exit', 'another_worker', 'empty']);
  const bad = [];
  for (const m of text.matchAll(/^(\S+) \S+ run end\b.*\breason=(\S+)/gm)) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && at >= fromMs && !benign.has(m[2])) bad.push(m[2]);
  }
  return bad;
}
async function waitHeldBatch(logPath, fromMs) {
  const deadline = Date.now() + BATCH_WAIT_MS;
  while (Date.now() < deadline) {
    let text = '';
    try { text = readFileSync(logPath, 'utf8'); } catch { /* missing */ }
    if (countBatchLines(text, fromMs, Date.now()) > 0) return;
    await sleep(SAMPLE_MS);
  }
  throw new HarnessError('held reader never overlapped a worker batch');
}
async function readDoctor(env, cwd) {
  const items = parseJsonStdout((await spawnWait(process.execPath, [BUNDLE, 'doctor', '--json'], { env, cwd, timeoutMs: 60_000 })).stdout)?.items ?? [];
  const generation = items.find((item) => item.item === 'generation');
  const worker = items.find((item) => item.item === 'worker');
  if (generation === undefined) throw new HarnessError('doctor --json missing generation item');
  const stuck = parseGeneration(generation.reason ?? '');
  if (!Number.isFinite(stuck.pending)) throw new HarnessError('doctor generation item missing pending count');
  return { generation, worker, stuck };
}
async function waitPending(env, cwd, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'unread';
  while (Date.now() < deadline) {
    try {
      const doc = await readDoctor(env, cwd);
      last = doc.generation.reason ?? '';
      if (doc.stuck.pending === 0) return;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await sleep(DOCTOR_POLL_MS);
  }
  throw new HarnessError(`timed out waiting for doctor generation pending=0; last=${last}`);
}
async function waitGone(home, dbPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsInHome(home).length === 0) {
      try {
        const db = openRo(dbPath, 50);
        try {
          const row = db.prepare('SELECT owner_token FROM worker_lease WHERE id = 1').get();
          if (row === undefined || row.owner_token == null) return;
        } finally { db.close(); }
      } catch (error) { if (!isBusy(error)) throw error; }
    }
    await sleep(SAMPLE_MS);
  }
  throw new HarnessError(`timed out waiting for home processes to exit and worker_lease to have no live owner after observe --stop; leftover=${pidsInHome(home).join('|') || 'none'}`);
}
// Signal 0 to a group id succeeds while any member is left.
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
// Field 5 of /proc/<pid>/stat is the process group. Reading it names the members of a group this
// run created; it is the same world-readable line the start time comes from, never an environment.
function groupMembers(pgid) {
  const members = [];
  let names = [];
  try { names = readdirSync('/proc'); } catch { return members; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let text = '';
    try { text = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
    if (Number(text.slice(text.lastIndexOf(')') + 1).trim().split(' ')[2]) === pgid) members.push(Number(name));
  }
  return members;
}
async function stopHomeProcesses(home) {
  // A child of this harness leads its own group and the command runs inside it, so signalling the
  // pid alone would end the /usr/bin/time wrapper and leave the product's process running. The
  // group is used only while its leader is alive, which is what proves the id is still this run's;
  // everything else - a worker the log named, a command that outlived its wrapper - is signalled by
  // pid, with its identity read again between the listing and the signal.
  const signalAll = (signal) => {
    // Members first: a wrapper that dies on the signal would otherwise take the only handle on a
    // command that ignored it.
    for (const { pid, group } of homeProcesses(home)) { if (group) adoptMembers(pid); }
    for (const { pid, ident, group } of homeProcesses(home)) {
      if (procIdent(pid) !== ident) continue;
      try { process.kill(group ? -pid : pid, signal); } catch { /* gone */ }
    }
  };
  signalAll('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && homeProcesses(home).length > 0) await sleep(100);
  signalAll('SIGKILL');
}
// The sweep measures the cost of holding retained history, so losing that history - through
// src/worker/purge.ts or anything else - must fail rather than look like a cheaper run.
function historyIds(dbPath) {
  const db = openRo(dbPath, 2_000);
  try { return db.prepare('SELECT id FROM raw_events').all().map((row) => String(row.id)); } finally { db.close(); }
}
function historyKept(dbPath, priorIds) {
  const now = new Set(historyIds(dbPath));
  return priorIds.filter((id) => now.has(id)).length;
}
function liveBatches(dbPath) {
  try { const db = openRo(dbPath, 2_000); try { return Number(db.prepare("SELECT COUNT(*) AS n FROM observation_batches WHERE state IN ('pending', 'running')").get()?.n ?? 0); } finally { db.close(); } } catch { return -1; }
}
function loadHits(dbPath, spoolDir, markers, sessionIds) {
  const db = openRo(dbPath, 2_000);
  let rows;
  try {
    rows = db.prepare(
      `SELECT r.content AS content, r.classification_state AS classification_state, r.kind AS kind, s.native_session_id AS native_session_id, json_extract(r.payload_json, '$.prompt_id') AS prompt_id FROM raw_events r JOIN sessions s ON s.id = r.session_id`,
    ).all();
  } finally { db.close(); }
  const spoolTexts = [];
  if (existsSync(spoolDir)) {
    for (const name of readdirSync(spoolDir)) {
      if (!name.endsWith('.json')) continue;
      try { spoolTexts.push(readFileSync(join(spoolDir, name), 'utf8')); } catch { /* skip */ }
    }
  }
  return {
    markers: markers.map((id) => ({
      id,
      hits: rows.filter((row) => (typeof row.content === 'string' && row.content.includes(id)) || (row.classification_state === 'failed' && row.prompt_id === id)).map((row) => ({ classification_state: row.classification_state })),
      spool: spoolTexts.some((text) => text.includes(id)),
    })),
    // The Stop hook writes a last_assistant_message and a turn_end; a hook that exits 0 having
    // stored neither is the loss this run is here to catch (contracts/agents.md, adaptClaudeStop).
    sessions: sessionIds.map((id) => {
      const own = rows.filter((row) => row.native_session_id === id);
      const count = (kind) => own.filter((row) => row.kind === kind && row.classification_state !== 'failed').length;
      return {
        id, starts: count('session_start'), ends: count('session_end'), messages: count('last_assistant_message'), turnEnds: count('turn_end'),
        failedKinds: SESSION_KINDS.filter((kind) => own.some((row) => row.kind === kind && row.classification_state === 'failed')),
      };
    }),
    spoolFiles: spoolTexts.length,
  };
}
function parseGeneration(reason) {
  const n = (re) => { const m = reason.match(re); return m === null ? Number.NaN : Number(m[1]); };
  return { pending: n(/(\d{1,9}) pending/), waiting: n(/(\d{1,9}) waiting/), parked: n(/(\d{1,9}) parked/), legacy: n(/(\d{1,9}) legacy sources held/), processed: n(/(\d{1,9}) processed/) };
}
function checkRetained(input) {
  const missing = []; const duplicate = []; const failed = [];
  for (const marker of input.markers) {
    const good = marker.hits.filter((hit) => hit.classification_state !== 'failed').length;
    const bad = marker.hits.filter((hit) => hit.classification_state === 'failed').length;
    // Each failure is counted on its own: one stored row does not excuse a second row beside it,
    // and neither excuses a failed classification of the same prompt.
    if (bad > 0) failed.push(marker.id);
    if (good > 1) duplicate.push(marker.id);
    else if (good === 0 && bad === 0 && !marker.spool) missing.push(marker.id);
  }
  const prior = input.prior ?? { rows: 0, kept: 0 };
  const sessionFail = input.sessions.filter((s) => s.starts !== 1 || s.ends !== 1 || s.messages !== 1 || s.turnEnds !== 1 || (s.failedKinds ?? []).length > 0).map((s) => s.id);
  return { name: 'retained', pass: missing.length === 0 && duplicate.length === 0 && failed.length === 0 && sessionFail.length === 0 && prior.kept === prior.rows, missing, duplicate, failed, sessionFail, prior, spoolFiles: input.spoolFiles };
}
function checkNotStuck(input) {
  // The run makes `observe --stop` succeed or throws, so `stopped` is the only end it demands, and
  // the sentinel it wrote must be gone: `src/worker/observe.ts` keeps a sentinel it could not
  // remove and says so in the log, and the next worker would stop on it.
  const pass = input.pending === 0 && input.spoolFiles === 0 && input.liveBatches === 0
    && input.workerErrors === 0 && (input.badEnds ?? []).length === 0
    && input.endReason === 'stopped' && input.stopMarker === false;
  return { name: 'not-stuck', pass, ...input, note: 'with preset none, work moves to waiting as deferred no_provider' };
}
function checkWal(input) {
  const grew = input.peak > input.start;
  return { name: 'wal-recycled', pass: grew && input.final <= input.peak * WAL_FRACTION, ...input, grew, fraction: WAL_FRACTION };
}
function checkRss(input) {
  const children = input.children ?? [];
  const childMax = children.reduce((m, c) => Math.max(m, c.hwmKb), 0);
  // A child with no reading at all is an unmeasured process, not a small one.
  const unmeasured = children.filter((c) => c.hwmKb === 0).map((c) => c.command);
  const maxHwm = Math.max(input.phaseAHwmKb, input.phaseB.reduce((m, p) => Math.max(m, p.maxHwm), 0), childMax);
  return {
    name: 'rss-bound', pass: maxHwm <= RSS_BOUND_KIB && unmeasured.length === 0, maxHwm, ...input,
    childMax, childCount: children.length, unmeasured, boundKib: RSS_BOUND_KIB,
    note: "20-second window cannot show long-run growth; that is issue #268's seven-day run",
  };
}
// The wrapper is the group leader and the product's command runs inside that group; if a signal
// reached only the leader, an aborted run would leave the command behind.
async function groupKillCheck() {
  // The run refuses to start without this binary, so a self-check that skipped itself here would
  // report green having proved none of the three cases below.
  if (!existsSync(TIME_BIN)) throw new HarnessError(`${TIME_BIN} is required to read each child's peak RSS (apt-get install time)`);
  const scratch = mkdtempSync(join(tmpdir(), 'oboete-t042-selfcheck-'));
  const started = [];
  const wrap = (name, ...command) => {
    const child = spawn(TIME_BIN, ['-f', '%M', '-o', join(scratch, `${name}.txt`), '--', process.execPath, ...command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    started.push(child);
    return child;
  };
  const gone = async (pid) => {
    for (let i = 0; i < 30 && existsSync(`/proc/${pid}`); i += 1) await sleep(100);
    return !existsSync(`/proc/${pid}`);
  };
  rssDir = scratch;
  try {
    const child = wrap('wrapper', '-e', 'setInterval(() => {}, 1_000);');
    await sleep(500);
    const inner = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/).filter((part) => part !== '').map(Number);
    assert.ok(inner.length > 0, 'the wrapper runs the command as its child');
    killGroup(child, 'SIGKILL');
    assert.equal(await gone(inner[0]), true, 'the group kill reaches the command');
    assert.equal(groupAlive(child.pid), false);
    // A child that ends on its own leaves no group behind for the cleanup path to signal.
    const quick = await spawnWait(process.execPath, ['-e', 'process.exit(0);'], { env: process.env, cwd: ROOT, timeoutMs: 10_000 });
    assert.equal(quick.status, 0);
    assert.ok(quick.hwmKb > 0, 'the wrapper reports the peak of the command it ran');
    assert.deepEqual(pidsInHome(scratch), [], 'a child that ended leaves nothing for cleanup to signal');
    // A command that ignores SIGTERM keeps `close` from firing once its wrapper is gone, so the
    // cleanup path has to have taken it by pid before the signal, and has to escalate.
    const stubborn = wrap('stubborn', '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);");
    adopt(stubborn.pid, false, true);
    await sleep(500);
    const held = groupMembers(stubborn.pid).filter((pid) => pid !== stubborn.pid);
    assert.ok(held.length > 0, 'the stubborn command is in the wrapper group');
    await stopHomeProcesses(scratch);
    assert.equal(await gone(held[0]), true, 'cleanup ends a command that ignored SIGTERM');
    // A read this run cannot do is an error, not a zero, and an error inside the sampler's timer
    // has to come back as a failure the run can report rather than as an uncaught exception.
    assert.equal(fileBytes(join(scratch, 'absent')), 0);
    writeFileSync(join(scratch, 'plain'), 'x');
    assert.throws(() => fileBytes(join(scratch, 'plain', 'below')), /ENOTDIR/);
    let ticks = 0;
    const sampler = startSampler({ oboeteHome: scratch, db: join(scratch, 'plain'), spool: join(scratch, 'spool') }, [], () => {
      ticks += 1;
      if (ticks > 1) throw new Error('sampler tick failed');
      return 'hold';
    });
    await sleep(600);
    sampler.stop();
    assert.match(String(sampler.failure()?.message), /sampler tick failed/);
    // A failure only the final tick produces is the one `finishSampling` exists for, and stopping
    // twice must not take a second one.
    const sink = [];
    const finalOnly = startSampler({ oboeteHome: scratch, db: join(scratch, 'plain'), spool: join(scratch, 'spool') }, sink, () => 'final');
    finalOnly.stop();
    const taken = sink.length;
    finalOnly.stop();
    assert.equal(sink.length, taken, 'stopping a sampler twice takes one final sample');
    let finalTicks = 0;
    const lastFails = startSampler({ oboeteHome: scratch, db: join(scratch, 'plain'), spool: join(scratch, 'spool') }, [], () => {
      finalTicks += 1;
      if (finalTicks > 1) throw new Error('final sample failed');
      return 'final';
    });
    assert.throws(() => finishSampling(lastFails), /sampling stopped: final sample failed/);
    // The same command under spawnWait: its timeout must end it and the call must come back.
    const timedOutRun = await spawnWait(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"], { env: process.env, cwd: ROOT, timeoutMs: 1_000 });
    assert.equal(timedOutRun.timedOut, true, 'a command that ignores SIGTERM still ends its own call');
    assert.deepEqual(pidsInHome(scratch), [], 'the timeout leaves nothing of that command behind');
  } finally {
    for (const child of started) { killGroup(child, 'SIGKILL'); killMembers(child.pid ?? 0, 'SIGKILL'); }
    await stopHomeProcesses(scratch);
    ownPids.clear();
    groupSurvivors.clear();
    loggedPids.clear();
    rssDir = undefined;
    rmSync(scratch, { recursive: true, force: true });
  }
}
async function selfCheck() {
  const hit = (id, state, n = 1, spool = false) => ({ id, hits: Array.from({ length: n }, () => ({ classification_state: state })), spool });
  const one = { starts: 1, ends: 1, messages: 1, turnEnds: 1, failedKinds: [] };
  const sess = [{ id: 's0', ...one }];
  const stuckOk = { pending: 0, waiting: 4, parked: 0, legacy: 0, processed: 1, spoolFiles: 0, liveBatches: 0, endReason: 'stopped', stopMarker: false, workerErrors: 0, badEnds: [] };
  assert.equal(checkRetained({ markers: [hit('a', 'done'), hit('b', 'done')], sessions: [...sess, { id: 's1', ...one }], spoolFiles: 0 }).pass, true);
  const mixed = checkRetained({ markers: [hit('miss', 'done', 0), hit('dup', 'done', 2)], sessions: sess, spoolFiles: 0 });
  assert.equal(mixed.pass, false); assert.deepEqual(mixed.missing, ['miss']); assert.deepEqual(mixed.duplicate, ['dup']);
  const classified = checkRetained({ markers: [hit('fail', 'failed')], sessions: sess, spoolFiles: 0 });
  assert.equal(classified.pass, false); assert.deepEqual(classified.failed, ['fail']);
  assert.equal(checkRetained({ markers: [hit('a', 'done')], sessions: [{ id: 's0', ...one, ends: 0 }], spoolFiles: 0 }).pass, false);
  assert.equal(checkRetained({ markers: [hit('a', 'done')], sessions: [{ id: 's0', ...one, starts: 2 }], spoolFiles: 0 }).pass, false);
  const bothStates = checkRetained({ markers: [{ id: 'both', hits: [{ classification_state: 'done' }, { classification_state: 'failed' }], spool: false }], sessions: sess, spoolFiles: 0 });
  assert.equal(bothStates.pass, false); assert.deepEqual(bothStates.failed, ['both']); assert.deepEqual(bothStates.duplicate, []);
  const spooled = checkRetained({ markers: [hit('waiting', 'done', 0, true)], sessions: sess, spoolFiles: 1 });
  assert.equal(spooled.pass, true); assert.deepEqual(spooled.missing, []);
  assert.equal(checkRetained({ markers: [hit('a', 'done')], sessions: [{ id: 's0', ...one, messages: 0 }], spoolFiles: 0 }).pass, false);
  assert.equal(checkRetained({ markers: [hit('a', 'done')], sessions: [{ id: 's0', ...one, turnEnds: 2 }], spoolFiles: 0 }).pass, false);
  assert.equal(checkRetained({ markers: [hit('a', 'done')], sessions: [{ id: 's0', ...one, failedKinds: ['last_assistant_message', 'turn_end'] }], spoolFiles: 0 }).pass, false);
  assert.deepEqual(workerPidsFrom('2026-01-01T00:00:00.000Z info run start pid=4242\n2026-01-01T00:00:01.000Z info run end exit=0 reason=stopped pid=4242\n'), [{ pid: 4242, at: Date.parse('2026-01-01T00:00:00.000Z') }]);
  assert.equal(startedBefore(process.pid, Date.now()), true);
  assert.equal(startedBefore(process.pid, Date.now() - 3_600_000), false);
  assert.equal(startedBefore(process.pid, Number.NaN), false);
  assert.equal(typeof procIdent(process.pid), 'string');
  assert.equal(procIdent(2 ** 22 + 1), null);
  assert.equal(checkRetained({ markers: [hit('a', 'done')], sessions: sess, spoolFiles: 0, prior: { rows: 1322, kept: 1322 } }).pass, true);
  assert.equal(checkRetained({ markers: [hit('a', 'done')], sessions: sess, spoolFiles: 0, prior: { rows: 1322, kept: 1321 } }).pass, false);
  assert.equal(checkNotStuck(stuckOk).pass, true);
  assert.equal(checkNotStuck({ ...stuckOk, pending: 1 }).pass, false);
  assert.equal(checkNotStuck({ ...stuckOk, workerErrors: 1 }).pass, false);
  assert.equal(checkNotStuck({ ...stuckOk, badEnds: ['batch_error'] }).pass, false);
  assert.equal(checkNotStuck({ ...stuckOk, stopMarker: true }).pass, false);
  assert.equal(checkNotStuck({ ...stuckOk, endReason: 'idle_exit' }).pass, false);
  assert.equal(countBatchLines('2026-01-01T00:00:00.000Z error batch id=x state=error\n', 0, Date.now()), 0);
  assert.equal(countErrorLines('2026-01-01T00:00:00.000Z error batch id=x state=error\n', 0), 1);
  assert.deepEqual(badEndReasons('2026-01-01T00:00:00.000Z info run end exit=1 reason=batch_error\n', 0), ['batch_error']);
  assert.deepEqual(badEndReasons('2026-01-01T00:00:00.000Z info run end exit=0 reason=stopped\n', 0), []);
  assert.equal(checkWal({ start: 100, peak: 800, final: 0 }).pass, true);
  assert.equal(checkWal({ start: 100, peak: 100, final: 0 }).pass, false);
  assert.equal(checkWal({ start: 100, peak: 100, final: 100 }).pass, false);
  assert.equal(checkWal({ start: 0, peak: 1000, final: 300 }).pass, false);
  const pid = (hwm) => [{ pid: 1, firstRss: 1, lastRss: 1, n: 1, maxHwm: hwm }];
  assert.equal(checkRss({ phaseAHwmKb: 12_000, phaseB: pid(13_000) }).pass, true);
  assert.equal(checkRss({ phaseAHwmKb: 151 * 1024, phaseB: pid(100) }).pass, false);
  assert.equal(checkRss({ phaseAHwmKb: 100, phaseB: pid(151 * 1024) }).pass, false);
  assert.equal(checkRss({ phaseAHwmKb: 100, phaseB: pid(100), children: [{ pid: 2, command: 'hook', hwmKb: 151 * 1024 }] }).pass, false);
  assert.equal(checkRss({ phaseAHwmKb: 100, phaseB: pid(100), children: [{ pid: 2, command: 'hook', hwmKb: 0 }] }).pass, false);
  assert.equal(checkRss({ phaseAHwmKb: 100, phaseB: pid(100), children: [{ pid: 2, command: 'hook', hwmKb: 1_000 }] }).pass, true);
  assert.equal(parseRss('123456\n'), 123456);
  assert.equal(parseRss('Command terminated by signal 15\n99\n'), 99);
  assert.equal(parseRss(''), 0);
  await groupKillCheck();
  assert.equal(endReasonFrom('2026-01-01T00:00:00.000Z info run end exit=0 reason=empty\n2026-01-01T00:00:01.000Z info run end exit=0 reason=stopped\n'), 'stopped');
  assert.equal(/^kept home=\S+ repo=(\S+)\s*$/m.exec('kept home=/h repo=/tmp/oboete-t068-repo-abc\n')?.[1], '/tmp/oboete-t068-repo-abc');
  assert.throws(() => replayGates({ worker: { rssKb: '1' } }), HarnessError);
  const a0 = { gated: { hooks: false, duplicates: false, lifecycle: false, worker: false }, failed: [], notGated: [], bounds: [], rssKb: 0, dbBytes: 0, walBytes: 0, repo: '', repoSource: '' };
  const md = renderMarkdown({ checks: null, error: 'held-batch', failed: true, startedAt: '', node: '', commit: '', fixture: '', fixtureLines: 0, loadAtStart: '', sessions: 1, prompts: 1, holdMs: 1, phaseA: a0, phaseB: { samples: [], hooks: [], hookErrors: [], stopMarker: false, exitReason: null } });
  assert.match(md, /\| retained \| not run \| held-batch \|/);
  assert.match(md, /\| not-stuck \| not run \| held-batch \|/);
  assert.match(md, /\| wal-recycled \| not run \| held-batch \|/);
  assert.match(md, /\| rss-bound \| not run \| held-batch \|/);
  assert.doesNotMatch(md, /\| retained \| (pass|fail) \|/);
}
function replayGates(json) {
  if (json === null || typeof json !== 'object') throw new HarnessError('phase A replay produced no JSON');
  const lifecyclePass = Array.isArray(json.lifecycle)
    ? json.lifecycle.length > 0 && json.lifecycle.every((row) => row.pass === true)
    : (json.bounds ?? []).find((row) => row.sc === 'lifecycle')?.status === 'pass';
  const gated = {
    hooks: json.hooks?.pass === true, duplicates: json.duplicates?.pass === true,
    lifecycle: lifecyclePass === true, worker: json.worker?.pass === true,
  };
  const failed = Object.entries(gated).filter(([, pass]) => !pass).map(([name]) => name);
  const notGated = [];
  for (const row of json.bounds ?? []) {
    if (row.status !== 'fail' || GATED.has(row.sc)) continue;
    notGated.push({ sc: row.sc, measured: row.measured, bound: row.bound, reason: NO_MODEL.has(row.sc) ? 'no model (preset none)' : 'not gated' });
  }
  const rssKb = json.worker?.rssKb;
  if (typeof rssKb !== 'number' || !Number.isFinite(rssKb)) throw new HarnessError('phase A replay JSON worker.rssKb is not a number');
  return { gated, failed, notGated, rssKb, bounds: json.bounds ?? [] };
}
function mdRow(cells) { return `| ${cells.join(' | ')} |`; }
function mdTable(headers, rows) {
  const rule = `|${headers.map(() => '---').join('|')}|`;
  return [mdRow(headers), rule, ...rows.map(mdRow)].join('\n');
}
function kibToMib(kib) { return (kib / 1024).toFixed(3); }
function checkRows(report) {
  const c = report.checks, yn = (v) => (v ? 'pass' : 'fail');
  if (c == null) {
    const err = report.error ?? 'unread';
    return ['retained', 'not-stuck', 'wal-recycled', 'rss-bound'].map((name) => [name, 'not run', err]);
  }
  return [
    ['retained', yn(c.retained.pass), `missing=${c.retained.missing.join(',') || 'none'} duplicate=${c.retained.duplicate.join(',') || 'none'} failed-classification=${c.retained.failed.join(',') || 'none'} sessionFail=${c.retained.sessionFail.join(',') || 'none'} phase-A rows kept=${c.retained.prior?.kept ?? 0}/${c.retained.prior?.rows ?? 0} spoolFiles=${c.retained.spoolFiles}`],
    ['not-stuck', yn(c.notStuck.pass), `pending=${c.notStuck.pending} waiting=${c.notStuck.waiting} parked=${c.notStuck.parked} legacy=${c.notStuck.legacy} processed=${c.notStuck.processed} spoolFiles=${c.notStuck.spoolFiles} liveBatches=${c.notStuck.liveBatches} endReason=${c.notStuck.endReason ?? 'unread'} stopMarker=${c.notStuck.stopMarker === true} workerErrors=${c.notStuck.workerErrors} badEnds=${(c.notStuck.badEnds ?? []).join(',') || 'none'}. ${c.notStuck.note}`],
    ['wal-recycled', yn(c.wal.pass), `start=${c.wal.start} peak=${c.wal.peak} final=${c.wal.final} grew=${c.wal.grew} pass-if final<=peak*${c.wal.fraction} batchesHeld=${c.wal.batchesHeld ?? 0}`],
    ['rss-bound', yn(c.rss.pass), `maxHwm=${c.rss.maxHwm} KiB (${kibToMib(c.rss.maxHwm)} MiB) bound=${c.rss.boundKib} KiB; phase A ${c.rss.phaseAHwmKb} KiB; children n=${c.rss.childCount ?? 0} max=${c.rss.childMax ?? 0} KiB unmeasured=${(c.rss.unmeasured ?? []).length}. ${c.rss.note}`],
  ];
}
function renderMarkdown(report) {
  const { checks: c, phaseA: a, phaseB: b } = report;
  const hookMs = b.hooks.map((h) => h.ms), failedHooks = b.hooks.filter(hookFailed);
  const holdSamples = b.samples.filter((s) => s.stage === 'hold');
  const series = [['memory.db bytes', 'dbBytes'], ['memory.db-wal bytes', 'walBytes'], ['spool files', 'spool'], ['VmRSS KiB', 'rssKb'], ['VmHWM KiB', 'hwmKb']].map(([name, key]) => {
    const s = seriesStats(holdSamples, key); return [name, String(s.n), String(s.min), String(s.median), String(s.max)];
  });
  const stageMax = STAGES.map((stage) => { const ss = b.samples.filter((s) => s.stage === stage); return [stage, String(ss.length), String(ss.reduce((m, s) => Math.max(m, s.hwmKb ?? 0), 0)), String(ss.reduce((m, s) => Math.max(m, s.walBytes ?? 0), 0))]; });
  const pidRows = (c == null ? pidStats(b.samples) : c.rss.phaseB).map((p) => [String(p.pid), String(p.firstRss), String(p.lastRss), String(p.n), String(p.maxHwm), p.observe ? 'observe' : 'other']);
  const notGated = a.notGated.length === 0 ? 'None.' : a.notGated.map((row) => `- ${row.sc}: ${row.measured} (${row.reason}).`).join('\n');
  const bounds = a.bounds.length === 0 ? 'No bounds table in replay JSON.' : mdTable(['SC', 'Measured', 'Bound', 'Status'], a.bounds.map((row) => [row.sc, String(row.measured), String(row.bound), row.status]));
  const hookFail = failedHooks.length === 0 ? '' : mdTable(['event', 'session', 'status', 'ms'], failedHooks.map((h) => [h.event, String(h.session ?? ''), h.timedOut ? 'timeout' : String(h.status), String(h.ms)]));
  const pids = pidRows.length === 0 ? 'No processes sampled.' : mdTable(['pid', 'first VmRSS', 'last VmRSS', 'n', 'max VmHWM', 'role'], pidRows);
  const stopNote = b.stopMarker ? `still present; doctor worker: ${report.workerReason ?? 'unread'}; harness did not clear it` : 'cleared by the product resident on stopped';
  let closing = 'Every listed check passed on this run.';
  if (report.error !== undefined) closing = `Harness error: ${report.error} Exit 2.`;
  else if (report.failed) closing = 'One or more checks failed. Exit 1.';
  return `## Resource measurement (T042 / SC-008)\n\n### Setup\n\n- Date: ${report.startedAt}\n- Node: \`${report.node}\`.\n- Commit: \`${report.commit}\`.\n- Fixture: \`${report.fixture}\` (${report.fixtureLines} lines).\n- Load average at the start of the run: \`${report.loadAtStart}\`.\n- Config:\n\`\`\`toml\n${CONFIG.trim()}\n\`\`\`\n- Phase B: ${report.sessions} sessions, ${report.prompts} prompts, hold ${report.holdMs} ms.\n- Phase A repository: \`${a.repo}\` (${a.repoSource}). Replay JSON reports repoId, not a filesystem path; replayArgv accepts --keep and has no --repo, so a harness-created repository cannot be passed in.\n- Worker exit reason: \`${b.exitReason ?? 'unread'}\` (from logs/observe.log). Expected stopped: observe --stop writes the product sentinel; the resident exits stopped; shutdownResident runs the product's releaseForExit and wal_checkpoint(TRUNCATE).\n- Stop marker after that release: ${stopNote}.\n\n### Phase A replay bounds\n\n${bounds}\n\nGated (must pass): hooks=${a.gated.hooks} duplicates=${a.gated.duplicates} lifecycle=${a.gated.lifecycle} worker=${a.gated.worker}.\nPhase A worker.rssKb (VmHWM): ${a.rssKb} KiB (${kibToMib(a.rssKb)} MiB). memory.db=${a.dbBytes} -wal=${a.walBytes}.\n\nReported-not-gated:\n${notGated}\n\n### Phase B hooks\n\nn=${b.hooks.length} p50=${median(hookMs).toFixed(1)} ms max=${hookMs.length === 0 ? 0 : Math.max(...hookMs)} ms. Non-zero or timeout: ${failedHooks.length}.\n${hookFail}\n\n### Series (phase B hold)\n\n${mdTable(['Series', 'n', 'min', 'median', 'max'], series)}\n\nPer-stage max VmHWM and -wal:\n\n${mdTable(['stage', 'n', 'max VmHWM KiB', 'max -wal bytes'], stageMax)}\n\n### Checks\n\n${mdTable(['Check', 'Status', 'Measured'], checkRows(report))}\n\nPhase B pid VmRSS (first/last) and sample count; growth is not gated:\n\n${pids}\n\n${closing}\nAn interrupted run can leave a detached resident in the temp home.\n`;
}
async function phaseA(cli, paths, env) {
  const result = await spawnWait(process.execPath, [BUNDLE, 'fixture', 'replay', cli.fixture, '--json', '--home', paths.oboeteHome, '--keep'], { env, cwd: ROOT, timeoutMs: REPLAY_TIMEOUT_MS, inheritStderr: true });
  if (result.timedOut) throw new HarnessError('phase A replay timed out');
  // 0 is a clean replay and 1 is a replay whose own bounds failed, which replayGates records. Any
  // other code, and any signal, ends the run: the JSON may already have been printed by then.
  if (result.signal !== null || result.status === null) throw new HarnessError(`phase A replay was killed by ${result.signal ?? 'an unreported signal'}`);
  if (result.status !== 0 && result.status !== 1) throw new HarnessError(`phase A replay exited ${result.status}`);
  if (!existsSync(paths.db)) throw new HarnessError('phase A left no memory.db');
  const json = parseJsonStdout(result.stdout);
  const found = findReplayRepo(json, result.stderr, paths.tmp);
  paths.repo = found.repo;
  return { exit: result.status, ms: result.ms, json, dbBytes: fileBytes(paths.db), walBytes: fileBytes(`${paths.db}-wal`), repo: found.repo, repoSource: found.source, ...replayGates(json) };
}
async function phaseB(cli, paths, env, runId, samples) {
  let stage = 'hold', reader, walWitness, holdFrom = 0, holdTo = 0;
  const sampler = startSampler(paths, samples, () => stage);
  try {
    reader = holdReader(paths.db);
    holdFrom = Date.now();
    const sessionRun = await runSessions(env, paths.repo, cli, runId);
    const remaining = cli.holdMs - (Date.now() - holdFrom);
    if (remaining > 0) await sleep(remaining);
    const ends = [];
    for (const sessionId of sessionRun.sessionIds) {
      ends.push({ event: 'SessionEnd', session: sessionId, ...(await runHook(env, paths.repo, 'SessionEnd', claudePayload(paths.repo, sessionId, 'SessionEnd', { reason: 'prompt_input_exit' }))) });
    }
    await waitHeldBatch(join(paths.oboeteHome, 'logs', 'observe.log'), holdFrom);
    holdTo = Date.now();
    reader.release();
    const hooks = [...sessionRun.hooks, ...ends], hookErrors = hooks.filter(hookFailed);
    stage = 'drain';
    await waitPending(env, paths.repo, PENDING_TIMEOUT_MS);
    stage = 'stop';
    // Without a second connection the resident's own close is the last one, and SQLite then deletes
    // the -wal itself: a zero-byte file would say nothing about the product's TRUNCATE checkpoint.
    walWitness = openRo(paths.db, 2_000);
    walWitness.prepare('SELECT 1 AS ok FROM raw_events LIMIT 1').get();
    const stopAt = Date.now();
    const stop = await spawnWait(process.execPath, [BUNDLE, 'observe', '--stop'], { env, cwd: paths.repo, timeoutMs: HOOK_TIMEOUT_MS });
    if (stop.timedOut || stop.status !== 0) throw new HarnessError(`observe --stop failed status=${stop.status} signal=${stop.signal}`);
    await waitGone(paths.oboeteHome, paths.db, STOPPED_TIMEOUT_MS);
    stage = 'final';
    const logText = readObserveLog(paths.oboeteHome);
    const batchesHeld = countBatchLines(logText, holdFrom, holdTo);
    if (batchesHeld === 0) throw new HarnessError('held reader never overlapped a worker batch');
    const held = samples.filter((s) => s.stage === 'hold');
    if (!held.some((s) => s.processes.some((p) => p.observe))) throw new HarnessError('no worker process of this home was sampled while the reader was held');
    finishSampling(sampler);
    const walStart = held[0]?.walBytes ?? 0;
    const walFinal = fileBytes(`${paths.db}-wal`);
    return {
      samples, hooks, hookErrors, sessionIds: sessionRun.sessionIds, markers: sessionRun.markers,
      walStart, walPeak: held.reduce((m, s) => Math.max(m, s.walBytes), walStart), walFinal,
      exitReason: endReasonFrom(logText, stopAt), stopMarker: existsSync(join(paths.oboeteHome, 'worker-stop')), batchesHeld,
      workerErrors: countErrorLines(logText, holdFrom), badEnds: badEndReasons(logText, holdFrom),
    };
  } finally {
    try { reader?.release(); } catch { /* released */ }
    try { walWitness?.close(); } catch { /* closed */ }
    sampler.stop();
  }
}
// The temporary home, its bin with the node the product's hooks find on PATH, and the directory the
// wrappers write their RSS into.
function requireInputs(cli) {
  if (!existsSync(cli.fixture)) throw new HarnessError(`fixture file not found: ${cli.fixture}`);
  if (!existsSync(BUNDLE)) throw new HarnessError(`engine bundle not found: ${BUNDLE}`);
  if (!existsSync(TIME_BIN)) throw new HarnessError(`${TIME_BIN} is required to read each child's peak RSS (apt-get install time)`);
}
// `root` is created by the caller, so a failure part way through still leaves it a home to keep and
// a path to print.
function prepareIsolation(root) {
  const paths = {
    root, userHome: join(root, 'home'), oboeteHome: join(root, 'oboete'),
    tmp: join(root, 'tmp'), repo: '', db: join(root, 'oboete', 'memory.db'), spool: join(root, 'oboete', 'spool'),
    bin: join(root, 'bin'),
  };
  rssDir = join(root, 'rss');
  for (const dir of [paths.userHome, paths.tmp, paths.bin, rssDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  symlinkSync(process.execPath, join(paths.bin, 'node'));
  writeConfig(paths.oboeteHome);
  return paths;
}
function buildChecks({ a, b, hits, doctor, paths, samples }) {
  return {
    retained: checkRetained(hits),
    notStuck: checkNotStuck({ ...doctor.stuck, spoolFiles: spoolCount(paths.spool), liveBatches: liveBatches(paths.db),
      endReason: b.exitReason, workerErrors: b.workerErrors, badEnds: b.badEnds, stopMarker: b.stopMarker }),
    wal: checkWal({ start: b.walStart, peak: b.walPeak, final: b.walFinal, batchesHeld: b.batchesHeld }),
    rss: checkRss({ phaseAHwmKb: a.rssKb, phaseB: pidStats(samples), children: childPeaks }),
  };
}
async function runLive(cli) {
  const startedAt = new Date().toISOString(), loadAtStart = loadAverage(), runId = randomUUID().slice(0, 8), samples = [];
  let isolation, paths, workerReason, error, logError;
  let priorIds = [];
  let a = { gated: { hooks: false, duplicates: false, lifecycle: false, worker: false }, failed: [], notGated: [], bounds: [], rssKb: 0, dbBytes: 0, walBytes: 0, repo: '', repoSource: '' };
  let b = { samples, hooks: [], hookErrors: [], sessionIds: [], markers: [], walStart: 0, walPeak: 0, walFinal: 0, exitReason: null, stopMarker: false, batchesHeld: 0 };
  let checks = null;
  try {
    requireInputs(cli);
    isolation = mkdtempSync(join(tmpdir(), 'oboete-t042-'));
    paths = prepareIsolation(isolation);
    const env = childEnv(paths);
    a = await phaseA(cli, paths, env);
    priorIds = historyIds(paths.db);
    b = await phaseB(cli, paths, env, runId, samples);
    const hits = loadHits(paths.db, paths.spool, b.markers, b.sessionIds);
    hits.prior = { rows: priorIds.length, kept: historyKept(paths.db, priorIds) };
    const doctor = await readDoctor(env, paths.repo);
    workerReason = doctor.worker?.reason;
    checks = buildChecks({ a, b, hits, doctor, paths, samples });
  } catch (err) {
    // An unexpected error is still a failed run with a database, a spool and a log worth keeping,
    // so it becomes a report rather than a stack trace over a deleted home.
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'error';
    error = err instanceof HarnessError ? message : `unexpected ${name}: ${message}`;
    process.stderr.write(`${error}\n`);
  } finally {
    // `isolation` is the directory to keep and report; `paths` is what there is to stop and save,
    // and a setup that failed part way through has the first without the second.
    if (paths !== undefined) {
      await stopHomeProcesses(paths.oboeteHome);
      try { copyObserveLog(paths.oboeteHome, cli.jsonOut); } catch (err) {
        logError = `could not save the worker log beside --json-out: ${err instanceof Error ? err.message : String(err)}`;
        process.stderr.write(`${logError}\n`);
      }
    }
  }
  const failed = error !== undefined || logError !== undefined || a.failed.length > 0 || b.hookErrors.length > 0 || (checks !== null && Object.values(checks).some((row) => !row.pass));
  return {
    startedAt, node: `${process.execPath} (${process.version})`, commit: gitHead(), fixture: cli.fixture,
    fixtureLines: existsSync(cli.fixture) ? readFileSync(cli.fixture, 'utf8').split('\n').filter((line) => line !== '').length : 0,
    loadAtStart, sessions: cli.sessions, prompts: cli.prompts, holdMs: cli.holdMs, runId, phaseA: a, phaseB: b, checks, failed, error, logError, workerReason,
    home: isolation,
  };
}
// The home outlives the receipts: a failed run keeps it, and a clean one is deleted only once its
// markdown and JSON are on disk.
function cleanupHome(cli, report) {
  if (report.home === undefined) return;
  if (cli.keep || report.failed) { process.stderr.write(`kept ${report.home}\n`); return; }
  rmSync(report.home, { recursive: true, force: true });
}
async function main(argv) {
  const cli = parseCli(argv);
  if (cli.selfCheck) { await selfCheck(); return 0; }
  const report = await runLive(cli);
  process.stdout.write(renderMarkdown(report));
  if (cli.jsonOut !== undefined) {
    mkdirSync(dirname(cli.jsonOut), { recursive: true });
    writeFileSync(cli.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  cleanupHome(cli, report);
  if (report.error !== undefined) return 2;
  return report.failed ? 1 : 0;
}
try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
