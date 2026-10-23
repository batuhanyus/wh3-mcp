import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandTransport } from '../lib/command-transport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function okReply(req, result = {}) {
  return {
    protocol: 2,
    session_id: req.session_id,
    request_id: req.request_id,
    status: 'ok',
    result,
  };
}

async function atomicResult(root, value) {
  const result = join(root, 'wh3_mcp_result.json');
  const temp = join(root, `.fake-result-${Date.now()}-${Math.random()}`);
  await writeFile(temp, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  try { await unlink(result); } catch {}
  await rename(temp, result);
}

function startFakeGame(root, handler = async (req) => okReply(req, { echo: req.command })) {
  const commandFile = join(root, 'wh3_mcp_command.json');
  let stopped = false;
  let active = 0;
  let maxActive = 0;
  const seen = [];
  const loop = (async () => {
    while (!stopped) {
      let raw;
      try {
        raw = await readFile(commandFile, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          await sleep(2);
          continue;
        }
        throw error;
      }
      try { await unlink(commandFile); } catch {}
      const req = JSON.parse(raw);
      seen.push(req);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const reply = await handler(req, { root, seen, publish: (value) => atomicResult(root, value) });
        if (reply !== undefined && reply !== null) await atomicResult(root, reply);
      } finally {
        active -= 1;
      }
    }
  })();
  return {
    seen,
    get maxActive() { return maxActive; },
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wh3-mcp-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('concurrent callers are serialized and every command has correlated identity', async () => withTemp(async (root) => {
  const game = startFakeGame(root, async (req) => {
    await sleep(req.command === 'slow' ? 40 : 5);
    return okReply(req, req.command === '__handshake' ? { ready: true, instance: 'fake', context: 'frontend' } : { command: req.command });
  });
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const [a, b] = await Promise.all([
    transport.send('slow', {}, 500),
    transport.send('fast', {}, 500),
  ]);
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.equal(game.maxActive, 1);
  assert.deepEqual(game.seen.map((r) => r.command), ['__handshake', 'slow', 'fast']);
  assert.deepEqual(game.seen.map((r) => r.request_id), [1, 2, 3]);
  await game.stop();
}));

test('stale reverse-order result is quarantined and cannot satisfy active request', async () => withTemp(async (root) => {
  const game = startFakeGame(root, async (req, ctx) => {
    if (req.command === '__handshake') return okReply(req, { ready: true, instance: 'fake', context: 'frontend' });
    await ctx.publish({ protocol: 2, session_id: req.session_id, request_id: req.request_id - 1, status: 'ok', result: { stale: true } });
    await sleep(15);
    return okReply(req, { fresh: true });
  });
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const reply = await transport.send('fresh', {}, 500);
  assert.equal(reply.status, 'ok');
  assert.equal(reply.result.fresh, true);
  await game.stop();
}));

test('malformed reply fails as INVALID_RESPONSE instead of being guessed', async () => withTemp(async (root) => {
  const game = startFakeGame(root, async (req) => {
    if (req.command === '__handshake') return okReply(req, { ready: true, instance: 'fake', context: 'frontend' });
    return '{broken';
  });
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const reply = await transport.send('bad', {}, 500);
  assert.equal(reply.status, 'error');
  assert.equal(reply.error.code, 'INVALID_RESPONSE');
  await game.stop();
}));

test('execution timeout includes session/request identity and a later call is not poisoned', async () => withTemp(async (root) => {
  let drop = true;
  const game = startFakeGame(root, async (req) => {
    if (req.command === '__handshake') return okReply(req, { ready: true, instance: 'fake', context: 'frontend' });
    if (drop) { drop = false; return null; }
    return okReply(req, { recovered: true });
  });
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const timed = await transport.send('drop', {}, 40);
  assert.equal(timed.error.code, 'COMMAND_TIMEOUT');
  assert.equal(timed.error.details.phase, 'execution');
  assert.equal(typeof timed.session_id, 'string');
  assert.equal(Number.isInteger(timed.request_id), true);
  const recovered = await transport.send('recover', {}, 300);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.result.recovered, true);
  await game.stop();
}));

test('queue timeout is removed from the queue and never executes later', async () => withTemp(async (root) => {
  const game = startFakeGame(root, async (req) => {
    if (req.command === '__handshake') return okReply(req, { ready: true, instance: 'fake', context: 'frontend' });
    if (req.command === 'hold') await sleep(80);
    return okReply(req, { command: req.command });
  });
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const first = transport.send('hold', {}, 500);
  await sleep(15);
  const second = await transport.send('must_not_run', {}, 500, { queueTimeoutMs: 20 });
  assert.equal(second.error.code, 'COMMAND_TIMEOUT');
  assert.equal(second.error.details.phase, 'queue');
  assert.equal(second.error.details.never_executed, true);
  await first;
  await sleep(30);
  assert.equal(game.seen.some((r) => r.command === 'must_not_run'), false);
  await game.stop();
}));

test('late post-timeout result is quarantined before the next request', async () => withTemp(async (root) => {
  const game = startFakeGame(root, async (req, ctx) => {
    if (req.command === '__handshake') return okReply(req, { ready: true, instance: 'fake', context: 'frontend' });
    if (req.command === 'late') {
      await sleep(70);
      return okReply(req, { late: true });
    }
    return okReply(req, { next: true });
  });
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const timed = await transport.send('late', {}, 20);
  assert.equal(timed.error.code, 'COMMAND_TIMEOUT');
  await sleep(80);
  const next = await transport.send('next', {}, 300);
  assert.equal(next.status, 'ok');
  assert.equal(next.result.next, true);
  await game.stop();
}));

test('protocol mismatch is visible and never silently falls back to v1', async () => withTemp(async (root) => {
  const game = startFakeGame(root, async (req) => ({
    ...okReply(req, { ready: true, instance: 'fake', context: 'frontend' }),
    protocol: 1,
  }));
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const reply = await transport.send('ping', {}, 200);
  assert.equal(reply.error.code, 'PROTOCOL_MISMATCH');
  await game.stop();
}));

test('startup leftovers are not consumed as handshake or command results', async () => withTemp(async (root) => {
  await writeFile(join(root, 'wh3_mcp_command.json'), JSON.stringify({ command: 'old-v1' }), 'utf8');
  await writeFile(join(root, 'wh3_mcp_result.json'), JSON.stringify({ status: 'ok', result: { old: true } }), 'utf8');
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  await transport._initialize();
  const game = startFakeGame(root, async (req) => okReply(req,
    req.command === '__handshake'
      ? { ready: true, instance: 'fake', context: 'frontend' }
      : { current: true }));
  const reply = await transport.send('current', {}, 300);
  assert.equal(reply.status, 'ok');
  assert.equal(reply.result.current, true);
  assert.equal(game.seen.some((r) => r.command === 'old-v1'), false);
  await game.stop();
}));

test('publish/rename failure is returned as IO_FAILURE', async () => withTemp(async (root) => {
  const transport = new CommandTransport({
    rootDir: root,
    commandFile: join(root, 'missing-parent', 'wh3_mcp_command.json'),
    pollIntervalMs: 2,
  });
  const reply = await transport.send('ping', {}, 100);
  assert.equal(reply.status, 'error');
  assert.equal(reply.error.code, 'IO_FAILURE');
}));

test('exclusive session lease prevents unrelated commands from interleaving, with explicit allow-list support', async () => withTemp(async (root) => {
  const game = startFakeGame(root, async (req) => {
    if (req.command === '__handshake') return okReply(req, { ready: true, instance: 'fake', context: 'frontend' });
    if (req.command === 'lease_a') await sleep(20);
    return okReply(req, { command: req.command });
  });
  const transport = new CommandTransport({ rootDir: root, pollIntervalMs: 2, defaultQueueTimeoutMs: 200 });

  const held = transport.withExclusiveLease(async () => {
    await transport.send('lease_a', {}, 300);
    await sleep(30);
    await transport.send('lease_b', {}, 300);
  }, { allowCommands: ['lease_status'] });

  await sleep(10);
  const allowed = await transport.send('lease_status', {}, 300);
  assert.equal(allowed.status, 'ok');

  const unrelated = transport.send('outside', {}, 300);
  await held;
  const outsideReply = await unrelated;
  assert.equal(outsideReply.status, 'ok');

  const order = game.seen.map((r) => r.command);
  assert.deepEqual(order, ['__handshake', 'lease_a', 'lease_status', 'lease_b', 'outside']);
  await game.stop();
}));

test('a restarted server uses a new session and cannot consume the previous session identity', async () => withTemp(async (root) => {
  const game = startFakeGame(root, async (req) => okReply(req,
    req.command === '__handshake'
      ? { ready: true, instance: 'fake', context: 'frontend' }
      : { session: req.session_id }));

  const first = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const firstReply = await first.send('first', {}, 300);
  assert.equal(firstReply.status, 'ok');

  const second = new CommandTransport({ rootDir: root, pollIntervalMs: 2 });
  const secondReply = await second.send('second', {}, 300);
  assert.equal(secondReply.status, 'ok');
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(secondReply.session_id, second.sessionId);

  const handshakes = game.seen.filter((r) => r.command === '__handshake');
  assert.equal(handshakes.length, 2);
  assert.notEqual(handshakes[0].session_id, handshakes[1].session_id);
  await game.stop();
}));
