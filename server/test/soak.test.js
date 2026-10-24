import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSoakArgs, runSoak } from '../lib/soak.js';

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

test('zero and out-of-bound turns are rejected instead of silently clamped', () => {
  assert.throws(() => normalizeSoakArgs({ turns: 0 }), (error) => error.code === 'INVALID_TURNS');
  assert.throws(() => normalizeSoakArgs({ turns: 201 }), (error) => error.code === 'INVALID_TURNS');
});

test('conservative defaults stop battle automation and consequential actions need named permissions', () => {
  const defaults = normalizeSoakArgs({ turns: 2 });
  assert.equal(defaults.battle_policy, 'stop');
  assert.equal(defaults.dilemma_choice, null);
  assert.equal(defaults.occupation, null);
  assert.equal(defaults.confirm_dialogs, false);
  assert.throws(() => normalizeSoakArgs({ battle_policy: 'autoresolve' }), /permission/);
  assert.throws(() => normalizeSoakArgs({ occupation: 'occupy' }), /permission/);
  assert.throws(() => normalizeSoakArgs({ dilemma_choice: 1 }), /permission/);
  const permitted = normalizeSoakArgs({
    battle_policy: 'retreat', occupation: 'occupy', dilemma_choice: 2,
    confirm_dialogs: true, dismiss_events: true,
    permissions: ['battle', 'occupation', 'dilemma', 'confirm_dialogs', 'dismiss_events'],
  });
  assert.equal(permitted.battle_policy, 'retreat');
});

test('completed soak reports only confirmed status returned by the game', async () => {
  const c = clock();
  let polls = 0;
  const result = await runSoak({ turns: 2, max_runtime_seconds: 30 }, {
    now: c.now, sleep: c.sleep, isRunning: () => true, pollMs: 1000,
    sendCommand: async (command) => {
      if (command === 'soak_turns') return { status: 'ok', result: { started: true } };
      if (command === 'soak_status') {
        polls += 1;
        return { status: 'ok', result: polls < 2
          ? { running: true, turns_completed: 1, completed_turns: [4] }
          : { running: false, finished: true, status: 'complete', turns_completed: 2, completed_turns: [4, 5] } };
      }
      throw new Error(`unexpected ${command}`);
    },
  });
  assert.equal(result.result.status, 'complete');
  assert.equal(result.result.turns_completed, 2);
  assert.deepEqual(result.result.completed_turns, [4, 5]);
});

test('manual abort/unknown blocker status is preserved rather than relabelled complete', async () => {
  const c = clock();
  for (const final of [
    { status: 'aborted', stop_reason: 'manual_abort' },
    { status: 'blocked', stop_reason: 'unknown_blocker', blockers: [{ kind: 'advisor' }] },
  ]) {
    const result = await runSoak({ turns: 2, max_runtime_seconds: 10 }, {
      now: c.now, sleep: c.sleep, isRunning: () => true, pollMs: 1,
      sendCommand: async (command) => command === 'soak_turns'
        ? { status: 'ok', result: { started: true } }
        : { status: 'ok', result: { running: false, finished: true, turns_completed: 0, ...final } },
    });
    assert.equal(result.result.status, final.status);
    assert.equal(result.result.turns_completed, 0);
  }
});

test('process exit produces distinct partial resumable reporting', async () => {
  const c = clock();
  let running = true;
  const result = await runSoak({ turns: 3, max_runtime_seconds: 20 }, {
    now: c.now,
    sleep: async (ms) => { await c.sleep(ms); running = false; },
    isRunning: () => running,
    pollMs: 1000,
    sendCommand: async (command) => command === 'soak_turns'
      ? { status: 'ok', result: { started: true, turns_completed: 0 } }
      : { status: 'ok', result: { running: true, turns_completed: 1 } },
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.result.status, 'process_exited');
  assert.equal(result.result.reporting_resumable, true);
});

test('overall timeout requests abort and returns partial timeout evidence', async () => {
  const c = clock();
  const calls = [];
  const result = await runSoak({ turns: 1, max_runtime_seconds: 1 }, {
    now: c.now, sleep: c.sleep, isRunning: () => true, pollMs: 1000,
    sendCommand: async (command) => {
      calls.push(command);
      if (command === 'soak_turns') return { status: 'ok', result: { started: true } };
      if (command === 'soak_abort') return { status: 'ok', result: { aborting: true } };
      return { status: 'ok', result: { running: true, finished: false, turns_completed: 0 } };
    },
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.result.status, 'timeout');
  assert.ok(calls.includes('soak_abort'));
  assert.equal(result.result.turns_completed, 0);
});
