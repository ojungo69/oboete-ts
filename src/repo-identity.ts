import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

import { sha256Hex } from './hash.js';

export type RepoIdentity = {
  id: string;
  identityKind: 'remote' | 'common_dir';
  normalizedIdentity: string;
  root: string;
  worktreeKey: string | null;
};

// A hook must return within 300 ms (FR-002), so git gets a slice of it: one call may take
// GIT_TIMEOUT_MS and the whole identity may take GIT_BUDGET_MS, after which the remaining calls are
// skipped and the identity falls back to the git common directory or the working directory. The
// caller lowers the budget to what is left of its own deadline (`options.budgetMs`), because a slow
// git (cold disk, WSL /mnt/c, NFS) would otherwise leave the detector nothing to run in.
const GIT_TIMEOUT_MS = 120;
const GIT_BUDGET_MS = 250;

/** The one child process this module starts; a test injects its own to count the calls. */
export type GitSpawn = (
  file: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

// `C:\path\repo` is a local path on Windows, not a host called `c` (R8 normalizes to host/path).
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
  'git:': '9418',
};

const REMOTE_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:', 'file:']);

/** A call git answered carries its exit status; a timeout, a signal or a spawn error is `null`. */
type GitResult = { status: number | null; stdout: string };
const UNANSWERED: GitResult = { status: null, stdout: '' };

function git(spawn: GitSpawn, cwd: string, args: string[], timeout: number): GitResult {
  // FR-004: the identity comes from the repository at `cwd` and nothing else, so git's own
  // repository-discovery and configuration variables (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE,
  // GIT_CONFIG_*) are dropped; a localized message must not change it either.
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.LC_ALL = 'C';

  const result = spawn('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  if (result.error !== undefined || result.status === null) return UNANSWERED;
  return { status: result.status, stdout: result.stdout.trim() };
}

function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

function trimPath(path: string): string {
  const withoutSlashes = withoutTrailingSlashes(path);
  return withoutSlashes.endsWith('.git')
    ? withoutTrailingSlashes(withoutSlashes.slice(0, -'.git'.length))
    : withoutSlashes;
}

/**
 * `host/path` with userinfo, query and fragment removed, so a credential embedded in a remote URL
 * never reaches the database or a pack (R8). Returns null when the URL is not one oboete knows.
 */
function normalizeRemote(url: string): string | null {
  const raw = url.trim();
  if (WINDOWS_DRIVE.test(raw)) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const scpLike = /^(?:[^@/]+@)?([^@/:]+):(.*)$/.exec(raw);
  if (!hasScheme && scpLike !== null) {
    const path = trimPath(scpLike[2]).replace(/^\/+/, '');
    return path === '' ? null : `${scpLike[1].toLowerCase()}/${path}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!REMOTE_SCHEMES.has(parsed.protocol)) return null;

  // Reading only hostname, port and pathname drops the userinfo, the query and the fragment.
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port !== '' && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : '';
  const path = trimPath(parsed.pathname);
  if (host === '' && path === '') return null;
  const absolutePath = path.startsWith('/') ? path : `/${path}`;
  return `${host}${port}${absolutePath}`;
}

/** Transfer metadata must already be normalized before it can create a remote repository. */
export function isCanonicalRemoteIdentity(value: string): boolean {
  if (/[\s\p{C}?#]/u.test(value) || value.split('/')[0].includes('@')) return false;
  if (value.startsWith('/')) return normalizeRemote(`file://${value}`) === value;
  // The original scheme is intentionally absent; either common scheme can preserve a custom port.
  return ['ssh://', 'https://'].some((scheme) => normalizeRemote(`${scheme}${value}`) === value);
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function identity(
  identityKind: RepoIdentity['identityKind'],
  normalizedIdentity: string,
  root: string,
  worktreeKey: string | null,
): RepoIdentity {
  return {
    // data-model.md repos: first 16 hex of sha256 over the normalized identity.
    id: sha256Hex(normalizedIdentity).slice(0, 16),
    identityKind,
    normalizedIdentity,
    root,
    worktreeKey,
  };
}

function directoryGeneration(path: string): string | null {
  try {
    const canonical = realpathSync(path);
    const metadata = statSync(canonical, { bigint: true });
    if (!metadata.isDirectory() || metadata.ino === 0n || metadata.birthtimeNs <= 0n) return null;
    return `fs1:${sha256Hex(JSON.stringify([canonical, String(metadata.dev), String(metadata.ino), String(metadata.birthtimeNs)]))}`;
  } catch { return null; }
}

/** What git said about `cwd`, and whether every call of the lookup completed with an answer. */
type GitAnswer = { top: string; common: string; gitDir: string; url: string | null; complete: boolean };

function askGit(run: (args: string[]) => GitResult): GitAnswer {
  // The per-worktree Git directory distinguishes linked checkouts without another hook process.
  const parsed = run(['rev-parse', '--show-toplevel', '--git-common-dir', '--absolute-git-dir']);
  const [top = '', common = '', gitDir = ''] = parsed.status === 0 ? parsed.stdout.split('\n') : [];
  const located = parsed.status === 0 && top !== '' && common !== '' && gitDir !== '';
  // A repository with an origin costs this one call; only a repository without one pays for the
  // listing, which is rare enough to keep the common case at two calls inside the budget.
  const origin = run(['remote', 'get-url', 'origin']);
  if (origin.status === 0) return { top, common, gitDir, url: origin.stdout, complete: located };
  const listed = run(['remote']);
  const name = listed.status === 0 ? listed.stdout.split('\n').map((entry) => entry.trim()).find((entry) => entry !== '') : undefined;
  const other = name === undefined ? undefined : run(['remote', 'get-url', name]);
  // #340: only exit 2 from `get-url origin` ("No such remote") is a confirmed absence; any other
  // outcome leaves the answer usable now but never recorded.
  const complete = located && origin.status === 2 && listed.status === 0 && (other === undefined || other.status === 0);
  return { top, common, gitDir, url: other?.status === 0 ? other.stdout : null, complete };
}

function identityFrom(cwd: string, answer: GitAnswer): RepoIdentity {
  const root = answer.top === '' ? cwd : answer.top;
  const worktreeKey = directoryGeneration(answer.gitDir === '' ? root : resolve(cwd, answer.gitDir));
  const normalized = answer.url === null ? null : normalizeRemote(answer.url);
  if (normalized !== null) return identity('remote', normalized, root, worktreeKey);
  // ponytail: without a usable remote the identity is this machine's path, so the same repository
  // on another machine gets another id; `oboete import --map-repo` maps the two.
  return identity('common_dir', realpath(answer.common === '' ? cwd : resolve(cwd, answer.common)), root, worktreeKey);
}

// ---------------------------------------------------------------------------
// #340: git's complete answers, remembered so a starved hook never invents another identity
// ---------------------------------------------------------------------------

/** Where a hook's lookup may read and write git's remembered answers, and how long it may spend reading. */
export type IdentityCache = { dir: string; lookupMs: number };

/** Most a hook spends reading a remembered answer; the caller also keeps it inside its own deadline. */
export const IDENTITY_LOOKUP_MS = 60;

const CACHE_VERSION = 1;
const CACHE_MAX_BYTES = 8 * 1024;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONFIG_MAX_BYTES = 64 * 1024;
/** A write asks git one more question first; below this the budget goes to the identity alone. */
const CACHE_WRITE_MIN_BUDGET_MS = 150;
const INCLUDE_HEADER = /^[ \t]*\[[ \t]*include/im;

type GitLocation = { entry: string; entryDir: string; gitDir: string; commonDir: string };

/** The git directories a `.git` entry in `dir` names: itself, or the `gitdir:` of a `.git` file. */
function gitLocationAt(dir: string, isFile: boolean): GitLocation | null {
  const entry = realpathSync(join(dir, '.git'));
  let gitDir = entry;
  if (isFile) {
    const pointer = /^gitdir: (.+)$/m.exec(readSmallFile(entry, 4096) ?? '');
    if (pointer === null) return null;
    gitDir = realpathSync(resolve(dir, pointer[1].trim()));
  }
  const common = readSmallFile(join(gitDir, 'commondir'), 4096);
  return { entry, entryDir: dir, gitDir, commonDir: common === null ? gitDir : realpathSync(resolve(gitDir, common.trim())) };
}

/** The first `.git` above `cwd` on one filesystem, and the git directories it names; never git itself. */
function locateGit(cwd: string): GitLocation | null {
  try {
    let dir = realpathSync(cwd);
    const device = statSync(dir).dev;
    for (;;) {
      const found = statSync(join(dir, '.git'), { throwIfNoEntry: false });
      if (found !== undefined) return gitLocationAt(dir, found.isFile());
      const parent = dirname(dir);
      if (parent === dir || statSync(parent).dev !== device) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/** A regular file of at most `limit` bytes, or null when it is absent, special or larger. */
function readSmallFile(path: string, limit: number): string | null {
  const found = statSync(path, { throwIfNoEntry: false });
  if (found === undefined || !found.isFile() || found.size > limit) return null;
  return readFileSync(path, 'utf8');
}

function stamp(path: string): string {
  try {
    const found = statSync(path, { bigint: true, throwIfNoEntry: false });
    return found === undefined ? 'absent'
      : [found.dev, found.ino, found.size, found.mtimeNs, found.ctimeNs, found.mode, found.uid].join(':');
  } catch {
    return 'unreadable';
  }
}

/** The `git` a spawn would run, found the way the shell finds it; no process is started. */
function gitExecutable(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'git');
    const found = statSync(candidate, { throwIfNoEntry: false });
    if (found !== undefined && found.isFile() && (found.mode & 0o111) !== 0) return candidate;
  }
  return null;
}

function globalConfigs(): string[] {
  const home = process.env.HOME ?? homedir();
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return [join(xdg, 'git', 'config'), join(home, '.gitconfig')];
}

/** Every file whose change can change git's answer for this location (the plan's signature list). */
function signedPaths(location: GitLocation, root: string, system: string, executable: string | null): string[] {
  const { entry, entryDir, gitDir, commonDir } = location;
  return [entry, entryDir, root,
    gitDir, join(gitDir, 'commondir'), join(gitDir, 'config.worktree'), join(gitDir, 'HEAD'), join(gitDir, 'objects'), join(gitDir, 'refs'),
    commonDir, join(commonDir, 'config'), join(commonDir, 'objects'), join(commonDir, 'refs'),
    join(commonDir, 'remotes'), join(commonDir, 'remotes', 'origin'), join(commonDir, 'branches'), join(commonDir, 'branches', 'origin'),
    ...globalConfigs(), ...(system === '' ? [] : [system]), ...(executable === null ? [] : [executable])];
}

/** HOME, XDG_CONFIG_HOME and PATH decide which files git reads; a digest keeps a long PATH out of the entry. */
function environmentStamp(): string {
  return sha256Hex(JSON.stringify([process.env.HOME ?? '', process.env.XDG_CONFIG_HOME ?? '', process.env.PATH ?? '']));
}

function cacheFile(dir: string, location: GitLocation): string {
  return join(dir, `${sha256Hex(JSON.stringify([location.entryDir, location.entry]))}.json`);
}

type CacheEntry = {
  v: number; env: string; git: string | null; paths: string[]; stamps: string[];
  identity: { kind: RepoIdentity['identityKind']; normalized: string; root: string; worktreeKey: string | null };
  writtenAt: number;
};

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseEntry(text: string): CacheEntry | null {
  const entry = JSON.parse(text) as Partial<CacheEntry> | null;
  const kept = entry?.identity;
  if (entry?.v !== CACHE_VERSION || typeof entry.env !== 'string'
    || !(entry.git === null || typeof entry.git === 'string') || !strings(entry.paths) || !strings(entry.stamps)
    || entry.paths.length !== entry.stamps.length || typeof entry.writtenAt !== 'number' || typeof kept !== 'object' || kept === null
    || (kept.kind !== 'remote' && kept.kind !== 'common_dir') || typeof kept.normalized !== 'string' || kept.normalized === ''
    || typeof kept.root !== 'string' || !(kept.worktreeKey === null || typeof kept.worktreeKey === 'string')) return null;
  return entry as CacheEntry;
}

/** A remembered answer whose every signed input is unchanged, within the lookup's own bound. */
function lookupCached(cwd: string, cache: IdentityCache): RepoIdentity | null {
  if (!(cache.lookupMs > 0)) return null;
  const deadline = performance.now() + cache.lookupMs;
  try {
    const location = locateGit(cwd);
    if (location === null) return null;
    const text = readSmallFile(cacheFile(cache.dir, location), CACHE_MAX_BYTES);
    const entry = text === null ? null : parseEntry(text);
    const age = Date.now() - (entry?.writtenAt ?? 0);
    // The file name is the digest of the location, so a found entry already belongs to it.
    if (entry === null || age < 0 || age > CACHE_MAX_AGE_MS || entry.env !== environmentStamp()
      || entry.git !== gitExecutable()) return null;
    for (const [index, path] of entry.paths.entries()) {
      if (performance.now() > deadline || stamp(path) !== entry.stamps[index]) return null;
    }
    const { kind, normalized, root, worktreeKey } = entry.identity;
    return identity(kind, normalized, root, worktreeKey);
  } catch {
    return null;
  }
}

/** The configuration files git reads, when none of them is special, oversized or includes another. */
function configsWithoutIncludes(location: GitLocation, system: string): boolean {
  for (const path of [join(location.commonDir, 'config'), join(location.gitDir, 'config.worktree'), ...globalConfigs(), ...(system === '' ? [] : [system])]) {
    const found = statSync(path, { throwIfNoEntry: false });
    if (found === undefined) continue;
    const text = readSmallFile(path, CONFIG_MAX_BYTES);
    if (text === null || INCLUDE_HEADER.test(text)) return false;
  }
  return true;
}

/**
 * Remembers `resolved` only when git's paths are the ones found on the filesystem and every signed
 * input stamped before the git calls is unchanged after them. Nothing here may fail the caller.
 */
function recordCached(cache: IdentityCache, location: GitLocation, system: string, executable: string | null,
  before: string[], cwd: string, answer: GitAnswer, resolved: RepoIdentity): void {
  try {
    const same = (reported: string, found: string): boolean => realpathSync(resolve(cwd, reported)) === found;
    if (!answer.complete || !same(answer.top, location.entryDir) || !same(answer.gitDir, location.gitDir)
      || !same(answer.common, location.commonDir) || !configsWithoutIncludes(location, system)) return;
    const paths = signedPaths(location, resolved.root, system, executable);
    const after = paths.map(stamp);
    if (after.join('\0') !== before.join('\0') || after.includes('unreadable')) return;
    const entry: CacheEntry = {
      v: CACHE_VERSION, env: environmentStamp(), git: executable, paths, stamps: after,
      identity: { kind: resolved.identityKind, normalized: resolved.normalizedIdentity, root: resolved.root, worktreeKey: resolved.worktreeKey },
      writtenAt: Date.now(),
    };
    const text = JSON.stringify(entry);
    if (Buffer.byteLength(text) > CACHE_MAX_BYTES) return;
    mkdirSync(cache.dir, { recursive: true, mode: 0o700 });
    const file = cacheFile(cache.dir, location);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // #340: the cache only ever saves a git call; the identity git just gave stands either way.
  }
}

/**
 * FR-004: the repository identity is derived here from the repository's remote or its location.
 * Nothing is ever taken from an event payload or an environment variable. With `cache`, a hook
 * first reuses git's last complete answer for this `.git` when nothing git reads has changed
 * (#340): a starved git then cannot turn one repository into two.
 */
export function resolveRepoIdentity(
  cwd: string,
  options?: { spawn?: GitSpawn; budgetMs?: number; callTimeoutMs?: number; cache?: IdentityCache },
): RepoIdentity {
  const cache = options?.cache;
  const hit = cache === undefined ? null : lookupCached(cwd, cache);
  if (hit !== null) return hit;

  const spawn = options?.spawn ?? spawnSync;
  // A hook only lowers the budget; a caller outside a hook raises both by naming a call timeout.
  const budget = options?.callTimeoutMs === undefined
    ? Math.min(GIT_BUDGET_MS, options?.budgetMs ?? GIT_BUDGET_MS) : options?.budgetMs ?? GIT_BUDGET_MS;
  const callTimeout = options?.callTimeoutMs ?? GIT_TIMEOUT_MS;
  const startedAt = performance.now();
  const remaining = (): number => Math.floor(budget - (performance.now() - startedAt));
  const run = (args: string[]): GitResult => {
    // The budget bounds the whole identity, so the last call gets whatever is left of it.
    // performance.now() is fractional and spawnSync demands an unsigned integer timeout, so the
    // remainder is floored: a fractional value raises RangeError instead of falling back.
    const left = remaining();
    return left < 1 ? UNANSWERED : git(spawn, cwd, args, Math.min(callTimeout, left));
  };

  // A write costs one question more, asked first so its answer is covered by the before-stamps.
  const location = cache !== undefined && remaining() >= CACHE_WRITE_MIN_BUDGET_MS ? locateGit(cwd) : null;
  const system = location === null ? UNANSWERED : run(['var', 'GIT_CONFIG_SYSTEM']);
  const executable = system.status === 0 ? gitExecutable() : null;
  const signed = location !== null && system.status === 0;
  // The root is git's own answer; the before-stamps use the filesystem's, and the write compares the two.
  const before = signed ? signedPaths(location, location.entryDir, system.stdout, executable).map(stamp) : [];

  const answer = askGit(run);
  const resolved = identityFrom(cwd, answer);
  if (signed && cache !== undefined) recordCached(cache, location, system.stdout, executable, before, cwd, answer, resolved);
  return resolved;
}
