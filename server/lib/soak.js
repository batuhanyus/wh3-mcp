export const SOAK_LIMITS = Object.freeze({
  maxTurns: 200,
  minPerTurnSeconds: 5,
  maxPerTurnSeconds: 900,
  maxRuntimeSeconds: 7200,
  pollMs: 2000,
});

export const SOAK_PERMISSIONS = Object.freeze([
  'battle',
  'dilemma',
  'occupation',
  'confirm_dialogs',
  'dismiss_events',
  'suppress_events',
]);

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function integer(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`INVALID_${label.toUpperCase()}`, `${label} must be an integer`);
  return n;
}

export function normalizeSoakArgs(args = {}) {
  const turns = args.turns === undefined ? 5 : integer(args.turns, 'turns');
  if (turns <= 0 || turns > SOAK_LIMITS.maxTurns) fail('INVALID_TURNS', `turns must be between 1 and ${SOAK_LIMITS.maxTurns}`);
  const perTurn = args.max_seconds_per_turn === undefined ? 300 : integer(args.max_seconds_per_turn, 'max_seconds_per_turn');
  if (perTurn < SOAK_LIMITS.minPerTurnSeconds || perTurn > SOAK_LIMITS.maxPerTurnSeconds) {
    fail('INVALID_TURN_DEADLINE', `max_seconds_per_turn must be between ${SOAK_LIMITS.minPerTurnSeconds} and ${SOAK_LIMITS.maxPerTurnSeconds}`);
  }
  const defaultRuntime = Math.min(SOAK_LIMITS.maxRuntimeSeconds, Math.max(60, turns * perTurn + 60));
  const maxRuntime = args.max_runtime_seconds === undefined ? defaultRuntime : integer(args.max_runtime_seconds, 'max_runtime_seconds');
  if (maxRuntime <= 0 || maxRuntime > SOAK_LIMITS.maxRuntimeSeconds) fail('INVALID_MAX_RUNTIME', `max_runtime_seconds must be between 1 and ${SOAK_LIMITS.maxRuntimeSeconds}`);

  const permissions = new Set((args.permissions ?? []).map(String));
  for (const permission of permissions) if (!SOAK_PERMISSIONS.includes(permission)) fail('INVALID_PERMISSION', `unsupported soak permission: ${permission}`);
  const requirePermission = (permission, condition, reason) => {
    if (condition && !permissions.has(permission)) fail('MISSING_SCENARIO_PERMISSION', `${reason} requires permissions including "${permission}"`);
  };

  const battlePolicy = args.battle_policy ?? 'stop';
  if (!['autoresolve', 'retreat', 'stop'].includes(battlePolicy)) fail('INVALID_BATTLE_POLICY', 'battle_policy must be autoresolve, retreat, or stop');
  requirePermission('battle', battlePolicy !== 'stop' || args.rig_battles === true, 'battle automation');

  let dilemmaChoice = null;
  if (args.dilemma_choice !== undefined && args.dilemma_choice !== null) {
    dilemmaChoice = integer(args.dilemma_choice, 'dilemma_choice');
    if (dilemmaChoice < 1 || dilemmaChoice > 4) fail('INVALID_DILEMMA_CHOICE', 'dilemma_choice must be 1..4');
    requirePermission('dilemma', true, 'dilemma decisions');
  }

  const occupation = args.occupation === undefined || args.occupation === null ? null : String(args.occupation).trim();
  if (occupation === '') fail('INVALID_OCCUPATION', 'occupation must be a non-empty option when supplied');
  requirePermission('occupation', occupation !== null, 'occupation decisions');
  requirePermission('confirm_dialogs', args.confirm_dialogs === true, 'dialog confirmation');
  requirePermission('dismiss_events', args.dismiss_events === true, 'event dismissal');
  requirePermission('suppress_events', args.suppress_events === true, 'event suppression');

  const captives = args.captives ?? 'kill';
  if (!['kill', 'enslave', 'release'].includes(captives)) fail('INVALID_CAPTIVES', 'captives must be kill, enslave, or release');

  return {
    turns,
    battle_policy: battlePolicy,
    rig_battles: args.rig_battles === true,
    captives,
    dilemma_choice: dilemmaChoice,
    occupation,
    confirm_dialogs: args.confirm_dialogs === true,
    dismiss_events: args.dismiss_events === true,
    suppress_events: args.suppress_events === true,
    permissions: [...permissions],
    max_seconds_per_turn: perTurn,
    max_runtime_seconds: maxRuntime,
  };
}

function processExitReport(lastStatus) {
  const prior = lastStatus?.result ?? {};
  return {
    status: 'partial',
    result: {
      ...prior,
      running: false,
      finished: false,
      status: 'process_exited',
      stop_reason: 'WH3 process exited before soak completion',
      reporting_resumable: true,
    },
  };
}

export async function runSoak(args, {
  sendCommand,
  isRunning,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = SOAK_LIMITS.pollMs,
  onProgress = () => {},
} = {}) {
  const normalized = normalizeSoakArgs(args);
  if (!isRunning()) return { status: 'error', error: { code: 'PROCESS_EXITED', message: 'WH3 is not running' } };
  const ack = await sendCommand('soak_turns', normalized, 15000);
  if (ack?.status !== 'ok') return ack;
  let lastStatus = ack;
  const deadline = now() + normalized.max_runtime_seconds * 1000;

  while (now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    if (!isRunning()) {
      const report = processExitReport(lastStatus);
      onProgress(report);
      return report;
    }
    const current = await sendCommand('soak_status', {}, 20000);
    if (current?.status === 'error' && current.error?.code === 'GAME_EXITED') {
      const report = processExitReport(lastStatus);
      onProgress(report);
      return report;
    }
    if (current?.status === 'ok' && current.result) {
      lastStatus = current;
      onProgress(current);
      if (current.result.finished || current.result.running === false) return current;
    }
  }

  if (isRunning()) await sendCommand('soak_abort', {}, 10000).catch(() => null);
  let finalStatus = lastStatus;
  if (isRunning()) {
    const current = await sendCommand('soak_status', {}, 10000).catch(() => null);
    if (current?.status === 'ok' && current.result) finalStatus = current;
  }
  const report = {
    status: 'timeout',
    result: {
      ...(finalStatus?.result ?? {}),
      running: finalStatus?.result?.running ?? false,
      status: 'timeout',
      stop_reason: `server max runtime ${normalized.max_runtime_seconds}s exceeded; abort requested`,
      reporting_resumable: true,
    },
  };
  onProgress(report);
  return report;
}
