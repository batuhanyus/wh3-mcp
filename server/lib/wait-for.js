import { normalizeUiInspectionArgs } from './ui-inspection.js';

export const WAIT_LIMITS = Object.freeze({
  minTimeoutMs: 100,
  maxTimeoutMs: 120000,
  minPollIntervalMs: 50,
  maxPollIntervalMs: 5000,
  maxObservations: 500,
  maxConditions: 16,
  maxTimeline: 32,
});

const SUPPORTED = new Set([
  'context',
  'turn',
  'saving',
  'blocking.kind',
  'ui.exists',
  'ui.visible',
  'ui.parent_id',
]);

function invalid(message, details = undefined) {
  const error = new TypeError(message);
  error.code = 'INVALID_REQUEST';
  if (details !== undefined) error.details = details;
  return error;
}

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function conditionLabel(condition, index) {
  const suffix = condition.component_id ? `:${condition.component_id}` : '';
  return `${index + 1}:${condition.type}${suffix}`;
}

function normalizeCondition(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(`conditions[${index}] must be an object`);
  }
  const type = raw.type;
  if (typeof type !== 'string' || type.trim() === '') {
    throw invalid(`conditions[${index}].type must be a non-empty string`);
  }
  const normalizedType = type.trim();
  if (!SUPPORTED.has(normalizedType)) {
    return { type: normalizedType, unsupported: true, label: `${index + 1}:${normalizedType}` };
  }

  if (normalizedType === 'context' || normalizedType === 'blocking.kind') {
    if (typeof raw.equals !== 'string' || raw.equals.trim() === '') {
      throw invalid(`conditions[${index}].equals must be a non-empty string for ${normalizedType}`);
    }
    const condition = { type: normalizedType, equals: raw.equals.trim() };
    condition.label = conditionLabel(condition, index);
    return condition;
  }
  if (normalizedType === 'turn') {
    if (!Number.isInteger(raw.equals)) throw invalid(`conditions[${index}].equals must be an integer for turn`);
    const condition = { type: normalizedType, equals: raw.equals };
    condition.label = conditionLabel(condition, index);
    return condition;
  }
  if (normalizedType === 'saving') {
    if (typeof raw.equals !== 'boolean') throw invalid(`conditions[${index}].equals must be boolean for saving`);
    const condition = { type: normalizedType, equals: raw.equals };
    condition.label = conditionLabel(condition, index);
    return condition;
  }

  const inspect = normalizeUiInspectionArgs({
    component_id: raw.component_id,
    path: raw.path,
    parent_path: raw.parent_path,
    max_depth: 0,
    max_nodes: 1,
  });
  if (normalizedType === 'ui.exists' || normalizedType === 'ui.visible') {
    const equals = raw.equals === undefined ? true : raw.equals;
    if (typeof equals !== 'boolean') throw invalid(`conditions[${index}].equals must be boolean for ${normalizedType}`);
    const condition = { type: normalizedType, equals, ...inspect };
    condition.label = conditionLabel(condition, index);
    return condition;
  }
  if (typeof raw.equals !== 'string' || raw.equals.trim() === '') {
    throw invalid(`conditions[${index}].equals must be a non-empty parent id for ui.parent_id`);
  }
  const condition = { type: normalizedType, equals: raw.equals.trim(), ...inspect };
  condition.label = conditionLabel(condition, index);
  return condition;
}

export function normalizeWaitForArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('wait arguments must be an object');
  if (!Array.isArray(args.conditions) || args.conditions.length < 1 || args.conditions.length > WAIT_LIMITS.maxConditions) {
    throw invalid(`conditions must contain 1..${WAIT_LIMITS.maxConditions} typed conditions`);
  }
  const mode = args.mode ?? 'all';
  if (mode !== 'all' && mode !== 'any') throw invalid('mode must be "all" or "any"');

  const timeoutMs = clampInteger(args.timeout_ms, 30000, WAIT_LIMITS.minTimeoutMs, WAIT_LIMITS.maxTimeoutMs);
  const pollIntervalMs = clampInteger(args.poll_interval_ms, 250, WAIT_LIMITS.minPollIntervalMs, WAIT_LIMITS.maxPollIntervalMs);
  const defaultMaxObservations = Math.min(WAIT_LIMITS.maxObservations, Math.ceil(timeoutMs / pollIntervalMs) + 1);
  const maxObservations = clampInteger(args.max_observations, defaultMaxObservations, 1, WAIT_LIMITS.maxObservations);
  const conditions = args.conditions.map(normalizeCondition);
  return { conditions, mode, timeout_ms: timeoutMs, poll_interval_ms: pollIntervalMs, max_observations: maxObservations };
}

function selectorKey(condition) {
  return JSON.stringify({
    component_id: condition.component_id,
    path: condition.path ?? null,
    parent_path: condition.parent_path ?? null,
  });
}

function compactSituation(situation) {
  return {
    context: situation?.context ?? null,
    turn: situation?.turn ?? null,
    saving: situation?.saving ?? null,
    blocking_kinds: Array.isArray(situation?.blocking)
      ? situation.blocking.map((entry) => entry?.kind ?? null).filter(Boolean).slice(0, 16)
      : [],
  };
}

function compactInspection(inspection) {
  return {
    component_id: inspection?.component_id ?? null,
    found: inspection?.found === true,
    visible: typeof inspection?.visible === 'boolean' ? inspection.visible : null,
    parent_id: inspection?.parent_id ?? null,
    path: Array.isArray(inspection?.path) ? inspection.path.slice(0, 64) : null,
    errors: Array.isArray(inspection?.errors)
      ? inspection.errors.slice(0, 4).map((entry) => entry?.code ?? 'UNKNOWN')
      : [],
  };
}

function evaluateCondition(condition, situation, inspections) {
  if (condition.type === 'context') return situation?.context === condition.equals;
  if (condition.type === 'turn') return situation?.turn === condition.equals;
  if (condition.type === 'saving') return situation?.saving === condition.equals;
  if (condition.type === 'blocking.kind') {
    return Array.isArray(situation?.blocking) && situation.blocking.some((entry) => entry?.kind === condition.equals);
  }
  const inspection = inspections.get(selectorKey(condition));
  if (!inspection) return false;
  if (condition.type === 'ui.exists') return (inspection.found === true) === condition.equals;
  if (condition.type === 'ui.visible') {
    return inspection.found === true && typeof inspection.visible === 'boolean' && inspection.visible === condition.equals;
  }
  if (condition.type === 'ui.parent_id') return inspection.found === true && inspection.parent_id === condition.equals;
  return false;
}

function resultEnvelope(outcome, startedAt, now, observations, timeline, timelineTruncated, extra = {}) {
  return {
    status: 'ok',
    result: {
      outcome,
      matched: outcome === 'matched',
      timed_out: outcome === 'timed_out',
      elapsed_ms: Math.max(0, now() - startedAt),
      observations,
      timeline,
      timeline_truncated: timelineTruncated,
      ...extra,
    },
  };
}

function transportOutcome(reply) {
  const code = reply?.error?.code;
  if (code === 'GAME_EXITED') return 'process_exited';
  if (['PROTOCOL_MISMATCH', 'STALE_RESPONSE', 'CONTEXT_CHANGED'].includes(code)) return 'session_changed';
  return 'transport_error';
}

function inspectionFailureKind(inspection) {
  const codes = new Set(Array.isArray(inspection?.errors) ? inspection.errors.map((entry) => entry?.code) : []);
  if (codes.has('NO_UI_ROOT')) return 'ui_unavailable';
  if (codes.has('LOOKUP_FAILURE') || codes.has('LOOKUP_TRUNCATED') || codes.has('AMBIGUOUS_MATCH') || codes.has('AMBIGUOUS_PATH')) {
    return 'ui_lookup_failed';
  }
  return null;
}

function identityChanged(initial, current, reply) {
  if (reply?.session_id && initial.session_id && reply.session_id !== initial.session_id) {
    return { changed: true, reason: 'reply_session_id_changed', actual_session_id: reply.session_id };
  }
  if (current?.session_id && initial.session_id && current.session_id !== initial.session_id) {
    return { changed: true, reason: 'transport_session_id_changed', actual_session_id: current.session_id };
  }
  if (initial.run_id && current?.run_id && current.run_id !== initial.run_id) {
    return { changed: true, reason: 'process_run_id_changed', actual_run_id: current.run_id };
  }
  if (initial.run_id === null && current?.run_id) {
    return { changed: true, reason: 'process_run_identity_appeared', actual_run_id: current.run_id };
  }
  return { changed: false };
}

function defaultSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener?.('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', aborted);
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    }
    signal?.addEventListener?.('abort', aborted, { once: true });
  });
}

export async function waitForConditions(rawArgs, {
  sendCommand,
  getIdentity,
  now = Date.now,
  sleep = defaultSleep,
  signal = undefined,
} = {}) {
  if (typeof sendCommand !== 'function') throw new TypeError('sendCommand is required');
  if (typeof getIdentity !== 'function') throw new TypeError('getIdentity is required');
  const args = normalizeWaitForArgs(rawArgs);
  const unsupported = args.conditions.filter((condition) => condition.unsupported);
  const startedAt = now();
  if (unsupported.length > 0) {
    return resultEnvelope('unsupported_condition', startedAt, now, 0, [], false, {
      unsupported_conditions: unsupported.map((condition) => condition.type),
      unmet_conditions: unsupported.map((condition) => condition.label),
      final_observation: null,
    });
  }

  const initialIdentity = getIdentity();
  if (!initialIdentity?.running) {
    return resultEnvelope('process_exited', startedAt, now, 0, [], false, {
      unmet_conditions: args.conditions.map((condition) => condition.label),
      final_observation: null,
    });
  }

  const deadline = startedAt + args.timeout_ms;
  const timeline = [];
  let timelineTruncated = false;
  let previousCompact = null;
  let observations = 0;
  let finalObservation = null;
  let unmetConditions = args.conditions.map((condition) => condition.label);

  while (observations < args.max_observations && now() <= deadline) {
    if (signal?.aborted) {
      return resultEnvelope('cancelled', startedAt, now, observations, timeline, timelineTruncated, {
        unmet_conditions: unmetConditions,
        final_observation: finalObservation,
      });
    }

    const before = getIdentity();
    if (!before?.running) {
      return resultEnvelope('process_exited', startedAt, now, observations, timeline, timelineTruncated, {
        unmet_conditions: unmetConditions,
        final_observation: finalObservation,
      });
    }
    const beforeChange = identityChanged(initialIdentity, before, null);
    if (beforeChange.changed) {
      return resultEnvelope('session_changed', startedAt, now, observations, timeline, timelineTruncated, {
        reason: beforeChange.reason,
        initial_identity: initialIdentity,
        current_identity: before,
        unmet_conditions: unmetConditions,
        final_observation: finalObservation,
      });
    }

    const remaining = Math.max(1, deadline - now());
    const situationReply = await sendCommand('get_situation', {}, Math.min(15000, remaining));
    if (situationReply?.status !== 'ok') {
      const outcome = transportOutcome(situationReply);
      return resultEnvelope(outcome, startedAt, now, observations, timeline, timelineTruncated, {
        transport_error: situationReply?.error ?? null,
        unmet_conditions: unmetConditions,
        final_observation: finalObservation,
      });
    }
    const afterSituation = getIdentity();
    const situationChange = identityChanged(initialIdentity, afterSituation, situationReply);
    if (situationChange.changed) {
      return resultEnvelope('session_changed', startedAt, now, observations, timeline, timelineTruncated, {
        reason: situationChange.reason,
        initial_identity: initialIdentity,
        current_identity: afterSituation,
        unmet_conditions: unmetConditions,
        final_observation: finalObservation,
      });
    }

    const situation = situationReply.result ?? {};
    const inspections = new Map();
    for (const condition of args.conditions) {
      if (!condition.type.startsWith('ui.')) continue;
      const key = selectorKey(condition);
      if (inspections.has(key)) continue;
      const inspectReply = await sendCommand('inspect_ui', {
        component_id: condition.component_id,
        ...(condition.path ? { path: condition.path } : {}),
        ...(condition.parent_path ? { parent_path: condition.parent_path } : {}),
        max_depth: 0,
        max_nodes: 1,
      }, Math.min(15000, Math.max(1, deadline - now())));
      if (inspectReply?.status !== 'ok') {
        const outcome = transportOutcome(inspectReply);
        return resultEnvelope(outcome, startedAt, now, observations, timeline, timelineTruncated, {
          transport_error: inspectReply?.error ?? null,
          unmet_conditions: unmetConditions,
          final_observation: finalObservation,
        });
      }
      const afterInspect = getIdentity();
      const inspectChange = identityChanged(initialIdentity, afterInspect, inspectReply);
      if (inspectChange.changed) {
        return resultEnvelope('session_changed', startedAt, now, observations, timeline, timelineTruncated, {
          reason: inspectChange.reason,
          initial_identity: initialIdentity,
          current_identity: afterInspect,
          unmet_conditions: unmetConditions,
          final_observation: finalObservation,
        });
      }
      const inspection = inspectReply.result ?? {};
      const failure = inspectionFailureKind(inspection);
      if (failure) {
        return resultEnvelope(failure, startedAt, now, observations, timeline, timelineTruncated, {
          ui_error: compactInspection(inspection),
          unmet_conditions: unmetConditions,
          final_observation: finalObservation,
        });
      }
      inspections.set(key, inspection);
    }

    observations += 1;
    const conditionResults = args.conditions.map((condition) => ({
      condition: condition.label,
      matched: evaluateCondition(condition, situation, inspections),
    }));
    const matched = args.mode === 'all'
      ? conditionResults.every((entry) => entry.matched)
      : conditionResults.some((entry) => entry.matched);
    unmetConditions = conditionResults.filter((entry) => !entry.matched).map((entry) => entry.condition);
    finalObservation = {
      at_elapsed_ms: Math.max(0, now() - startedAt),
      situation,
      ui: [...inspections.values()],
      condition_results: conditionResults,
    };

    const compact = {
      at_elapsed_ms: finalObservation.at_elapsed_ms,
      situation: compactSituation(situation),
      ui: [...inspections.values()].map(compactInspection),
      condition_results: conditionResults,
    };
    const compactState = JSON.stringify({ situation: compact.situation, ui: compact.ui, condition_results: compact.condition_results });
    if (compactState !== previousCompact) {
      previousCompact = compactState;
      if (timeline.length >= WAIT_LIMITS.maxTimeline) {
        timelineTruncated = true;
        if (timeline.length > 1) timeline.splice(1, 1);
        else timeline.shift();
      }
      timeline.push(compact);
    }

    if (matched) {
      return resultEnvelope('matched', startedAt, now, observations, timeline, timelineTruncated, {
        mode: args.mode,
        unmet_conditions: [],
        final_observation: finalObservation,
      });
    }
    if (observations >= args.max_observations || now() >= deadline) break;

    try {
      await sleep(Math.min(args.poll_interval_ms, Math.max(0, deadline - now())), signal);
    } catch (error) {
      if (error?.code === 'ABORTED' || signal?.aborted) {
        return resultEnvelope('cancelled', startedAt, now, observations, timeline, timelineTruncated, {
          unmet_conditions: unmetConditions,
          final_observation: finalObservation,
        });
      }
      throw error;
    }
  }

  return resultEnvelope('timed_out', startedAt, now, observations, timeline, timelineTruncated, {
    mode: args.mode,
    unmet_conditions: unmetConditions,
    final_observation: finalObservation,
  });
}
