import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { redactLocalPath } from './screenshot-artifacts.js';

const MAX_COMMAND_OBSERVATIONS = 200;
const MAX_COMMAND_ERRORS = 100;
const MAX_ARTIFACTS = 50;

function safeSegment(value, fallback = 'session') {
  const text = String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return (text || fallback).slice(0, 72);
}

function ensureOutsideRoot(candidate, forbiddenRoot) {
  const root = resolve(forbiddenRoot);
  const path = resolve(candidate);
  const rel = relative(root, path);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    const error = new Error('evidence artifact directory must not be inside the source repository');
    error.code = 'INVALID_ARTIFACT_DIRECTORY';
    throw error;
  }
  return path;
}

function compactError(reply) {
  if (!reply || reply.status !== 'error') return null;
  if (typeof reply.error === 'string') return { code: 'COMMAND_ERROR', message: reply.error.slice(0, 500) };
  return {
    code: reply.error?.code ?? 'COMMAND_ERROR',
    message: String(reply.error?.message ?? 'command failed').slice(0, 500),
  };
}

function recursiveRedact(value) {
  if (typeof value === 'string') {
    let text = redactLocalPath(value);
    text = text.replace(/\b((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>');
    return text;
  }
  if (Array.isArray(value)) return value.map(recursiveRedact);
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return `<buffer:${value.length}>`;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, recursiveRedact(item)]));
  }
  return value;
}

function serialiseJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Json(value) {
  return createHash('sha256').update(serialiseJson(value), 'utf8').digest('hex');
}

async function defaultAtomicWrite(path, value) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, serialiseJson(value), { encoding: 'utf8', flag: 'wx' });
  try { await rename(temp, path); }
  catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function diagnosticsSynopsis(diag) {
  const result = diag?.result;
  if (!result) return { available: false, status: diag?.status ?? 'unknown' };
  const sources = Object.fromEntries(Object.entries(result.sources ?? {}).map(([name, source]) => [name, {
    state: source?.state ?? 'unknown',
    evidence: source?.evidence ?? 'unavailable',
    read_bytes: source?.read_bytes ?? 0,
    read_sha256: source?.read_sha256 ?? null,
    matching_error_count_observed: source?.matching_error_count_observed ?? 0,
    next_offset: source?.next_offset ?? null,
  }]));
  return {
    available: true,
    has_new_errors: result.has_new_errors,
    evidence_complete: result.evidence_complete,
    observed_error_count: result.observed_error_count,
    warnings: result.warnings ?? [],
    sources,
  };
}

function stripArtifact(record) {
  if (!record || typeof record !== 'object') return null;
  const artifact = record.artifact ?? record.result?.artifact;
  const source = record.source ?? record.result?.source;
  const captureId = record.capture_id ?? record.result?.capture_id;
  if (!artifact && !captureId) return null;
  return {
    capture_id: captureId ?? null,
    source: source ? {
      filename: source.filename ?? null,
      bytes: source.bytes ?? null,
      sha256: source.sha256 ?? null,
      modified_ms: source.modified_ms ?? null,
    } : null,
    artifact: artifact ? {
      format: artifact.format ?? null,
      mime_type: artifact.mime_type ?? null,
      relative_path: artifact.relative_path ?? null,
      bytes: artifact.bytes ?? null,
      sha256: artifact.sha256 ?? null,
      width: artifact.width ?? null,
      height: artifact.height ?? null,
    } : null,
  };
}

export class SessionEvidenceManager {
  constructor({
    artifactDir = process.env.WH3_MCP_ARTIFACT_DIR || join(tmpdir(), 'wh3-mcp-artifacts'),
    sourceRepoRoot = null,
    getIdentity,
    getVersions,
    getDiagnostics,
    getSituation,
    now = Date.now,
    atomicWrite = defaultAtomicWrite,
  }) {
    this.getIdentity = getIdentity;
    this.getVersions = getVersions;
    this.getDiagnostics = getDiagnostics;
    this.getSituation = getSituation;
    this.now = now;
    this.atomicWrite = atomicWrite;
    this.active = null;
    this.last = null;
    try {
      this.artifactDir = sourceRepoRoot ? ensureOutsideRoot(artifactDir, sourceRepoRoot) : resolve(artifactDir);
      this.configurationError = null;
    } catch (error) {
      this.artifactDir = resolve(artifactDir);
      this.configurationError = error;
    }
  }

  async begin({ label = null, extraFiles = [] } = {}) {
    if (this.configurationError) return { status: 'error', error: { code: this.configurationError.code, message: this.configurationError.message } };
    if (this.active) return { status: 'error', error: { code: 'TEST_SESSION_ACTIVE', message: 'a test session is already active' } };
    const identity = this.getIdentity?.() ?? {};
    const evidenceRunId = `evidence-${this.now()}-${randomUUID()}`;
    const startedAtMs = this.now();
    const boundary = await Promise.resolve(this.getDiagnostics?.({ extraFiles, since: null }));
    const session = {
      test_session_id: `test-${randomUUID()}`,
      evidence_run_id: evidenceRunId,
      label: label ? String(label).slice(0, 160) : null,
      started_at_ms: startedAtMs,
      ended_at_ms: null,
      identity_start: identity,
      identity_end: null,
      identity_changed: false,
      versions: this.getVersions?.() ?? {},
      extra_files: extraFiles.slice(0, 10).map(String),
      log_boundary_start: boundary?.result?.cursor ?? null,
      log_boundary_end: null,
      start_diagnostics: diagnosticsSynopsis(boundary),
      end_diagnostics: null,
      start_situation: null,
      end_situation: null,
      command_count: 0,
      command_counts: {},
      command_errors: [],
      commands: [],
      command_observations_truncated: false,
      artifacts: [],
      seen_requests: new Set(),
      state: 'active',
    };
    this.active = session;
    if (identity.running !== false) {
      const situation = await Promise.resolve(this.getSituation?.());
      session.start_situation = situation ?? null;
    }
    return { status: 'ok', result: this._summary(session) };
  }

  recordCommand(command, reply, { startedAtMs = null, endedAtMs = null } = {}) {
    const session = this.active;
    if (!session) return;
    const key = reply?.session_id && reply?.request_id ? `${reply.session_id}:${reply.request_id}` : null;
    if (key && session.seen_requests.has(key)) return;
    if (key) session.seen_requests.add(key);
    session.command_count += 1;
    session.command_counts[command] = (session.command_counts[command] ?? 0) + 1;
    const error = compactError(reply);
    if (error && session.command_errors.length < MAX_COMMAND_ERRORS) {
      session.command_errors.push({ command, ...error, request_id: reply?.request_id ?? null, at_ms: endedAtMs ?? this.now() });
    }
    const observation = {
      command,
      status: reply?.status ?? 'unknown',
      error_code: error?.code ?? null,
      request_id: reply?.request_id ?? null,
      session_id: reply?.session_id ?? null,
      started_at_ms: startedAtMs,
      ended_at_ms: endedAtMs,
    };
    if (session.commands.length < MAX_COMMAND_OBSERVATIONS) session.commands.push(observation);
    else session.command_observations_truncated = true;
  }

  recordArtifact(record) {
    if (!this.active) return;
    const artifact = stripArtifact(record);
    if (!artifact) return;
    if (this.active.artifacts.length < MAX_ARTIFACTS) this.active.artifacts.push(artifact);
  }

  async _captureEnd(session) {
    if (session.end_diagnostics) return;
    session.identity_end = this.getIdentity?.() ?? {};
    const startSession = session.identity_start?.session_id ?? null;
    const endSession = session.identity_end?.session_id ?? null;
    const startRun = session.identity_start?.run_id ?? null;
    const endRun = session.identity_end?.run_id ?? null;
    session.identity_changed = startSession !== endSession || startRun !== endRun;
    if (session.identity_changed) {
      session.end_diagnostics = {
        status: 'error',
        error: {
          code: 'SESSION_RUN_CHANGED',
          message: 'transport session/process run changed during the evidence session; later-run observations were not merged',
        },
      };
      session.log_boundary_end = null;
      session.ended_at_ms = this.now();
      return;
    }
    if (session.identity_end.running !== false) session.end_situation = await Promise.resolve(this.getSituation?.()) ?? null;
    const endDiagnostics = await Promise.resolve(this.getDiagnostics?.({ extraFiles: session.extra_files, since: session.log_boundary_start }));
    session.end_diagnostics = endDiagnostics ?? null;
    session.log_boundary_end = endDiagnostics?.result?.cursor ?? null;
    session.ended_at_ms = this.now();
  }

  async end() {
    if (!this.active) return { status: 'error', error: { code: 'NO_TEST_SESSION', message: 'no test session is active' } };
    const session = this.active;
    await this._captureEnd(session);
    session.state = 'ended';
    this.active = null;
    this.last = session;
    return { status: 'ok', result: this._summary(session) };
  }

  async exportEvidence({ includeActive = true } = {}) {
    const sourceSession = this.active ?? this.last;
    if (!sourceSession) return { status: 'error', error: { code: 'NO_TEST_SESSION', message: 'begin a test session before exporting evidence' } };
    if (this.active && !includeActive) return { status: 'error', error: { code: 'TEST_SESSION_ACTIVE', message: 'end the active test session before exporting evidence' } };
    let session = sourceSession;
    if (this.active) {
      session = {
        ...sourceSession,
        identity_end: null,
        identity_changed: false,
        end_diagnostics: null,
        end_situation: null,
        log_boundary_end: null,
        ended_at_ms: null,
        state: 'active_snapshot',
        command_counts: { ...sourceSession.command_counts },
        command_errors: [...sourceSession.command_errors],
        commands: [...sourceSession.commands],
        artifacts: [...sourceSession.artifacts],
        completed_turns: sourceSession.completed_turns ? [...sourceSession.completed_turns] : undefined,
      };
      await this._captureEnd(session);
      session.state = 'active_snapshot';
    }

    const runDir = join(this.artifactDir, 'evidence', safeSegment(session.evidence_run_id));
    try { await mkdir(runDir, { recursive: true }); }
    catch (error) { return { status: 'error', error: { code: 'EVIDENCE_WRITE_FAILED', message: error.message } }; }

    const commandsDoc = recursiveRedact({
      command_count: session.command_count,
      command_counts: session.command_counts,
      command_errors: session.command_errors,
      commands: session.commands,
      observations_truncated: session.command_observations_truncated,
    });
    const diagnosticsDoc = recursiveRedact(session.end_diagnostics ?? { status: 'unavailable' });
    const commandPath = join(runDir, 'commands.json');
    const diagnosticsPath = join(runDir, 'diagnostics.json');
    const manifestPath = join(runDir, 'manifest.json');
    const manifest = recursiveRedact({
      schema: 1,
      kind: 'wh3_mcp_session_evidence',
      verification: 'OBSERVATIONS_ONLY',
      note: 'This export records observations and does not itself grant RUNTIME_VERIFIED status.',
      test_session_id: session.test_session_id,
      run_id: session.evidence_run_id,
      label: session.label,
      state: session.state,
      started_at_ms: session.started_at_ms,
      ended_at_ms: session.ended_at_ms,
      transport_session_id: session.identity_start?.session_id ?? null,
      process_run_id: session.identity_start?.run_id ?? null,
      process_identity_start: session.identity_start,
      process_identity_end: session.identity_end,
      identity_consistent: !session.identity_changed,
      request_count_delta: Number.isInteger(session.identity_start?.next_request_id) && Number.isInteger(session.identity_end?.next_request_id)
        ? Math.max(0, session.identity_end.next_request_id - session.identity_start.next_request_id)
        : null,
      versions: session.versions,
      log_boundaries: {
        start: session.log_boundary_start,
        end: session.log_boundary_end,
      },
      start_situation: session.start_situation,
      end_situation: session.end_situation,
      diagnostics: diagnosticsSynopsis(session.end_diagnostics),
      command_summary: {
        count: session.command_count,
        by_command: session.command_counts,
        error_count: session.command_errors.length,
        observations_truncated: session.command_observations_truncated,
      },
      screenshot_artifacts: session.artifacts,
      files: {
        commands: { name: 'commands.json', sha256: sha256Json(commandsDoc) },
        diagnostics: { name: 'diagnostics.json', sha256: sha256Json(diagnosticsDoc) },
      },
    });

    try {
      await this.atomicWrite(commandPath, commandsDoc);
      await this.atomicWrite(diagnosticsPath, diagnosticsDoc);
      await this.atomicWrite(manifestPath, manifest);
    } catch (error) {
      return { status: 'error', error: { code: 'EVIDENCE_WRITE_FAILED', message: error?.message ?? String(error) } };
    }

    return {
      status: 'ok',
      result: {
        test_session_id: session.test_session_id,
        run_id: session.evidence_run_id,
        state: session.state,
        manifest_path: redactLocalPath(manifestPath),
        manifest_relative_path: relative(this.artifactDir, manifestPath).replaceAll('\\', '/'),
        command_count: session.command_count,
        command_error_count: session.command_errors.length,
        has_new_errors: session.end_diagnostics?.result?.has_new_errors ?? null,
        screenshot_count: session.artifacts.length,
        verification: 'OBSERVATIONS_ONLY',
      },
    };
  }

  _summary(session) {
    return {
      test_session_id: session.test_session_id,
      run_id: session.evidence_run_id,
      state: session.state,
      started_at_ms: session.started_at_ms,
      ended_at_ms: session.ended_at_ms,
      transport_session_id: session.identity_start?.session_id ?? null,
      process_run_id: session.identity_start?.run_id ?? null,
      identity_consistent: !session.identity_changed,
      command_count: session.command_count,
      command_error_count: session.command_errors.length,
      screenshot_count: session.artifacts.length,
      log_boundary_start: session.log_boundary_start,
      log_boundary_end: session.log_boundary_end,
    };
  }
}
