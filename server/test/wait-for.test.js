import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWaitForArgs, waitForConditions, WAIT_LIMITS } from '../lib/wait-for.js';

function fakeClock() {
  let time = 1000;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
    advance: (ms) => { time += ms; },
  };
}

function ok(session, result) {
  return { protocol: 2, session_id: session, request_id: 1, status: 'ok', result };
}

function identity(session = 's1', running = true, runId = 'r1') {
  return { running, session_id: session, run_id: runId };
}

test('already-true state returns on the first fresh observation', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await waitForConditions({ conditions: [{ type: 'context', equals: 'campaign' }] }, {
    now: clock.now,
    sleep: clock.sleep,
    getIdentity: () => identity(),
    sendCommand: async (command) => {
      calls += 1;
      assert.equal(command, 'get_situation');
      return ok('s1', { context: 'campaign', blocking: [], saving: false });
    },
  });
  assert.equal(result.result.outcome, 'matched');
  assert.equal(result.result.observations, 1);
  assert.equal(calls, 1);
});

test('state becoming true after several polls succeeds and timeline records changes only', async () => {
  const clock = fakeClock();
  let poll = 0;
  const result = await waitForConditions({
    conditions: [{ type: 'turn', equals: 3 }],
    poll_interval_ms: 100,
    timeout_ms: 1000,
  }, {
    now: clock.now,
    sleep: clock.sleep,
    getIdentity: () => identity(),
    sendCommand: async () => {
      poll += 1;
      return ok('s1', { context: 'campaign', turn: Math.min(3, poll), blocking: [], saving: false });
    },
  });
  assert.equal(result.result.outcome, 'matched');
  assert.equal(result.result.observations, 3);
  assert.equal(result.result.timeline.length, 3);
});

test('timeout includes the final valid observation and unmet conditions', async () => {
  const clock = fakeClock();
  const result = await waitForConditions({
    conditions: [{ type: 'saving', equals: false }, { type: 'blocking.kind', equals: 'pre_battle' }],
    poll_interval_ms: 100,
    timeout_ms: 250,
    max_observations: 10,
  }, {
    now: clock.now,
    sleep: clock.sleep,
    getIdentity: () => identity(),
    sendCommand: async () => ok('s1', { context: 'campaign', blocking: [], saving: false }),
  });
  assert.equal(result.result.outcome, 'timed_out');
  assert.ok(result.result.final_observation);
  assert.deepEqual(result.result.unmet_conditions, ['2:blocking.kind']);
});

test('cancellation is distinct and does not continue polling', async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let calls = 0;
  const result = await waitForConditions({
    conditions: [{ type: 'turn', equals: 9 }],
    poll_interval_ms: 100,
    timeout_ms: 2000,
  }, {
    now: clock.now,
    getIdentity: () => identity(),
    signal: controller.signal,
    sleep: async (ms) => {
      clock.advance(ms);
      controller.abort();
    },
    sendCommand: async () => {
      calls += 1;
      return ok('s1', { context: 'campaign', turn: 1, blocking: [], saving: false });
    },
  });
  assert.equal(result.result.outcome, 'cancelled');
  assert.equal(calls, 1);
});

test('process death and session replacement are distinct outcomes', async () => {
  const clock = fakeClock();
  let running = true;
  let session = 's1';
  const death = await waitForConditions({ conditions: [{ type: 'turn', equals: 2 }], poll_interval_ms: 100 }, {
    now: clock.now,
    getIdentity: () => identity(session, running),
    sleep: async (ms) => { clock.advance(ms); running = false; },
    sendCommand: async () => ok('s1', { context: 'campaign', turn: 1, blocking: [], saving: false }),
  });
  assert.equal(death.result.outcome, 'process_exited');

  const clock2 = fakeClock();
  session = 's1';
  let first = true;
  const changed = await waitForConditions({ conditions: [{ type: 'turn', equals: 2 }], poll_interval_ms: 100 }, {
    now: clock2.now,
    getIdentity: () => identity(session, true),
    sleep: async (ms) => { clock2.advance(ms); session = 's2'; },
    sendCommand: async () => {
      if (first) first = false;
      return ok('s1', { context: 'campaign', turn: 1, blocking: [], saving: false });
    },
  });
  assert.equal(changed.result.outcome, 'session_changed');
});

test('all mode requires transient conditions to be true in the same observation', async () => {
  const clock = fakeClock();
  const states = [
    { context: 'campaign', saving: true },
    { context: 'frontend', saving: false },
    { context: 'campaign', saving: false },
  ];
  let index = 0;
  const result = await waitForConditions({
    conditions: [{ type: 'context', equals: 'campaign' }, { type: 'saving', equals: false }],
    poll_interval_ms: 100,
    timeout_ms: 1000,
  }, {
    now: clock.now,
    sleep: clock.sleep,
    getIdentity: () => identity(),
    sendCommand: async () => ok('s1', { ...states[Math.min(index++, states.length - 1)], blocking: [] }),
  });
  assert.equal(result.result.outcome, 'matched');
  assert.equal(result.result.observations, 3);
});

test('UI conditions share one inspection per selector and distinguish unavailable UI', async () => {
  const clock = fakeClock();
  let inspectCalls = 0;
  const result = await waitForConditions({
    conditions: [
      { type: 'ui.exists', component_id: 'wat_harness_launcher', equals: true },
      { type: 'ui.visible', component_id: 'wat_harness_launcher', equals: true },
      { type: 'ui.parent_id', component_id: 'wat_harness_launcher', equals: 'button_group_settlement' },
    ],
  }, {
    now: clock.now,
    sleep: clock.sleep,
    getIdentity: () => identity(),
    sendCommand: async (command) => {
      if (command === 'get_situation') return ok('s1', { context: 'campaign', blocking: [], saving: false });
      inspectCalls += 1;
      return ok('s1', { found: true, component_id: 'wat_harness_launcher', visible: true, parent_id: 'button_group_settlement', errors: [] });
    },
  });
  assert.equal(result.result.outcome, 'matched');
  assert.equal(inspectCalls, 1);

  const unavailable = await waitForConditions({ conditions: [{ type: 'ui.exists', component_id: 'x' }] }, {
    now: clock.now,
    sleep: clock.sleep,
    getIdentity: () => identity(),
    sendCommand: async (command) => command === 'get_situation'
      ? ok('s1', { context: 'frontend', blocking: [], saving: false })
      : ok('s1', { found: false, component_id: 'x', errors: [{ code: 'NO_UI_ROOT' }] }),
  });
  assert.equal(unavailable.result.outcome, 'ui_unavailable');
});

test('unsupported conditions are reported without sending commands', async () => {
  let called = false;
  const result = await waitForConditions({ conditions: [{ type: 'lua.expression', equals: 'anything' }] }, {
    getIdentity: () => identity(),
    sendCommand: async () => { called = true; return null; },
  });
  assert.equal(result.result.outcome, 'unsupported_condition');
  assert.equal(called, false);
});

test('normalization clamps finite wait bounds and rejects malformed requests', () => {
  const args = normalizeWaitForArgs({
    conditions: [{ type: 'context', equals: 'campaign' }],
    timeout_ms: 999999,
    poll_interval_ms: 1,
    max_observations: 999999,
  });
  assert.equal(args.timeout_ms, WAIT_LIMITS.maxTimeoutMs);
  assert.equal(args.poll_interval_ms, WAIT_LIMITS.minPollIntervalMs);
  assert.equal(args.max_observations, WAIT_LIMITS.maxObservations);
  assert.throws(() => normalizeWaitForArgs({ conditions: [] }), /conditions/);
  assert.throws(() => normalizeWaitForArgs({ conditions: [{ type: 'ui.visible' }] }), /component_id/);
});

test('any mode succeeds when one typed condition matches', async () => {
  const clock = fakeClock();
  const result = await waitForConditions({
    mode: 'any',
    conditions: [
      { type: 'context', equals: 'battle' },
      { type: 'saving', equals: false },
    ],
  }, {
    now: clock.now,
    sleep: clock.sleep,
    getIdentity: () => identity(),
    sendCommand: async () => ok('s1', { context: 'campaign', saving: false, blocking: [] }),
  });
  assert.equal(result.result.outcome, 'matched');
  assert.equal(result.result.observations, 1);
  assert.deepEqual(result.result.unmet_conditions, []);
});

test('concurrent waits use only the injected transport path and can safely interleave through its serializer', async () => {
  const clock = fakeClock();
  let active = 0;
  let maxActive = 0;
  let tail = Promise.resolve();
  const sendCommand = (command) => {
    const run = tail.then(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (command === 'get_situation') return ok('s1', { context: 'campaign', turn: 1, saving: false, blocking: [] });
      throw new Error(`unexpected command ${command}`);
    });
    tail = run.catch(() => {});
    return run;
  };

  const options = { now: clock.now, sleep: clock.sleep, getIdentity: () => identity(), sendCommand };
  const [a, b] = await Promise.all([
    waitForConditions({ conditions: [{ type: 'context', equals: 'campaign' }] }, options),
    waitForConditions({ conditions: [{ type: 'saving', equals: false }] }, options),
  ]);
  assert.equal(a.result.outcome, 'matched');
  assert.equal(b.result.outcome, 'matched');
  assert.equal(maxActive, 1);
});

test('transport failures are surfaced distinctly instead of being mistaken for timeout', async () => {
  const result = await waitForConditions({ conditions: [{ type: 'context', equals: 'campaign' }] }, {
    getIdentity: () => identity(),
    sendCommand: async () => ({
      protocol: 2,
      session_id: 's1',
      request_id: 7,
      status: 'error',
      error: { code: 'COMMAND_TIMEOUT', message: 'no matching response' },
    }),
  });
  assert.equal(result.result.outcome, 'transport_error');
  assert.equal(result.result.transport_error.code, 'COMMAND_TIMEOUT');
});
