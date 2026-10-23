import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
    this.rootDir = rootDir;
    this.commandFile = commandFile;
    this.resultFile = resultFile;
    this.quarantineDir = quarantineDir;
    this.sessionId = sessionId;
    this.sessionStartedAtMs = Date.now();
    this.pollIntervalMs = pollIntervalMs;
    this.defaultQueueTimeoutMs = defaultQueueTimeoutMs;
    this.isGameRunning = isGameRunning;

    this.requestCounter = 0;
    this.ready = false;
    this.luaInstance = null;
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

  async _executeRequest(command, params, timeoutMs) {
    const requestId = this._nextRequestId();
    let request;
    try {
      request = makeRequest({
        sessionId: this.sessionId,
        requestId,
        command,
        params,
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
      if (!this.isGameRunning()) {
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
      return reply;
    }
    this.ready = false;
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

      if (!this.ready) {
        const handshake = await this._handshake(Math.min(timeoutMs, 10000));
        if (handshake.status !== 'ok') return handshake;
      }

      let reply = await this._executeRequest(command, params, timeoutMs);
      if (reply.status === 'error' && reply.error?.code === 'NOT_READY') {
        this.ready = false;
        const handshake = await this._handshake(Math.min(timeoutMs, 10000));
        if (handshake.status !== 'ok') return handshake;
        reply = await this._executeRequest(command, params, timeoutMs);
      }
      if (reply.status === 'error' && ['CONTEXT_CHANGED', 'PROTOCOL_MISMATCH'].includes(reply.error?.code)) {
        this.ready = false;
      }
      return reply;
    } finally {
      release();
    }
  }

  async reset({ quarantine = true } = {}) {
    const release = await this._acquire(this.defaultQueueTimeoutMs);
    try {
      this.ready = false;
      this.luaInstance = null;
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
      lua_instance: this.luaInstance,
      command_file: this.commandFile,
      result_file: this.resultFile,
      queue_depth: this.waiters.filter((w) => w.active).length,
      in_flight: this.locked,
      exclusive_lease: this.leaseOwner !== null,
      lease_waiters: this.leaseWaiters.filter((w) => w.active).length,
    };
  }
}
