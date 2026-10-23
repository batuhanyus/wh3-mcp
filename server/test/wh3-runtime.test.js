import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveBeneathRoot,
  resolveWh3Install,
  validateInstallDir,
  Wh3ProcessManager,
} from '../lib/wh3-runtime.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wh3-runtime-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function makeInstall(root) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'Warhammer3.exe'), 'stub');
  return root;
}

class FakeChild extends EventEmitter {
  constructor(pid = 1234) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
    this.killHandler = null;
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.killHandler) return this.killHandler(signal);
    return true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

test('WH3_INSTALL_DIR has priority and invalid explicit paths never fall through to guessed candidates', async () => withTemp(async (root) => {
  const explicit = await makeInstall(join(root, 'explicit'));
  const fallback = await makeInstall(join(root, 'fallback'));
  const found = await resolveWh3Install({
    env: { WH3_INSTALL_DIR: explicit },
    candidates: [fallback],
    platform: 'linux',
  });
  assert.equal(found.ok, true);
  assert.equal(found.path, explicit);
  assert.equal(found.source, 'WH3_INSTALL_DIR');

  const invalid = await resolveWh3Install({
    env: { WH3_INSTALL_DIR: join(root, 'missing') },
    candidates: [fallback],
    platform: 'linux',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'WH3_PATH_NOT_FOUND');
  assert.equal(invalid.attempts.length, 1);
}));

test('install validation distinguishes missing executable and inaccessible directory', async () => withTemp(async (root) => {
  await mkdir(join(root, 'no-exe'));
  const missing = await validateInstallDir(join(root, 'no-exe'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_FOUND');

  const install = await makeInstall(join(root, 'blocked'));
  const inaccessible = await validateInstallDir(install, {
    fsAccess: async () => {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  assert.equal(inaccessible.ok, false);
  assert.equal(inaccessible.code, 'INACCESSIBLE');
}));

test('filesystem boundary rejects traversal, alternate roots and absolute paths', async () => withTemp(async (root) => {
  assert.equal(resolveBeneathRoot(root, 'wh3_mcp_result.json'), join(root, 'wh3_mcp_result.json'));
  assert.throws(() => resolveBeneathRoot(root, '../outside.log'), /nested paths|escapes/);
  assert.throws(() => resolveBeneathRoot(root, join(root, 'absolute.log')), /absolute paths/);
  assert.throws(() => resolveBeneathRoot(root, 'nested/file.log'), /nested paths/);
}));

test('filesystem boundary rejects existing symlink escapes when the platform permits symlinks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wh3-runtime-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'wh3-runtime-outside-'));
  try {
    const target = join(outside, 'secret.log');
    await writeFile(target, 'outside');
    try {
      await symlink(target, join(root, 'escape.log'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
        t.skip(`symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => resolveBeneathRoot(root, 'escape.log'), /outside approved WH3 root/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('start uses ignored stdio, reports spawn error and catches early exit', async () => withTemp(async (root) => {
  const installPath = await makeInstall(join(root, 'game'));
  const install = { ok: true, path: installPath, exe: join(installPath, 'Warhammer3.exe') };
  let spawnOptions;
  const child = new FakeChild(41);
  const manager = new Wh3ProcessManager({
    install,
    startupGraceMs: 15,
    spawn: (_exe, _args, options) => {
      spawnOptions = options;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const started = await manager.start();
  assert.equal(started.status, 'started');
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'ignore']);

  const errorChild = new FakeChild(42);
  const errorManager = new Wh3ProcessManager({
    install,
    spawn: () => {
      queueMicrotask(() => {
        const error = new Error('boom');
        error.code = 'EACCES';
        errorChild.emit('error', error);
      });
      return errorChild;
    },
  });
  const launchError = await errorManager.start();
  assert.equal(launchError.status, 'launch_error');

  const earlyChild = new FakeChild(43);
  const earlyManager = new Wh3ProcessManager({
    install,
    startupGraceMs: 30,
    spawn: () => {
      queueMicrotask(() => {
        earlyChild.emit('spawn');
        setTimeout(() => earlyChild.exit(7, null), 5);
      });
      return earlyChild;
    },
  });
  const early = await earlyManager.start();
  assert.equal(early.status, 'process_exited');
  assert.equal(early.code, 7);
}));

test('already-running external process is never adopted or killed', async () => withTemp(async (root) => {
  const installPath = await makeInstall(join(root, 'game'));
  const install = { ok: true, path: installPath, exe: join(installPath, 'Warhammer3.exe') };
  let spawned = false;
  const manager = new Wh3ProcessManager({
    install,
    externalProcessProbe: () => true,
    spawn: () => { spawned = true; throw new Error('must not spawn'); },
  });
  const start = await manager.start();
  assert.equal(start.status, 'already_running');
  assert.equal(start.owned, false);
  assert.equal(spawned, false);
  const stop = await manager.stop();
  assert.equal(stop.status, 'not_owned');
  assert.equal(stop.stopped, false);
}));

test('stop is asynchronous, escalates to SIGKILL, and reports timeout without false success', async () => withTemp(async (root) => {
  const installPath = await makeInstall(join(root, 'game'));
  const install = { ok: true, path: installPath, exe: join(installPath, 'Warhammer3.exe') };
  const child = new FakeChild(51);
  child.killHandler = (signal) => {
    if (signal === 'SIGKILL') setTimeout(() => child.exit(null, 'SIGKILL'), 5);
    return true;
  };
  const manager = new Wh3ProcessManager({
    install,
    startupGraceMs: 1,
    gracefulStopMs: 20,
    forceStopMs: 30,
    spawn: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  await manager.start();
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 5);
  const stopped = await manager.stop();
  assert.equal(timerFired, true, 'event loop must remain responsive during shutdown');
  assert.equal(stopped.status, 'force_killed');
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);

  const stuck = new FakeChild(52);
  const stuckManager = new Wh3ProcessManager({
    install,
    startupGraceMs: 1,
    gracefulStopMs: 5,
    forceStopMs: 5,
    spawn: () => {
      queueMicrotask(() => stuck.emit('spawn'));
      return stuck;
    },
  });
  await stuckManager.start();
  const timed = await stuckManager.stop();
  assert.equal(timed.status, 'stop_timeout');
  assert.equal(timed.stopped, false);
}));

test('owned process can stop gracefully without escalation', async () => withTemp(async (root) => {
  const installPath = await makeInstall(join(root, 'game'));
  const install = { ok: true, path: installPath, exe: join(installPath, 'Warhammer3.exe') };
  const child = new FakeChild(61);
  child.killHandler = (signal) => {
    if (signal === 'SIGTERM') setTimeout(() => child.exit(0, 'SIGTERM'), 5);
    return true;
  };
  const manager = new Wh3ProcessManager({
    install,
    startupGraceMs: 1,
    gracefulStopMs: 30,
    forceStopMs: 10,
    spawn: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  await manager.start();
  const stopped = await manager.stop();
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(child.kills, ['SIGTERM']);
}));
