import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveRepoIdentity, type GitSpawn, type IdentityCache, type RepoIdentity } from '../../src/repo-identity.js';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = gitAvailable ? false : 'git is not installed, so the repository identity tests cannot run.';

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'oboete-repo-'));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function newRepository(): string {
  const root = join(temporaryRoot(), 'work');
  mkdirSync(root);
  git(root, 'init', '--quiet', '--initial-branch', 'main');
  return root;
}

function repositoryWithRemote(url: string): string {
  const root = newRepository();
  git(root, 'remote', 'add', 'origin', url);
  return root;
}

function sha256Prefix(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

test('a credential in the remote URL never reaches the identity', { skip }, () => {
  const root = repositoryWithRemote('https://user:s3cr3tpass@github.com/Owner/Repo.git?x=1#frag');
  const identity = resolveRepoIdentity(root);
  assert.equal(identity.identityKind, 'remote');
  assert.equal(identity.normalizedIdentity, 'github.com/Owner/Repo');
  assert.equal(identity.root, realpathSync(root));
  const serialized = JSON.stringify(identity);
  assert.equal(serialized.includes('s3cr3tpass'), false);
  assert.equal(serialized.includes('user:'), false);
});

test('the scp-like remote form is normalized', { skip }, () => {
  const identity = resolveRepoIdentity(repositoryWithRemote('git@github.com:owner/repo.git'));
  assert.equal(identity.identityKind, 'remote');
  assert.equal(identity.normalizedIdentity, 'github.com/owner/repo');
});

test('a non-default port is kept and the host is lower-cased', { skip }, () => {
  const identity = resolveRepoIdentity(repositoryWithRemote('ssh://git@Host:2222/a/b.git'));
  assert.equal(identity.normalizedIdentity, 'host:2222/a/b');
  assert.equal(
    resolveRepoIdentity(repositoryWithRemote('ssh://git@Host:22/a/b.git/')).normalizedIdentity,
    'host/a/b',
  );
});

test('origin wins over another remote that is listed first', { skip }, () => {
  const root = newRepository();
  git(root, 'remote', 'add', 'alt', 'https://alt.example.com/alt/mirror.git');
  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/canonical.git');
  assert.equal(git(root, 'remote').split('\n')[0], 'alt');
  assert.equal(resolveRepoIdentity(root).normalizedIdentity, 'github.com/owner/canonical');
});

test('the only remote is used when there is no origin', { skip }, () => {
  const root = newRepository();
  git(root, 'remote', 'add', 'upstream', 'https://github.com/owner/only.git');
  assert.equal(resolveRepoIdentity(root).normalizedIdentity, 'github.com/owner/only');
});

test('a repository without a remote is identified by the real path of its git common directory', { skip }, () => {
  const base = temporaryRoot();
  const root = join(base, 'real');
  mkdirSync(root);
  git(root, 'init', '--quiet', '--initial-branch', 'main');

  const identity = resolveRepoIdentity(root);
  assert.equal(identity.identityKind, 'common_dir');
  assert.equal(identity.normalizedIdentity, realpathSync(join(root, '.git')));

  symlinkSync(root, join(base, 'link'), 'dir');
  assert.equal(resolveRepoIdentity(join(base, 'link')).id, identity.id);
});

test('a linked worktree resolves to the identity of the main worktree', { skip }, () => {
  const root = newRepository();
  writeFileSync(join(root, 'file.txt'), 'content\n');
  git(root, 'add', 'file.txt');
  git(root, '-c', 'user.name=oboete test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'first');

  const linked = join(temporaryRoot(), 'linked');
  git(root, 'worktree', 'add', '--quiet', linked);

  const main = resolveRepoIdentity(root);
  const other = resolveRepoIdentity(linked);
  assert.equal(main.identityKind, 'common_dir');
  assert.equal(other.id, main.id);
  assert.equal(other.normalizedIdentity, main.normalizedIdentity);
  assert.equal(other.root, realpathSync(linked));
});

test('a directory outside any repository is identified by its own real path', () => {
  const root = temporaryRoot();
  const identity = resolveRepoIdentity(root);
  assert.equal(identity.identityKind, 'common_dir');
  assert.equal(identity.normalizedIdentity, realpathSync(root));
  assert.equal(identity.root, root);
});

test('the id is the first 16 hex characters of the sha256 of the normalized identity', { skip }, () => {
  const identity = resolveRepoIdentity(repositoryWithRemote('https://github.com/Owner/Repo.git'));
  assert.equal(identity.normalizedIdentity, 'github.com/Owner/Repo');
  assert.match(identity.id, /^[0-9a-f]{16}$/);
  assert.equal(identity.id, sha256Prefix('github.com/Owner/Repo'));

  const plain = resolveRepoIdentity(temporaryRoot());
  assert.match(plain.id, /^[0-9a-f]{16}$/);
  assert.equal(plain.id, sha256Prefix(plain.normalizedIdentity));
});

test('git repository variables in the environment cannot redirect the identity', { skip }, () => {
  const victim = newRepository();
  const attacker = repositoryWithRemote('https://github.com/attacker/other.git');
  const expected = resolveRepoIdentity(victim);
  assert.equal(expected.identityKind, 'common_dir');

  const names = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'];
  const previous = names.map((name) => [name, process.env[name]] as const);
  process.env.GIT_DIR = join(attacker, '.git');
  process.env.GIT_COMMON_DIR = join(attacker, '.git');
  process.env.GIT_WORK_TREE = attacker;
  try {
    assert.deepEqual(resolveRepoIdentity(victim), expected);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a Windows drive path remote is a local path, not a host called c', { skip }, () => {
  const identity = resolveRepoIdentity(repositoryWithRemote('C:\\path\\repo'));
  // R8 normalizes a remote to `host/path`; a drive letter is neither a host nor a user@host form.
  assert.equal(identity.identityKind, 'common_dir');
  assert.equal(identity.normalizedIdentity.startsWith('c/'), false);
});

test('a repository with an origin costs at most two git calls', { skip }, () => {
  const root = repositoryWithRemote('https://github.com/owner/counted.git');
  const calls: string[][] = [];
  const identity = resolveRepoIdentity(root, {
    spawn: (file, args, options) => {
      calls.push(args);
      return spawnSync(file, args, options);
    },
  });
  assert.equal(identity.normalizedIdentity, 'github.com/owner/counted');
  // FR-002: the hook has 300 ms in total, so the identity may not spend four processes on it.
  assert.ok(calls.length <= 2, `git ran ${calls.length} times: ${JSON.stringify(calls)}`);
});

test('a slow git leaves the next call an unsigned integer timeout', () => {
  const timeouts: unknown[] = [];
  const canned = (stdout: string): SpawnSyncReturns<string> => ({
    pid: 0,
    output: [null, stdout, ''],
    stdout,
    stderr: '',
    status: 0,
    signal: null,
  });
  const identity = resolveRepoIdentity('/somewhere/work', {
    spawn: (_file, args, options) => {
      timeouts.push(options.timeout);
      if (timeouts.length === 1) {
        // Burn most of the git budget, so the next call is offered the fraction that is left.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 140);
        return canned('/somewhere/work\n/somewhere/work/.git');
      }
      return canned(args.includes('get-url') ? 'https://github.com/owner/slow.git' : '');
    },
  });
  assert.equal(timeouts.length, 2);
  // spawnSync rejects a fractional timeout with RangeError, which would lose the fallback that the
  // budget exists for (FR-002).
  for (const timeout of timeouts) {
    assert.ok(
      typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1,
      `git was given the timeout ${String(timeout)}`,
    );
  }
  assert.equal(identity.normalizedIdentity, 'github.com/owner/slow');
});

// ---------------------------------------------------------------------------
// #340: git's complete answers are remembered, so a starved git cannot split a repository
// ---------------------------------------------------------------------------

/** Runs `fn` with HOME and XDG_CONFIG_HOME in a temporary directory, so the global git config is the test's. */
function withGitHome<T>(fn: (home: string) => T): T {
  const home = temporaryRoot();
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  try {
    return fn(home);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Runs `fn` with `vars` set in the environment, then restores them. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const unanswered = (): SpawnSyncReturns<string> => ({
  pid: 0, output: [], stdout: '', stderr: '', status: null, signal: 'SIGTERM', error: new Error('git timed out'),
});

/** A git that must not be asked: the lookup alone has to answer. */
const forbidden: GitSpawn = (_file, args) => { throw new Error(`git was asked: ${args.join(' ')}`); };

function counting(): { spawn: GitSpawn; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, spawn: (file, args, options) => { calls.push(args.slice(2)); return spawnSync(file, args, options); } };
}

function cacheOf(home: string): IdentityCache {
  return { dir: join(home, 'identity-cache'), lookupMs: 60 };
}

function entries(cache: IdentityCache): string[] {
  try {
    return readdirSync(cache.dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

/** Resolves once with the real git so the cache holds an entry; returns that identity. */
function warm(root: string, cache: IdentityCache): RepoIdentity {
  const identity = resolveRepoIdentity(root, { cache });
  assert.equal(entries(cache).length, 1, 'a complete answer is remembered');
  return identity;
}

test('#340: a warm entry answers a starved lookup exactly as git did', { skip }, () => withGitHome((home) => {
  for (const root of [newRepository(), repositoryWithRemote('https://github.com/owner/warm.git')]) {
    const cache = cacheOf(temporaryRoot());
    const expected = warm(root, cache);
    const starved = resolveRepoIdentity(root, { spawn: forbidden, budgetMs: 0, cache });
    assert.deepEqual(starved, expected);
    assert.notEqual(starved.worktreeKey, null);
  }
  // Without the cache the same starved call gives the identity git never returned.
  const root = newRepository();
  const expected = warm(root, cacheOf(home));
  assert.notEqual(resolveRepoIdentity(root, { spawn: () => unanswered(), budgetMs: 0 }).normalizedIdentity,
    expected.normalizedIdentity);
}));

test('#340: an entry warmed at the root is read from a subdirectory', { skip }, () => withGitHome((home) => {
  const cache = cacheOf(home);
  const root = newRepository();
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  const expected = warm(root, cache);
  assert.deepEqual(resolveRepoIdentity(join(root, 'src', 'deep'), { spawn: forbidden, budgetMs: 0, cache }), expected);
}));

test('#340: a change git would see makes the next lookup ask git again', { skip }, () => withGitHome((home) => {
  const committed = (): string => {
    const root = newRepository();
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'first');
    return root;
  };
  const changes: [string, () => string, (root: string) => void][] = [
    ['remote set-url', () => repositoryWithRemote('https://github.com/owner/a.git'), (root) => git(root, 'remote', 'set-url', 'origin', 'https://github.com/owner/b.git')],
    ['remote add', newRepository, (root) => git(root, 'remote', 'add', 'origin', 'https://github.com/owner/c.git')],
    ['remote remove', () => repositoryWithRemote('https://github.com/owner/d.git'), (root) => git(root, 'remote', 'remove', 'origin')],
    ['core.worktree', newRepository, (root) => git(root, 'config', 'core.worktree', root)],
    ['same-length edit with mtime restored', () => {
      const root = repositoryWithRemote('https://github.com/owner/e.git');
      // A whole-second mtime can be restored exactly, so only ctime tells the edit apart.
      utimesSync(join(root, '.git', 'config'), 1_700_000_000, 1_700_000_000);
      return root;
    }, (root) => {
      const config = join(root, '.git', 'config');
      writeFileSync(config, readFileSync(config, 'utf8').replace('owner/e.git', 'owner/f.git'));
      utimesSync(config, 1_700_000_000, 1_700_000_000);
    }],
    ['global insteadOf', () => repositoryWithRemote('gh:owner/g.git'), () => writeFileSync(join(home, '.gitconfig'), '[url "https://github.com/"]\n\tinsteadOf = gh:\n')],
    ['legacy remotes file', newRepository, (root) => { mkdirSync(join(root, '.git', 'remotes'), { recursive: true }); writeFileSync(join(root, '.git', 'remotes', 'origin'), 'URL: https://github.com/owner/h.git\n'); }],
    ['branch switch', committed, (root) => git(root, 'checkout', '--quiet', '-b', 'other')],
    ['HEAD rewritten in place', newRepository, (root) => writeFileSync(join(root, '.git', 'HEAD'), 'not a ref\n')],
    ['objects chmod', newRepository, (root) => chmodSync(join(root, '.git', 'objects'), 0o700)],
    ['repository recreated at the same path', newRepository, (root) => { rmSync(join(root, '.git'), { recursive: true, force: true }); git(root, 'init', '--quiet'); }],
  ];
  for (const [name, create, change] of changes) {
    const cache = cacheOf(temporaryRoot());
    const root = create();
    warm(root, cache);
    change(root);
    const { spawn, calls } = counting();
    resolveRepoIdentity(root, { spawn, cache });
    assert.ok(calls.length > 0, `${name}: git was not asked again`);
    rmSync(join(home, '.gitconfig'), { force: true });
  }
}));

test('#340: a different git on PATH and an old entry are misses', { skip }, () => withGitHome((home) => {
  const cache = cacheOf(home);
  const root = newRepository();
  warm(root, cache);
  const file = join(cache.dir, entries(cache)[0]);
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...entry, writtenAt: Date.now() - 25 * 60 * 60 * 1000 }));
  assert.notDeepEqual(resolveRepoIdentity(root, { spawn: () => unanswered(), budgetMs: 0, cache }).normalizedIdentity, entry.identity.normalized);

  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const script = `#!/bin/sh\nexec ${real} "$@"\n`;
  const earlier = temporaryRoot();
  const wrapper = temporaryRoot();
  writeFileSync(join(wrapper, 'git'), script, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${earlier}:${wrapper}:${previous ?? ''}`;
  try {
    const fresh = cacheOf(temporaryRoot());
    warm(root, fresh);
    // The same PATH now finds another git first: nothing already signed changed.
    writeFileSync(join(earlier, 'git'), script, { mode: 0o755 });
    assert.throws(() => resolveRepoIdentity(root, { spawn: forbidden, budgetMs: 1_000, cache: fresh }), /git was asked/);
    rmSync(join(earlier, 'git'));
    warm(root, cacheOf(temporaryRoot()));
    const replaced = cacheOf(temporaryRoot());
    warm(root, replaced);
    writeFileSync(join(wrapper, 'git.new'), script, { mode: 0o755 });
    renameSync(join(wrapper, 'git.new'), join(wrapper, 'git'));
    assert.throws(() => resolveRepoIdentity(root, { spawn: forbidden, budgetMs: 1_000, cache: replaced }), /git was asked/);
  } finally {
    process.env.PATH = previous;
  }
}));

test('#340: only a complete, unchanged, include-free answer is remembered', { skip }, () => withGitHome((home) => {
  const refuse = (name: string, root: string, spawn: GitSpawn): void => {
    const cache = cacheOf(temporaryRoot());
    resolveRepoIdentity(root, { spawn, cache });
    assert.deepEqual(entries(cache), [], `${name}: an entry was written`);
  };
  const failing = (match: string): GitSpawn => (file, args, options) =>
    args.slice(2).join(' ') === match ? unanswered() : spawnSync(file, args, options);
  refuse('rev-parse timed out', newRepository(), failing('rev-parse --show-toplevel --git-common-dir --absolute-git-dir'));
  refuse('get-url origin timed out', repositoryWithRemote('https://github.com/owner/i.git'), failing('remote get-url origin'));
  refuse('git var did not answer', newRepository(), failing('var GIT_CONFIG_SYSTEM'));
  const upstream = newRepository();
  git(upstream, 'remote', 'add', 'upstream', 'https://github.com/owner/j.git');
  refuse('the fallback remote timed out', upstream, failing('remote get-url upstream'));
  const included = newRepository();
  writeFileSync(join(included, '.git', 'config'), `${readFileSync(join(included, '.git', 'config'), 'utf8')}[include]\n\tpath = extra\n`);
  refuse('an include', included, spawnSync);
  const bare = newRepository();
  git(bare, 'config', 'core.bare', 'true');
  refuse('rev-parse exited non-zero', bare, spawnSync);
  const raced = repositoryWithRemote('https://github.com/owner/k.git');
  refuse('a remote changed during the lookup', raced, (file, args, options) => {
    const result = spawnSync(file, args, options);
    if (args.slice(2).join(' ') === 'remote get-url origin') git(raced, 'remote', 'set-url', 'origin', 'https://github.com/owner/l.git');
    return result;
  });
  refuse('no .git', temporaryRoot(), spawnSync);
  // A fallback remote is used, never recorded: its legacy files are not signed.
  const fallback = newRepository();
  git(fallback, 'remote', 'add', 'upstream', 'https://github.com/owner/m.git');
  refuse('a fallback remote', fallback, spawnSync);
  const exited = (match: string, status: number): GitSpawn => (file, args, options) => args.slice(2).join(' ') === match
    ? { pid: 0, output: [], stdout: '', stderr: '', status, signal: null } : spawnSync(file, args, options);
  refuse('get-url origin failed other than exit 2', newRepository(), exited('remote get-url origin', 128));
  refuse('the remote listing timed out', newRepository(), failing('remote'));
  const header = (text: string): string => {
    const root = newRepository();
    writeFileSync(join(root, '.git', 'config'), `${text}${readFileSync(join(root, '.git', 'config'), 'utf8')}`);
    return root;
  };
  refuse('an include after a BOM', header('\uFEFF[include]\n\tpath = extra\n'), spawnSync);
  refuse('an include beside another header', header('[user][include]\n\tpath = extra\n'), spawnSync);
  const unsearchable = temporaryRoot();
  mkdirSync(join(unsearchable, 'locked'));
  chmodSync(join(unsearchable, 'locked'), 0o000);
  for (const [name, entry] of [['an empty PATH entry', ''], ['a relative PATH entry', 'bin'], ['an unsearchable PATH entry', join(unsearchable, 'locked', 'bin')]]) {
    withEnv({ PATH: `${entry}:${process.env.PATH ?? ''}` }, () => {
      const root = newRepository();
      assert.deepEqual(resolveRepoIdentity(root), resolveRepoIdentity(root, { cache: cacheOf(temporaryRoot()) }), name);
      refuse(name, root, spawnSync);
    });
  }
  chmodSync(join(unsearchable, 'locked'), 0o700);
  void home;
}));

test('#340: the identity asks git first, and the cache only spends what it leaves', { skip }, () => withGitHome(() => {
  const root = repositoryWithRemote('https://github.com/owner/n.git');
  const { spawn, calls } = counting();
  resolveRepoIdentity(root, { spawn, cache: cacheOf(temporaryRoot()) });
  assert.deepEqual(calls.map((call) => call.join(' ')),
    ['rev-parse --show-toplevel --git-common-dir --absolute-git-dir', 'remote get-url origin', 'var GIT_CONFIG_SYSTEM']);
  // An identity that uses up the budget still stands, and nothing is recorded without time to check it.
  const cache = cacheOf(temporaryRoot());
  const slow: GitSpawn = (file, args, options) => {
    const result = spawnSync(file, args, options);
    if (args.slice(2).join(' ') === 'remote get-url origin') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    return result;
  };
  assert.equal(resolveRepoIdentity(root, { spawn: slow, budgetMs: 1_000, callTimeoutMs: 1_000, cache }).identityKind, 'remote');
  assert.equal(entries(cache).length, 1, 'with time left the answer is recorded');
  const starved = cacheOf(temporaryRoot());
  assert.equal(resolveRepoIdentity(root, { spawn: slow, budgetMs: 250, callTimeoutMs: 120, cache: starved }).identityKind, 'remote');
  assert.deepEqual(entries(starved), []);
}));

test('#340: git activity that does not change the answer keeps the entry', { skip }, () => withGitHome(() => {
  const cache = cacheOf(temporaryRoot());
  const root = newRepository();
  writeFileSync(join(root, 'tracked'), 'a\n');
  git(root, 'add', 'tracked');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'first');
  const expected = warm(root, cache);
  writeFileSync(join(root, 'tracked'), 'b\n');
  git(root, 'status', '--short');
  writeFileSync(join(root, 'new-top-level-file'), '');
  assert.deepEqual(resolveRepoIdentity(root, { spawn: forbidden, budgetMs: 0, cache }), expected);
}));

test('#340: an environment git reads differently is a miss', { skip }, () => withGitHome((home) => {
  const root = newRepository();
  for (const [name, change] of [
    ['PATH', { PATH: `${process.env.PATH ?? ''}:${join(home, 'later')}` }],
    ['HOME', { HOME: temporaryRoot() }],
    ['SUDO_UID', { SUDO_UID: '12345' }],
  ] as const) {
    const cache = cacheOf(temporaryRoot());
    warm(root, cache);
    withEnv(change, () => {
      const { spawn, calls } = counting();
      resolveRepoIdentity(root, { spawn, cache });
      assert.ok(calls.length > 0, `${name}: git was not asked again`);
    });
  }
}));

test('#340: a directory where git would stop first is never answered from a parent entry', { skip }, () => withGitHome(() => {
  const cache = cacheOf(temporaryRoot());
  const root = newRepository();
  warm(root, cache);
  mkdirSync(join(root, 'nested'));
  git(join(root, 'nested'), 'init', '--quiet', '--bare', 'bare.git');
  for (const inside of [join(root, '.git'), join(root, '.git', 'objects'), join(root, 'nested', 'bare.git')]) {
    const { spawn, calls } = counting();
    resolveRepoIdentity(inside, { spawn, budgetMs: 1_000, cache });
    assert.ok(calls.length > 0, `${inside}: answered from the parent's entry`);
  }
}));

test('#340: a broken or unwritable cache never changes the identity git gives', { skip }, () => withGitHome((home) => {
  const root = repositoryWithRemote('https://user:s3cr3tpass@github.com/owner/m.git?q=1#f');
  const expected = resolveRepoIdentity(root);
  const cache = cacheOf(home);
  assert.deepEqual(warm(root, cache), expected);
  const file = join(cache.dir, entries(cache)[0]);
  const text = readFileSync(file, 'utf8');
  for (const leak of ['s3cr3tpass', 'user:', 'q=1', '#f']) assert.equal(text.includes(leak), false, `the entry holds ${leak}`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const broken of [text.slice(0, 20), 'x'.repeat(9 * 1024)]) {
    writeFileSync(file, broken);
    assert.deepEqual(resolveRepoIdentity(root, { cache }), expected);
  }
  const blocked = join(temporaryRoot(), 'file');
  writeFileSync(blocked, '');
  assert.deepEqual(resolveRepoIdentity(root, { cache: { dir: join(blocked, 'cache'), lookupMs: 60 } }), expected);
  // A lookup with no time left is skipped rather than started.
  assert.deepEqual(resolveRepoIdentity(root, { spawn: () => unanswered(), budgetMs: 0, cache: { ...cache, lookupMs: 0 } }).identityKind, 'common_dir');
  // A lookup that outlives its bound (1 ns) stops as a miss instead of finishing the signature.
  assert.deepEqual(resolveRepoIdentity(root, { spawn: () => unanswered(), budgetMs: 0, cache: { ...cache, lookupMs: 1e-6 } }).identityKind, 'common_dir');
  assert.deepEqual(resolveRepoIdentity(root, { spawn: forbidden, budgetMs: 0, cache }), expected, 'the entry itself is still good');
}));
