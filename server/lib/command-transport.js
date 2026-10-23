import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  assertReplyMatchesRequest,
  makeErrorReply,
  makeRequest,
  parseJsonEnvelope,
  validateReplyEnvelope,
} from './protocol-v2.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TRANSITION_DESTINATIONS = Object.freeze({
  start_campaign: 'campaign',
  load_campaign: 'campaign',
  continue_campaign: 'campaign',
  confirm_load: 'campaign',
  quit_to_menu: 'main_menu',
  exit_to_windows: 'game_exited',
});

function asMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class CommandTransport {
  constructor({
    rootDir,
    commandFile = join(rootDir, 'wh3_mcp_command.json'),
    resultFile = join(rootDir, 'wh3_mcp_result.json'),
    quarantineDir = join(rootDir, '.wh3-mcp-quarantine'),
    sessionId = `server-${Date.now()}-${randomUUID()}`,
    pollIntervalMs = 25,
    defaultQueueTimeoutMs = 15000,
    isGameRunning = () => true,
  }) {
    if (!rootDir) throw new TypeError('rootDir is required');
    const canonicalRoot = resolve(rootDir);
    const realRoot = existsSync(canonicalRoot) ? realpathSync(canonicalRoot) : canonicalRoot;
    const assertInside = (candidate, label) => {
      const canonical = resolve(candidate);
      const rel = relative(canonicalRoot, canonical);
      if (rel === '' && label !== 'rootDir') throw new TypeError(`${label} must be a file/directory beneath rootDir`);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new TypeError(`${label} must resolve beneath rootDir`);
      if (existsSync(canonical)) {
        const realCandidate = realpathSync(canonical);
        const realRel = relative(realRoot, realCandidate);
        if (realRel === '' && label !== 'rootDir') throw new TypeError(`${label} must be a file/directory beneath rootDir`);
        if (realRel.startsWith('..') || isAbsolute(realRel)) throw new TypeError(`${label} resolves outside rootDir`);
      }
      return canonical;
    };
    this.rootDir = canonicalRoot;
    this.commandFile = assertInside(commandFile, 'commandFile');
    this.resultFile = assertInside(resultFile, 'resultFile');
    this.quarantineDir = assertInside(quarantineDir, 'quarantineDir');
    this.sessionId = sessionId;
    this.sessionStartedAtMs = Date.now();
    this.pollIntervalMs = pollIntervalMs;
    this.defaultQueueTimeoutMs = defaultQueueTimeoutMs;
    this.isGameRunning = isGameRunning;

    this.requestCounter = 0;
    this.ready = false;
    this.luaInstance = null;
    this.context = null;
    this.state = 'RECONNECTING';
    this.activeTransition = null;
    this.lastTransition = null;
    this.initialized = false;
    this.locked = false;
    this.waiters = [];

    this.leaseStorage = new AsyncLocalStorage();
    this.leaseOwner = null;
    this.leaseWaiters = [];
  }

  _nextRequestId() {
    this.requestCounter += 1;
    return this.requestCounter;
  }

  _error(requestId, code, message, details = undefined) {
    return makeErrorReply({
      sessionId: this.sessionId,
      requestId,
      code,
      message,
      details,
    });
  }

  async _acquire(queueTimeoutMs) {
    if (!this.locked) {
      this.locked = true;
      return () => this._release();
    }

    return new Promise((resolve, reject) => {
      const waiter = { active: true, timer: null, resolve };
      waiter.timer = setTimeout(() => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('QUEUE_TIMEOUT'));
      }, Math.max(0, queueTimeoutMs));
      this.waiters.push(waiter);
    });
  }

  _release() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter.active) continue;
      waiter.active = false;
      clearTimeout(waiter.timer);
      waiter.resolve(() => this._release());
      return;
    }
    this.locked = false;
  }

  async _waitForSessionLease(timeoutMs, command = null) {
    const token = this.leaseStorage.getStore();
    if (!this.leaseOwner || this.leaseOwner.token === token ||
        (command && this.leaseOwner.allowCommands.has(command))) return true;

    return new Promise((resolve, reject) => {
      const waiter = { active: true, timer: null, resolve };
      waiter.timer = setTimeout(() => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = this.leaseWaiters.indexOf(waiter);
        if (index >= 0) this.leaseWaiters.splice(index, 1);
        reject(new Error('SESSION_LEASE_TIMEOUT'));
      }, Math.max(0, timeoutMs));
      this.leaseWaiters.push(waiter);
    });
  }

  _releaseSessionLease() {
    this.leaseOwner = null;
    while (this.leaseWaiters.length > 0) {
      const waiter = this.leaseWaiters.shift();
      if (!waiter.active) continue;
      waiter.active = false;
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  async withExclusiveLease(fn, { timeoutMs = this.defaultQueueTimeoutMs, allowCommands = [] } = {}) {
    const existing = this.leaseStorage.getStore();
    if (existing && this.leaseOwner?.token === existing) return fn();

    const token = `lease-${randomUUID()}`;
    const deadline = Date.now() + timeoutMs;
    while (this.leaseOwner) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('SESSION_LEASE_TIMEOUT');
      await this._waitForSessionLease(remaining);
    }
    this.leaseOwner = { token, allowCommands: new Set(allowCommands) };
    try {
      return await this.leaseStorage.run(token, fn);
    } finally {
      if (this.leaseOwner?.token === token) this._releaseSessionLease();
    }
  }

  async _pathExists(path) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async _quarantine(path, reason) {
    if (!(await this._pathExists(path))) return null;
    await mkdir(this.quarantineDir, { recursive: true });
    const target = join(
      this.quarantineDir,
      `${basename(path)}.${reason}.${Date.now()}.${randomUUID()}`,
    );
    try {
      await rename(path, target);
      return target;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async _initialize() {
    if (this.initialized) return;
    await mkdir(this.rootDir, { recursive: true });
    await this._quarantine(this.commandFile, 'startup-leftover');
    await this._quarantine(this.resultFile, 'startup-leftover');
    this.initialized = true;
  }

  async _atomicPublish(path, contents, identity) {
    const temp = join(
      this.rootDir,
      `.${basename(path)}.tmp-${this.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}-${identity}-${randomUUID()}`,
    );
    let handle;
    try {
      handle = await open(temp, 'wx');
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;

      try {
        await rename(temp, path);
      } catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
        await this._quarantine(path, 'publish-target-existed');
        await rename(temp, path);
      }
    } catch (error) {
      try { await handle?.close(); } catch {}
      try { await unlink(temp); } catch {}
      throw error;
    }
  }

  async _readCandidate(activeRequest) {
    if (!(await this._pathExists(this.resultFile))) return { kind: 'none' };

    let raw;
    try {
      raw = await readFile(this.resultFile, 'utf8');
    } catch (error) {
      return { kind: 'io', error };
    }

    let reply;
    try {
      reply = parseJsonEnvelope(raw, validateReplyEnvelope, 'response');
    } catch (error) {
      try { await this._quarantine(this.resultFile, 'invalid-response'); } catch {}
      return { kind: 'invalid', error };
    }

    try {
      assertReplyMatchesRequest(reply, activeRequest);
    } catch (error) {
      if (error instanceof ProtocolValidationError && error.code === 'STALE_RESPONSE') {
        try { await this._quarantine(this.resultFile, 'stale-response'); } catch {}
        return { kind: 'stale', error };
      }
      try { await this._quarantine(this.resultFile, 'protocol-mismatch'); } catch {}
      return { kind: 'invalid', error };
    }

    try {
      await unlink(this.resultFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { kind: 'io', error };
    }
    return { kind: 'match', reply };
  }

  async _executeRequest(command, params, timeoutMs, { transitionId = undefined, transitionDestination = undefined } = {}) {
    const requestId = this._nextRequestId();
    let request;
    try {
      request = makeRequest({
        sessionId: this.sessionId,
        requestId,
        command,
        params,
        transitionId,
        transitionDestination,
      });
    } catch (error) {
      return this._error(requestId, error.code ?? 'INVALID_REQUEST', asMessage(error), error.details);
    }

    try {
      // A late reply or unconsumed timed-out command can never be allowed to
      // participate in this request. Preserve it for diagnostics instead.
      await this._quarantine(this.resultFile, 'pre-request-leftover');
      await this._quarantine(this.commandFile, 'pre-request-leftover');
      await this._atomicPublish(this.commandFile, JSON.stringify(request), requestId);
    } catch (error) {
      return this._error(requestId, 'IO_FAILURE', 'failed to publish command atomically', {
        phase: 'publish',
        cause: asMessage(error),
      });
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === 'GAME_EXITED' || !this.isGameRunning()) {
        this.ready = false;
        this.state = 'GAME_EXITED';
        return this._error(requestId, 'GAME_EXITED', 'WH3 exited while the command was in flight', {
          outcome: 'unknown',
        });
      }

      const candidate = await this._readCandidate(request);
      if (candidate.kind === 'match') return candidate.reply;
      if (candidate.kind === 'invalid') {
        const code = candidate.error?.code === 'PROTOCOL_MISMATCH' ? 'PROTOCOL_MISMATCH' : 'INVALID_RESPONSE';
        return this._error(requestId, code, asMessage(candidate.error), candidate.error?.details);
      }
      if (candidate.kind === 'io') {
        return this._error(requestId, 'IO_FAILURE', 'failed while reading result file', {
          phase: 'read',
          cause: asMessage(candidate.error),
        });
      }
      // stale replies are quarantined and ignored; only the active identity can win.
      await sleep(this.pollIntervalMs);
    }

    try { await this._quarantine(this.commandFile, 'command-timeout'); } catch {}
    return this._error(requestId, 'COMMAND_TIMEOUT', `no matching response within ${timeoutMs}ms`, {
      phase: 'execution',
      timeout_ms: timeoutMs,
      outcome: 'unknown',
    });
  }

  async _handshake(timeoutMs) {
    const reply = await this._executeRequest('__handshake', {
      server_protocol: PROTOCOL_VERSION,
      server_started_at_ms: this.sessionStartedAtMs,
    }, timeoutMs);
    if (reply.status === 'ok' && reply.result?.ready === true) {
      this.ready = true;
      this.luaInstance = reply.result?.instance ?? null;
      this.context = reply.result?.context ?? null;
      this.state = this.activeTransition?.state === 'TRANSITIONING' ? 'TRANSITIONING' : 'READY';
      if (this.activeTransition && ['RECONNECTING', 'FAILED'].includes(this.activeTransition.state)) {
        const expected = this.activeTransition.destination;
        const matches = expected === 'main_menu'
          ? ['main_menu', 'frontend'].includes(this.context)
          : expected === this.context;
        this.activeTransition.reconnected_context = this.context;
        this.activeTransition.recovered = matches;
        this.activeTransition.state = matches ? 'READY' : 'FAILED';
        if (!matches) this.activeTransition.outcome = this.activeTransition.outcome ?? 'unknown';
        this.lastTransition = { ...this.activeTransition };
        this.activeTransition = null;
        if (!matches) {
          this.state = 'FAILED';
          return this._error(reply.request_id, 'CONTEXT_CHANGED', 'reconnected Lua context does not match the pending transition destination', {
            expected_context: expected,
            actual_context: this.context,
            outcome: 'unknown',
            never_replayed: true,
          });
        }
      }
      return reply;
    }
    this.ready = false;
    if (reply.error?.code === 'GAME_EXITED') this.state = 'GAME_EXITED';
    else this.state = 'FAILED';
    return reply;
  }

  async send(command, params = {}, timeoutMs = 60000, options = {}) {
    const queueTimeoutMs = options.queueTimeoutMs ?? Math.min(timeoutMs, this.defaultQueueTimeoutMs);
    try {
      await this._waitForSessionLease(queueTimeoutMs, command);
    } catch (error) {
      const requestId = this._nextRequestId();
      return this._error(requestId, 'COMMAND_TIMEOUT', `session lease wait exceeded ${queueTimeoutMs}ms`, {
        phase: 'session_lease',
        timeout_ms: queueTimeoutMs,
        command,
        never_executed: true,
      });
    }

    let release;
    try {
      release = await this._acquire(queueTimeoutMs);
    } catch (error) {
      const requestId = this._nextRequestId();
      return this._error(requestId, 'COMMAND_TIMEOUT', `command queue wait exceeded ${queueTimeoutMs}ms`, {
        phase: 'queue',
        timeout_ms: queueTimeoutMs,
        command,
        never_executed: true,
      });
    }

    try {
      try {
        await this._initialize();
      } catch (error) {
        const requestId = this._nextRequestId();
        return this._error(requestId, 'IO_FAILURE', 'transport initialisation failed', { cause: asMessage(error) });
      }

      if (!this.isGameRunning()) {
        const requestId = this._nextRequestId();
        this.ready = false;
        this.state = 'GAME_EXITED';
        return this._error(requestId, 'GAME_EXITED', 'WH3 is not running', { never_executed: true, outcome: 'not_executed' });
      }

      if (!this.ready || this.state === 'RECONNECTING' || this.state === 'FAILED') {
        const handshake = await this._handshake(Math.min(timeoutMs, 10000));
        if (handshake.status !== 'ok') return handshake;
      }

      const destination = TRANSITION_DESTINATIONS[command] ?? null;
      const transitionId = destination ? `transition-${randomUUID()}` : undefined;
      if (destination) {
        this.state = 'TRANSITIONING';
        this.activeTransition = {
          transition_id: transitionId,
          command,
          destination,
          state: 'TRANSITIONING',
          started_at_ms: Date.now(),
        };
      }

      let reply = await this._executeRequest(command, params, timeoutMs, {
        transitionId,
        transitionDestination: destination ?? undefined,
      });
      if (reply.status === 'error' && reply.error?.code === 'NOT_READY') {
        // Protocol v2 defines NOT_READY as a pre-dispatch rejection. Re-handshake
        // is therefore safe; timed-out/accepted mutations are never replayed.
        this.ready = false;
        this.state = 'RECONNECTING';
        const handshake = await this._handshake(Math.min(timeoutMs, 10000));
        if (handshake.status !== 'ok') return handshake;
        reply = await this._executeRequest(command, params, timeoutMs, {
          transitionId,
          transitionDestination: destination ?? undefined,
        });
      }

      if (destination) {
        const record = this.activeTransition ?? { transition_id: transitionId, command, destination };
        record.finished_at_ms = Date.now();
        if (reply.status === 'error') {
          reply.error.details = {
            ...(reply.error.details ?? {}),
            transition_id: transitionId,
            destination,
            outcome: reply.error.details?.outcome ?? 'unknown',
          };
        }
        if (reply.status === 'ok') {
          record.state = destination === 'game_exited' ? 'TRANSITIONING' : 'RECONNECTING';
          record.outcome = 'completed';
          this.state = destination === 'game_exited' ? 'TRANSITIONING' : 'RECONNECTING';
          this.ready = false;
        } else {
          record.state = reply.error?.code === 'GAME_EXITED' ? 'GAME_EXITED' : 'FAILED';
          record.outcome = reply.error?.details?.outcome ?? 'unknown';
          this.state = record.state;
          this.ready = false;
        }
        this.activeTransition = record;
        this.lastTransition = { ...record };
      } else if (reply.status === 'error' && ['CONTEXT_CHANGED', 'PROTOCOL_MISMATCH', 'GAME_EXITED'].includes(reply.error?.code)) {
        this.ready = false;
        this.state = reply.error?.code === 'GAME_EXITED' ? 'GAME_EXITED' : 'RECONNECTING';
      }
      return reply;
    } finally {
      release();
    }
  }


  beginManagedTransition(command, destination) {
    if (this.activeTransition?.state === 'TRANSITIONING') {
      const error = new Error('another context transition is already active');
      error.code = 'TRANSITION_IN_PROGRESS';
      throw error;
    }
    const transitionId = `transition-${randomUUID()}`;
    this.activeTransition = {
      transition_id: transitionId,
      command,
      destination,
      state: 'TRANSITIONING',
      started_at_ms: Date.now(),
      managed: true,
    };
    this.lastTransition = { ...this.activeTransition };
    this.state = 'TRANSITIONING';
    return transitionId;
  }

  completeManagedTransition({ context = this.context, outcome = 'completed', details = undefined } = {}) {
    if (!this.activeTransition) return null;
    const record = {
      ...this.activeTransition,
      state: 'READY',
      outcome,
      completed_context: context,
      finished_at_ms: Date.now(),
    };
    if (details !== undefined) record.details = details;
    this.lastTransition = record;
    this.activeTransition = null;
    this.state = 'READY';
    return record;
  }

  failManagedTransition({ outcome = 'unknown', details = undefined } = {}) {
    if (!this.activeTransition) return null;
    const record = {
      ...this.activeTransition,
      state: 'FAILED',
      outcome,
      finished_at_ms: Date.now(),
    };
    if (details !== undefined) record.details = details;
    this.lastTransition = record;
    this.activeTransition = null;
    this.state = 'FAILED';
    this.ready = false;
    return record;
  }

  markGameExited(info = null) {
    this.ready = false;
    this.state = 'GAME_EXITED';
    this.luaInstance = null;
    this.context = null;
    if (this.activeTransition) {
      this.activeTransition.state = 'GAME_EXITED';
      this.activeTransition.outcome = this.activeTransition.outcome ?? 'unknown';
      this.activeTransition.game_exit = info;
      this.lastTransition = { ...this.activeTransition };
    }
  }

  async reset({ quarantine = true } = {}) {
    const release = await this._acquire(this.defaultQueueTimeoutMs);
    try {
      this.ready = false;
      this.luaInstance = null;
      this.context = null;
      this.state = this.isGameRunning() ? 'RECONNECTING' : 'GAME_EXITED';
      this.activeTransition = null;
      if (quarantine) {
        try { await this._quarantine(this.commandFile, 'reset'); } catch {}
        try { await this._quarantine(this.resultFile, 'reset'); } catch {}
      }
    } finally {
      release();
    }
  }

  getStatus() {
    return {
      protocol: PROTOCOL_VERSION,
      session_id: this.sessionId,
      next_request_id: this.requestCounter + 1,
      ready: this.ready,
      state: this.state,
      lua_instance: this.luaInstance,
      context: this.context,
      active_transition: this.activeTransition,
      last_transition: this.lastTransition,
      command_file: this.commandFile,
      result_file: this.resultFile,
      queue_depth: this.waiters.filter((w) => w.active).length,
      in_flight: this.locked,
      exclusive_lease: this.leaseOwner !== null,
      lease_waiters: this.leaseWaiters.filter((w) => w.active).length,
    };
  }
}
