import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEvidenceManager } from '../lib/session-evidence.js';

async function withDirs(fn) {
  const repo = await mkdtemp(join(tmpdir(), 'wh3-mcp-evidence-repo-'));
  const artifacts = await mkdtemp(join(tmpdir(), 'wh3-mcp-evidence-out-'));
  try { await fn(repo, artifacts); }
  finally {
    await rm(repo, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
}

function diag(cursorOffset, since = null) {
  return {
    status: 'ok',
    result: {
      session_id: 'transport-1',
      run_id: 'process-1',
      has_new_errors: false,
      evidence_complete: true,
      observed_error_count: 0,
      warnings: [],
      cursor: {
        session_id: 'transport-1',
        run_id: 'process-1',
        files: { 'wh3_mcp_script_errors.log': { offset: cursorOffset, identity: 'fs:1:2:3' } },
      },
      sources: {
        'wh3_mcp_script_errors.log': {
          state: 'available', evidence: since ? 'current-since-cursor' : 'current-since-baseline',
          read_bytes: since ? 12 : 0, read_sha256: since ? 'a'.repeat(64) : null,
          matching_error_count_observed: 0, next_offset: cursorOffset,
        },
      },
    },
  };
}

test('begin/end binds one transport/process run and fresh log cursor boundaries', async () => withDirs(async (repo, artifacts) => {
  let running = true;
  let diagnosticCalls = 0;
  const manager = new SessionEvidenceManager({
    artifactDir: artifacts,
    sourceRepoRoot: repo,
    getIdentity: () => ({ running, session_id: 'transport-1', run_id: 'process-1', pid: 123, next_request_id: 10 }),
    getVersions: () => ({ protocol: 2, server_version: '0.1.0', lua_script_version: '2.0.0' }),
    getDiagnostics: ({ since }) => {
      diagnosticCalls += 1;
      return diag(since ? 22 : 10, since);
    },
    getSituation: async () => ({ status: 'ok', result: { context: 'campaign', turn: 3, blocking: [] } }),
  });
  const begun = await manager.begin({ label: 'fixture' });
  assert.equal(begun.status, 'ok');
  assert.equal(begun.result.transport_session_id, 'transport-1');
  assert.equal(begun.result.process_run_id, 'process-1');
  const ended = await manager.end();
  assert.equal(ended.status, 'ok');
  assert.equal(ended.result.log_boundary_start.files['wh3_mcp_script_errors.log'].offset, 10);
  assert.equal(ended.result.log_boundary_end.files['wh3_mcp_script_errors.log'].offset, 22);
  assert.equal(diagnosticCalls, 2);
  running = false;
}));

test('command observations deduplicate duplicate protocol replies and preserve errors', async () => withDirs(async (repo, artifacts) => {
  const manager = new SessionEvidenceManager({
    artifactDir: artifacts,
    sourceRepoRoot: repo,
    getIdentity: () => ({ running: false, session_id: 'transport-1', run_id: 'process-1' }),
    getVersions: () => ({ protocol: 2 }),
    getDiagnostics: ({ since }) => diag(since ? 20 : 10, since),
    getSituation: async () => null,
  });
  await manager.begin();
  const duplicate = { status: 'error', session_id: 'transport-1', request_id: 44, error: { code: 'COMMAND_TIMEOUT', message: 'timed out' } };
  manager.recordCommand('end_turn', duplicate, { startedAtMs: 1, endedAtMs: 2 });
  manager.recordCommand('end_turn', duplicate, { startedAtMs: 1, endedAtMs: 2 });
  const ended = await manager.end();
  assert.equal(ended.result.command_count, 1);
  assert.equal(ended.result.command_error_count, 1);
}));

test('evidence export writes atomic bounded documents and never self-declares runtime verification', async () => withDirs(async (repo, artifacts) => {
  const manager = new SessionEvidenceManager({
    artifactDir: artifacts,
    sourceRepoRoot: repo,
    getIdentity: () => ({ running: false, session_id: 'transport-1', run_id: 'process-1', pid: 123 }),
    getVersions: () => ({ protocol: 2, server_version: '0.1.0' }),
    getDiagnostics: ({ since }) => diag(since ? 30 : 10, since),
    getSituation: async () => null,
  });
  await manager.begin({ label: 'export-fixture' });
  manager.recordArtifact({ capture_id: 'capture-1', artifact: { relative_path: 's/r/capture.png', sha256: 'b'.repeat(64), width: 2, height: 2, bytes: 99, format: 'png', mime_type: 'image/png' } });
  await manager.end();
  const exported = await manager.exportEvidence();
  assert.equal(exported.status, 'ok');
  assert.equal(exported.result.verification, 'OBSERVATIONS_ONLY');
  const manifestPath = join(artifacts, exported.result.manifest_relative_path);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.kind, 'wh3_mcp_session_evidence');
  assert.equal(manifest.transport_session_id, 'transport-1');
  assert.equal(manifest.process_run_id, 'process-1');
  assert.equal(manifest.run_id, exported.result.run_id);
  assert.equal(manifest.screenshot_artifacts.length, 1);
  assert.equal(manifest.diagnostics.sources['wh3_mcp_script_errors.log'].read_sha256, 'a'.repeat(64));
  assert.notEqual(manifest.verification, 'RUNTIME_VERIFIED');
}));

test('active export is allowed by default and evidence write failure is typed', async () => withDirs(async (repo, artifacts) => {
  const base = {
    artifactDir: artifacts,
    sourceRepoRoot: repo,
    getIdentity: () => ({ running: false, session_id: 's', run_id: 'r' }),
    getVersions: () => ({ protocol: 2 }),
    getDiagnostics: ({ since }) => diag(since ? 20 : 10, since),
    getSituation: async () => null,
  };
  const active = new SessionEvidenceManager(base);
  await active.begin();
  const snapshot = await active.exportEvidence();
  assert.equal(snapshot.status, 'ok');

  const broken = new SessionEvidenceManager({ ...base, atomicWrite: async () => { throw new Error('disk full'); } });
  await broken.begin();
  const failed = await broken.exportEvidence();
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'EVIDENCE_WRITE_FAILED');
}));
