import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

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
type GitAnswer = {
  top: string; common: string; gitDir: string; worktreeKey: string | null; url: string | null; complete: boolean;
};

function askGit(cwd: string, run: (args: string[]) => GitResult): GitAnswer {
  // The per-worktree Git directory distinguishes linked checkouts without another hook process.
  const parsed = run(['rev-parse', '--show-toplevel', '--git-common-dir', '--absolute-git-dir']);
  const [top = '', common = '', gitDir = ''] = parsed.status === 0 ? parsed.stdout.split('\n') : [];
  const located = parsed.status === 0 && top !== '' && common !== '' && gitDir !== '';
  // Taken between the calls, so the time it takes is time the next call does not get.
  const root = top === '' ? cwd : top;
  const worktreeKey = directoryGeneration(gitDir === '' ? root : resolve(cwd, gitDir));
  // A repository with an origin costs this one call; only a repository without one pays for the
  // listing, which is rare enough to keep the common case at two calls inside the budget.
  const origin = run(['remote', 'get-url', 'origin']);
  if (origin.status === 0) return { top, common, gitDir, worktreeKey, url: origin.stdout, complete: located };
  const listed = run(['remote']);
  const name = listed.status === 0 ? listed.stdout.split('\n').map((entry) => entry.trim()).find((entry) => entry !== '') : undefined;
  const other = name === undefined ? undefined : run(['remote', 'get-url', name]);
  // #340: only exit 2 from `get-url origin` ("No such remote") with no remote at all is recorded. A
  // fallback remote reads files the signature does not cover, and any other outcome is used now only.
  const complete = located && origin.status === 2 && listed.status === 0 && name === undefined;
  return { top, common, gitDir, worktreeKey, url: other?.status === 0 ? other.stdout : null, complete };
}

function identityFrom(cwd: string, answer: GitAnswer): RepoIdentity {
  const root = answer.top === '' ? cwd : answer.top;
  const { worktreeKey } = answer;
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

const CACHE_VERSION = 2;
const CACHE_MAX_BYTES = 8 * 1024;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONFIG_MAX_BYTES = 64 * 1024;
/** Git time a miss keeps for the identity itself: the cache is prepared only from what is above it. */
const CACHE_WRITE_MIN_BUDGET_MS = 150;
// Every include form git accepts (after a BOM, `[core][include]`, any case) means nothing is recorded.
const INCLUDE_HEADER = /\[\s*include/i;

type GitLocation = { entry: string; entryDir: string; gitDir: string; commonDir: string };

/**
 * One filesystem call of the cache, started only while `alive` holds. Past the bound it throws, and
 * every cache path turns that into a miss, so at most the call already running overruns.
 */
function within<T>(alive: () => boolean, call: () => T): T {
  if (!alive()) throw new Error('identity cache out of time');
  return call();
}

/** The git directories a `.git` entry in `dir` names: itself, or the `gitdir:` of a `.git` file. */
function gitLocationAt(dir: string, isFile: boolean, alive: () => boolean): GitLocation | null {
  const entry = within(alive, () => realpathSync(join(dir, '.git')));
  let gitDir = entry;
  if (isFile) {
    const pointer = /^gitdir: (.+)$/m.exec(readSmallFile(entry, 4096, alive) ?? '');
    if (pointer === null) return null;
    gitDir = within(alive, () => realpathSync(resolve(dir, pointer[1].trim())));
  }
  // Git also reads a symlinked HEAD's link text, which no stamp covers, so such a HEAD is not remembered.
  const head = join(gitDir, 'HEAD');
  if (within(alive, () => lstatSync(head, { throwIfNoEntry: false }))?.isSymbolicLink()) return null;
  const common = readSmallFile(join(gitDir, 'commondir'), 4096, alive);
  const commonDir = common === null ? gitDir : within(alive, () => realpathSync(resolve(gitDir, common.trim())));
  return { entry, entryDir: dir, gitDir, commonDir };
}

/**
 * What git finds in `dir`: a location, a place where it would stop without one we can remember
 * (null), or nothing (undefined). Git checks a symlinked marker's own ownership, so such a marker is
 * not remembered; a `HEAD` of any kind, a dangling link included, may make `dir` a bare repository
 * or a directory inside `.git`.
 */
function discoverAt(dir: string, alive: () => boolean): GitLocation | null | undefined {
  const marker = within(alive, () => lstatSync(join(dir, '.git'), { throwIfNoEntry: false }));
  if (marker?.isFile() || marker?.isDirectory()) return gitLocationAt(dir, marker.isFile(), alive);
  if (marker !== undefined || within(alive, () => lstatSync(join(dir, 'HEAD'), { throwIfNoEntry: false })) !== undefined) return null;
  return undefined;
}

/** The first `.git` above `cwd` on one filesystem, and the git directories it names; never git itself. */
function locateGit(cwd: string, alive: () => boolean): GitLocation | null {
  try {
    const start = within(alive, () => realpathSync(cwd));
    const top = within(alive, () => statSync(start));
    // `git -C` refuses a file, so a file's directory is not its repository.
    if (!top.isDirectory()) return null;
    let dir = start;
    for (;;) {
      const found = discoverAt(dir, alive);
      if (found !== undefined) return found;
      const parent = dirname(dir);
      if (parent === dir || within(alive, () => statSync(parent)).dev !== top.dev) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/** A regular file of at most `limit` bytes, or null when it is absent, special or larger. */
function readSmallFile(path: string, limit: number, alive: () => boolean): string | null {
  const found = within(alive, () => statSync(path, { throwIfNoEntry: false }));
  if (found === undefined || !found.isFile() || found.size > limit) return null;
  return within(alive, () => readFileSync(path, 'utf8'));
}

/** Whether this process may do `mode` on `path`, as `access(2)` says; git asks the same way. */
function allowed(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory git only checks is signed by identity, ownership and whether this process may search
 * it (a group or an ACL can change that alone), because git rewrites `.git` on every status. A file
 * or a directory git lists is signed whole, with whether this process may read it: git skips a
 * global config it cannot read.
 */
function stamp(path: string, whole: boolean, alive: () => boolean): string {
  try {
    const found = within(alive, () => statSync(path, { bigint: true, throwIfNoEntry: false }));
    if (found === undefined) return 'absent';
    const node = [found.dev, found.ino, found.mode, found.uid, found.gid, within(alive, () => allowed(path, constants.X_OK))];
    if (!whole) return node.join(':');
    return [...node, within(alive, () => allowed(path, constants.R_OK)), found.size, found.mtimeNs, found.ctimeNs].join(':');
  } catch {
    return 'unreadable';
  }
}

/**
 * The `git` a spawn would run, found the way `execvp` finds it (the first file this process may
 * execute); no process is started. Null when that search is more than stats of absolute
 * directories: an empty or relative PATH entry (the working directory), a directory that cannot be
 * searched, or Windows' `git.exe`.
 */
function gitExecutable(alive: () => boolean): string | null {
  if (process.platform === 'win32') return null;
  try {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!isAbsolute(dir)) return null;
      const candidate = join(dir, 'git');
      const found = within(alive, () => statSync(candidate, { throwIfNoEntry: false }));
      if (found?.isFile() && within(alive, () => allowed(candidate, constants.X_OK))) return candidate;
    }
  } catch {
    // EACCES or ENOTDIR on a PATH entry (execvp skips it, which a stat cannot tell apart), or out of time.
  }
  return null;
}

/** The global config files, or null when HOME or XDG_CONFIG_HOME is relative: git resolves those from `cwd`. */
function globalConfigs(): string[] | null {
  const home = process.env.HOME ?? homedir();
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return isAbsolute(home) && isAbsolute(xdg) ? [join(xdg, 'git', 'config'), join(home, '.gitconfig')] : null;
}

/** What git reads for a location: directories it checks (`nodes`), and the files and listings it reads (`whole`). */
type Signed = { nodes: string[]; whole: string[] };

function signedPaths(location: GitLocation, root: string, git: string, system: string | null): Signed | null {
  const { entry, entryDir, gitDir, commonDir } = location;
  const globals = globalConfigs();
  return globals === null ? null : {
    nodes: [entryDir, root, gitDir, commonDir, join(commonDir, 'objects'), join(commonDir, 'refs')],
    // The system file comes last: it is only known once `git var` has answered, after the identity.
    whole: [...(entry === gitDir ? [] : [entry]), join(gitDir, 'commondir'), join(gitDir, 'config.worktree'), join(gitDir, 'HEAD'),
      join(commonDir, 'config'), join(commonDir, 'remotes'), join(commonDir, 'remotes', 'origin'),
      join(commonDir, 'branches'), join(commonDir, 'branches', 'origin'), ...globals, git,
      ...(system === null ? [] : [system])],
  };
}

/** The stamps of `signed`, or null once `alive` says the time is up or a path cannot be stamped. */
function stampsOf(signed: Signed | null, alive: () => boolean): string[] | null {
  if (signed === null) return null;
  const stamps = [...signed.nodes.map((path) => stamp(path, false, alive)), ...signed.whole.map((path) => stamp(path, true, alive))];
  return alive() && !stamps.includes('unreadable') ? stamps : null;
}

/** Which files git reads and whether it trusts them: HOME, XDG_CONFIG_HOME, PATH, the user, its groups and SUDO_UID. */
function environmentStamp(): string {
  const { HOME, XDG_CONFIG_HOME, PATH, SUDO_UID } = process.env;
  return sha256Hex(JSON.stringify([HOME ?? '', XDG_CONFIG_HOME ?? '', PATH ?? '', SUDO_UID ?? '',
    process.geteuid?.() ?? '', process.getegid?.() ?? '', process.getgroups?.() ?? []]));
}

function cacheFile(dir: string, location: GitLocation): string {
  return join(dir, `${sha256Hex(JSON.stringify([location.entryDir, location.entry]))}.json`);
}

type CacheEntry = {
  v: number; env: string; git: string; system: string; stamps: string[];
  identity: { kind: RepoIdentity['identityKind']; normalized: string; root: string; worktreeKey: string | null };
  writtenAt: number;
};

function parseEntry(text: string): CacheEntry | null {
  const entry = JSON.parse(text) as Partial<CacheEntry> | null;
  const kept = entry?.identity;
  if (entry?.v !== CACHE_VERSION || typeof entry.env !== 'string' || typeof entry.git !== 'string' || typeof entry.system !== 'string'
    || !Array.isArray(entry.stamps) || !entry.stamps.every((item) => typeof item === 'string')
    || typeof entry.writtenAt !== 'number' || typeof kept !== 'object' || kept === null
    || (kept.kind !== 'remote' && kept.kind !== 'common_dir') || typeof kept.normalized !== 'string' || kept.normalized === ''
    || typeof kept.root !== 'string' || !(kept.worktreeKey === null || typeof kept.worktreeKey === 'string')) return null;
  return entry as CacheEntry;
}

/** The `.git` found for `cwd`, and git's remembered answer for it when every signed input is unchanged. */
type Lookup = { hit: RepoIdentity | null; location: GitLocation | null };

function lookupCached(cwd: string, cache: IdentityCache): Lookup {
  if (!(cache.lookupMs > 0)) return { hit: null, location: null };
  const deadline = performance.now() + cache.lookupMs;
  const alive = (): boolean => performance.now() <= deadline;
  try {
    const location = locateGit(cwd, alive);
    if (location === null) return { hit: null, location };
    const text = readSmallFile(cacheFile(cache.dir, location), CACHE_MAX_BYTES, alive);
    const entry = text === null ? null : parseEntry(text);
    const age = Date.now() - (entry?.writtenAt ?? 0);
    if (entry === null || age < 0 || age > CACHE_MAX_AGE_MS || entry.env !== environmentStamp()
      || entry.git !== gitExecutable(alive)) return { hit: null, location };
    const stamps = stampsOf(signedPaths(location, entry.identity.root, entry.git, entry.system), alive);
    if (stamps === null || stamps.join('\0') !== entry.stamps.join('\0')) return { hit: null, location };
    const { kind, normalized, root, worktreeKey } = entry.identity;
    return { hit: identity(kind, normalized, root, worktreeKey), location };
  } catch {
    return { hit: null, location: null };
  }
}

/** The configuration files git reads, when none of them is special, oversized or includes another. */
function configsWithoutIncludes(location: GitLocation, system: string, alive: () => boolean): boolean {
  for (const path of [join(location.commonDir, 'config'), join(location.gitDir, 'config.worktree'), ...globalConfigs() ?? [], system]) {
    if (within(alive, () => statSync(path, { throwIfNoEntry: false })) === undefined) continue;
    const text = readSmallFile(path, CONFIG_MAX_BYTES, alive);
    if (text === null || INCLUDE_HEADER.test(text)) return false;
  }
  return alive();
}

/** The filesystem half of a write, stamped before git runs so that a change during its calls is seen. */
type Pending = { cache: IdentityCache; location: GitLocation; executable: string; before: string[] };

function prepareRecord(cache: IdentityCache, location: GitLocation, alive: () => boolean): Pending | null {
  try {
    const executable = gitExecutable(alive);
    const before = executable === null ? null : stampsOf(signedPaths(location, location.entryDir, executable, null), alive);
    return executable === null || before === null ? null : { cache, location, executable, before };
  } catch {
    return null;
  }
}

/**
 * Remembers `resolved` only when git's paths are the ones found on the filesystem and every input
 * stamped before the identity's git calls is unchanged after them. Nothing here may fail the caller.
 */
function recordCached(pending: Pending, run: (args: string[]) => GitResult, alive: () => boolean,
  cwd: string, answer: GitAnswer, resolved: RepoIdentity): void {
  try {
    const { cache, location, executable, before } = pending;
    const same = (reported: string, found: string): boolean => within(alive, () => realpathSync(resolve(cwd, reported))) === found;
    if (!answer.complete || !same(answer.top, location.entryDir) || !same(answer.gitDir, location.gitDir)
      || !same(answer.common, location.commonDir)) return;
    // Asked after the identity, so it spends only what the identity left. An edit to the system file
    // between the identity's calls and its stamp here is the one change this write cannot see.
    const system = run(['var', 'GIT_CONFIG_SYSTEM']);
    if (system.status !== 0 || !isAbsolute(system.stdout) || !configsWithoutIncludes(location, system.stdout, alive)) return;
    const after = stampsOf(signedPaths(location, resolved.root, executable, system.stdout), alive);
    if (after === null || after.slice(0, before.length).join('\0') !== before.join('\0')) return;
    const entry: CacheEntry = {
      v: CACHE_VERSION, env: environmentStamp(), git: executable, system: system.stdout, stamps: after,
      identity: { kind: resolved.identityKind, normalized: resolved.normalizedIdentity, root: resolved.root, worktreeKey: resolved.worktreeKey },
      writtenAt: Date.now(),
    };
    const text = JSON.stringify(entry);
    if (Buffer.byteLength(text) > CACHE_MAX_BYTES || !alive()) return;
    within(alive, () => mkdirSync(cache.dir, { recursive: true, mode: 0o700 }));
    const file = cacheFile(cache.dir, location);
    const temporary = `${file}.${randomUUID()}.tmp`;
    within(alive, () => writeFileSync(temporary, text, { mode: 0o600 }));
    // Once written, the rename runs regardless of the time, so no temporary file is left behind.
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
  // The git budget runs from here, so the time a lookup spends is time git does not get.
  const startedAt = performance.now();
  const cache = options?.cache;
  const lookup = cache === undefined ? null : lookupCached(cwd, cache);
  if (lookup !== null && lookup.hit !== null) return lookup.hit;

  const spawn = options?.spawn ?? spawnSync;
  // A hook only lowers the budget; a caller outside a hook raises both by naming a call timeout.
  const budget = options?.callTimeoutMs === undefined
    ? Math.min(GIT_BUDGET_MS, options?.budgetMs ?? GIT_BUDGET_MS) : options?.budgetMs ?? GIT_BUDGET_MS;
  const callTimeout = options?.callTimeoutMs ?? GIT_TIMEOUT_MS;
  const remaining = (): number => Math.floor(budget - (performance.now() - startedAt));
  const run = (args: string[]): GitResult => {
    // The budget bounds the whole identity, so the last call gets whatever is left of it.
    // performance.now() is fractional and spawnSync demands an unsigned integer timeout, so the
    // remainder is floored: a fractional value raises RangeError instead of falling back.
    const left = remaining();
    return left < 1 ? UNANSWERED : git(spawn, cwd, args, Math.min(callTimeout, left));
  };

  // Before the identity's calls only filesystem stamps run, and only from time above what the identity keeps.
  const location = lookup?.location ?? null;
  const pending = cache === undefined || location === null || remaining() < CACHE_WRITE_MIN_BUDGET_MS ? null
    : prepareRecord(cache, location, () => remaining() >= CACHE_WRITE_MIN_BUDGET_MS);
  const answer = askGit(cwd, run);
  const resolved = identityFrom(cwd, answer);
  if (pending !== null) recordCached(pending, run, () => remaining() > 0, cwd, answer, resolved);
  return resolved;
}
