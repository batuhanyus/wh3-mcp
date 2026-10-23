import { constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn as nodeSpawn, execFileSync as nodeExecFileSync } from 'node:child_process';

export const DEFAULT_STEAM_CANDIDATES = Object.freeze([
  'D:\\Program Files (x86)\\Steam\\steamapps\\common\\Total War WARHAMMER III',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Total War WARHAMMER III',
  'D:\\SteamLibrary\\steamapps\\common\\Total War WARHAMMER III',
  'E:\\SteamLibrary\\steamapps\\common\\Total War WARHAMMER III',
]);

function errMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function validateInstallDir(installDir, {
  fsAccess = access,
  fsStat = stat,
} = {}) {
  if (typeof installDir !== 'string' || installDir.trim() === '') {
    return { ok: false, code: 'EMPTY_PATH', path: installDir ?? null };
  }
  const root = resolve(installDir.trim());
  const exe = join(root, 'Warhammer3.exe');
  try {
    const rootStat = await fsStat(root);
    if (!rootStat.isDirectory()) return { ok: false, code: 'NOT_DIRECTORY', path: root, exe };
    const exeStat = await fsStat(exe);
    if (!exeStat.isFile()) return { ok: false, code: 'EXECUTABLE_NOT_FILE', path: root, exe };
    await fsAccess(root, fsConstants.R_OK | fsConstants.W_OK);
    await fsAccess(exe, fsConstants.R_OK);
    return { ok: true, path: root, exe };
  } catch (error) {
    const code = error?.code === 'ENOENT'
      ? 'NOT_FOUND'
      : (error?.code === 'EACCES' || error?.code === 'EPERM')
        ? 'INACCESSIBLE'
        : 'INVALID_PATH';
    return { ok: false, code, path: root, exe, error: errMessage(error) };
  }
}

function readRegistryInstall(execFileSync = nodeExecFileSync) {
  try {
    const output = execFileSync('reg', [
      'query',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 1142710',
      '/v',
      'InstallLocation',
    ], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const match = String(output).match(/InstallLocation\s+REG_SZ\s+(.+)/i);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveWh3Install({
  env = process.env,
  candidates = DEFAULT_STEAM_CANDIDATES,
  platform = process.platform,
  execFileSync = nodeExecFileSync,
  validate = validateInstallDir,
} = {}) {
  const attempts = [];
  const explicit = env.WH3_INSTALL_DIR?.trim() || env.WH3_INSTALL_PATH?.trim();
  if (explicit) {
    const checked = await validate(explicit);
    attempts.push({ source: env.WH3_INSTALL_DIR?.trim() ? 'WH3_INSTALL_DIR' : 'WH3_INSTALL_PATH', ...checked });
    if (checked.ok) return { ...checked, source: attempts[0].source, attempts };
    return {
      ok: false,
      code: 'WH3_PATH_NOT_FOUND',
      error: `configured WH3 install is invalid: ${checked.code}`,
      attempts,
    };
  }

  for (const candidate of candidates) {
    const checked = await validate(candidate);
    attempts.push({ source: 'steam_candidate', ...checked });
    if (checked.ok) return { ...checked, source: 'steam_candidate', attempts };
  }

  if (platform === 'win32') {
    const registryPath = readRegistryInstall(execFileSync);
    if (registryPath) {
      const checked = await validate(registryPath);
      attempts.push({ source: 'registry', ...checked });
      if (checked.ok) return { ...checked, source: 'registry', attempts };
    }
  }

  return {
    ok: false,
    code: 'WH3_PATH_NOT_FOUND',
    error: 'Warhammer 3 install could not be resolved to a readable/writable directory containing Warhammer3.exe',
    attempts,
  };
}

export function resolveBeneathRoot(rootDir, requestedPath, { allowNested = false } = {}) {
  if (!rootDir) throw Object.assign(new Error('approved root is unavailable'), { code: 'WH3_PATH_NOT_FOUND' });
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw Object.assign(new Error('path must be a non-empty string'), { code: 'INVALID_PATH' });
  }
  const raw = requestedPath.trim();
  if (isAbsolute(raw)) throw Object.assign(new Error('absolute paths are not allowed'), { code: 'PATH_OUTSIDE_ROOT' });
  if (!allowNested && /[\\/]/.test(raw)) {
    throw Object.assign(new Error('nested paths are not allowed'), { code: 'PATH_OUTSIDE_ROOT' });
  }
  const root = resolve(rootDir);
  const target = resolve(root, raw);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw Object.assign(new Error('path escapes approved WH3 root'), { code: 'PATH_OUTSIDE_ROOT' });
  }

  // Lexical checks are insufficient when an existing child is a symlink or
  // junction. Compare real paths as well so a friendly-looking filename under
  // the WH3 directory cannot redirect diagnostics/protocol I/O elsewhere.
  if (existsSync(root) && existsSync(target)) {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    const realRel = relative(realRoot, realTarget);
    if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
      throw Object.assign(new Error('path resolves outside approved WH3 root'), { code: 'PATH_OUTSIDE_ROOT' });
    }
  }
  return target;
}

function waitForClose(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exited: true, code: child?.exitCode ?? null, signal: child?.signalCode ?? null });
  }
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.('close', onClose);
      child.off?.('exit', onExit);
      resolveWait(value);
    };
    const onClose = (code, signal) => finish({ exited: true, code, signal });
    const onExit = (code, signal) => finish({ exited: true, code, signal });
    child.once?.('close', onClose);
    child.once?.('exit', onExit);
    const timer = setTimeout(() => finish({ exited: false }), Math.max(0, timeoutMs));
  });
}

export class Wh3ProcessManager {
  constructor({
    install,
    spawn = nodeSpawn,
    externalProcessProbe = () => false,
    startupGraceMs = 1500,
    gracefulStopMs = 10000,
    forceStopMs = 3000,
  }) {
    this.install = install;
    this.spawn = spawn;
    this.externalProcessProbe = externalProcessProbe;
    this.startupGraceMs = startupGraceMs;
    this.gracefulStopMs = gracefulStopMs;
    this.forceStopMs = forceStopMs;
    this.child = null;
    this.ownedPid = null;
    this.runCounter = 0;
    this.runId = null;
    this.lastExit = null;
    this.exitListeners = new Set();
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  _emitExit(info) {
    for (const listener of this.exitListeners) {
      try { listener(info); } catch {}
    }
  }

  isOwnedRunning() {
    return !!(this.child && this.child.pid === this.ownedPid && this.child.exitCode === null && this.child.signalCode === null);
  }

  isRunning() {
    if (this.isOwnedRunning()) return true;
    try { return !!this.externalProcessProbe(); } catch { return false; }
  }

  async start(args = ['--feature', 'disable_intro_videos']) {
    if (!this.install?.ok) {
      return { status: 'path_not_found', code: 'WH3_PATH_NOT_FOUND', error: this.install?.error ?? 'WH3 install is unavailable' };
    }
    if (this.isOwnedRunning()) return { status: 'already_running', owned: true, pid: this.ownedPid, run_id: this.runId };
    if (this.isRunning()) return { status: 'already_running', owned: false, pid: null, run_id: null };

    let child;
    try {
      child = this.spawn(this.install.exe, args, {
        cwd: this.install.path,
        detached: false,
        windowsHide: false,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (error) {
      return { status: 'launch_error', path: this.install.path, exe: this.install.exe, error_code: error?.code ?? null, error: errMessage(error) };
    }

    this.child = child;
    this.ownedPid = child.pid ?? null;
    this.runCounter += 1;
    this.runId = `run-${Date.now()}-${this.runCounter}`;
    const thisRunId = this.runId;

    return new Promise((resolveStart) => {
      let settled = false;
      let spawned = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveStart(value);
      };
      const recordExit = (code, signal) => {
        const info = { run_id: thisRunId, pid: child.pid ?? null, code, signal, at_ms: Date.now() };
        this.lastExit = info;
        if (this.child === child) {
          this.child = null;
          this.ownedPid = null;
        }
        this._emitExit(info);
        if (!settled) finish({ status: 'process_exited', ...info, path: this.install.path, exe: this.install.exe });
      };
      child.once('error', (error) => {
        if (this.child === child) {
          this.child = null;
          this.ownedPid = null;
        }
        finish({
          status: error?.code === 'ENOENT' ? 'executable_not_found' : 'launch_error',
          path: this.install.path,
          exe: this.install.exe,
          pid: child.pid ?? null,
          error_code: error?.code ?? null,
          error: errMessage(error),
        });
      });
      child.once('exit', recordExit);
      child.once('spawn', () => {
        spawned = true;
        timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            finish({ status: 'started', pid: child.pid ?? null, path: this.install.path, exe: this.install.exe, run_id: thisRunId });
          }
        }, this.startupGraceMs);
      });
      // Some fakes and unusual spawn implementations expose pid but do not emit spawn.
      queueMicrotask(() => {
        if (!spawned && child.pid && child.exitCode === null && child.signalCode === null && typeof child.once !== 'function') {
          finish({ status: 'started', pid: child.pid, path: this.install.path, exe: this.install.exe, run_id: thisRunId });
        }
      });
    });
  }

  async stop() {
    if (!this.isOwnedRunning()) {
      if (this.isRunning()) return { status: 'not_owned', stopped: false, error: 'WH3 is running but was not started by this MCP process' };
      return { status: 'not_running', stopped: true };
    }

    const child = this.child;
    const pid = this.ownedPid;
    let termSent = false;
    try { termSent = child.kill('SIGTERM') !== false; } catch (error) {
      return { status: 'stop_error', stopped: false, pid, phase: 'sigterm', error: errMessage(error) };
    }
    const graceful = await waitForClose(child, this.gracefulStopMs);
    if (graceful.exited) return { status: 'stopped', stopped: true, pid, signal_sent: 'SIGTERM', exit_code: graceful.code, signal: graceful.signal };

    let killSent = false;
    try { killSent = child.kill('SIGKILL') !== false; } catch (error) {
      return { status: 'stop_error', stopped: false, pid, phase: 'sigkill', term_sent: termSent, error: errMessage(error) };
    }
    const forced = await waitForClose(child, this.forceStopMs);
    if (forced.exited) return { status: 'force_killed', stopped: true, pid, signal_sent: 'SIGKILL', exit_code: forced.code, signal: forced.signal };
    return {
      status: 'stop_timeout',
      stopped: false,
      pid,
      term_sent: termSent,
      kill_sent: killSent,
      error: `owned WH3 process did not exit within ${this.gracefulStopMs + this.forceStopMs}ms`,
    };
  }

  getStatus() {
    return {
      running: this.isRunning(),
      owned: this.isOwnedRunning(),
      pid: this.isOwnedRunning() ? this.ownedPid : null,
      run_id: this.runId,
      last_exit: this.lastExit,
      path: this.install?.ok ? this.install.path : null,
      exe: this.install?.ok ? this.install.exe : null,
      path_error: this.install?.ok ? null : { code: this.install?.code ?? 'WH3_PATH_NOT_FOUND', error: this.install?.error ?? null },
    };
  }
}
