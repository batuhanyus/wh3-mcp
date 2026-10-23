import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdtemp, rm, unlink, utimes, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticsReader } from '../lib/diagnostics.js';

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wh3-diag-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('baseline separates historical errors from errors appended in the current run', async () => withTemp(async (root) => {
  const file = join(root, 'wh3_mcp_script_errors.log');
  await writeFile(file, 'historic script error: old\n');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1' });
  let first = reader.check();
  assert.equal(first.result.has_new_errors, null);
  assert.equal(first.result.observed_error_count, 0);
  assert.equal(first.result.sources['wh3_mcp_script_errors.log'].start_offset > 0, true);

  await appendFile(file, 'script error: current\n');
  const next = reader.check({ since: first.result.cursor });
  assert.equal(next.result.has_new_errors, true);
  assert.match(next.result.sources['wh3_mcp_script_errors.log'].content, /current/);
  assert.doesNotMatch(next.result.sources['wh3_mcp_script_errors.log'].content, /historic/);
}));

test('normal no-change polling remains stably clean with a structured cursor', async () => withTemp(async (root) => {
  await writeFile(join(root, 'wh3_mcp_script_errors.log'), 'historic capture line\n');
  await writeFile(join(root, 'script_log_stable.txt'), 'normal startup line\n');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1' });

  const first = reader.check();
  assert.equal(first.result.has_new_errors, false);
  assert.equal(first.result.evidence_complete, true);

  const second = reader.check({ since: first.result.cursor });
  assert.equal(second.result.has_new_errors, false);
  assert.equal(second.result.observed_error_count, 0);
  assert.equal(second.result.evidence_complete, true);
}));

test('rotation/recreate and size shrink are explicit and never silently skip new data', async () => withTemp(async (root) => {
  const file = join(root, 'wh3_mcp_script_errors.log');
  await writeFile(file, 'seed\n');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1' });
  await appendFile(file, 'script error: before rotate\n');
  const stamp = new Date('2026-01-01T00:00:00Z');
  await utimes(file, stamp, stamp);
  const before = reader.check();
  const cursor = before.result.cursor;
  await unlink(file);
  await writeFile(file, 'script error: after rotate\n');
  await utimes(file, stamp, stamp);
  const rotated = reader.check({ since: cursor });
  const source = rotated.result.sources['wh3_mcp_script_errors.log'];
  assert.equal(source.rotated || source.size_shrunk, true);
  assert.equal(rotated.result.has_new_errors, true);
  assert.match(source.content, /after rotate/);
}));

test('in-place truncation resets the cursor instead of skipping new short-file errors', async () => withTemp(async (root) => {
  const file = join(root, 'wh3_mcp_script_errors.log');
  await writeFile(file, '');
  await writeFile(join(root, 'script_log_truncate.txt'), 'normal startup\n');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1' });
  await writeFile(file, `${'x'.repeat(200)}\n`);
  const before = reader.check();
  assert.equal(before.result.cursor.files['wh3_mcp_script_errors.log'].offset > 100, true);

  await writeFile(file, 'script error: after truncate\n');
  const after = reader.check({ since: before.result.cursor });
  const source = after.result.sources['wh3_mcp_script_errors.log'];
  assert.equal(source.size_shrunk, true);
  assert.equal(source.start_offset, 0);
  assert.equal(after.result.has_new_errors, true);
  assert.match(source.content, /after truncate/);
}));

test('structured cursor warns on session/run mismatch while legacy offsets remain accepted as indeterminate', async () => withTemp(async (root) => {
  const file = join(root, 'wh3_mcp_script_errors.log');
  await writeFile(file, '');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S2', runId: 'R2' });
  await appendFile(file, 'plain line\n');
  const mismatch = reader.check({ since: { session_id: 'OLD', run_id: 'OLD', files: {} } });
  assert.equal(mismatch.result.has_new_errors, true);
  assert.deepEqual(mismatch.result.warnings.sort(), ['cursor_run_mismatch', 'cursor_session_mismatch']);

  const legacy = reader.check({ since: { 'wh3_mcp_script_errors.log': 0 } });
  assert.equal(legacy.result.has_new_errors, true);
  assert.match(legacy.result.warnings[0], /legacy/);
}));

test('inaccessible logs are reported as unavailable rather than clean', async () => withTemp(async (root) => {
  const blocked = join(root, 'blocked.log');
  await writeFile(blocked, 'script error: hidden\n');
  const reader = new DiagnosticsReader({
    rootDir: root,
    sessionId: 'S1',
    runId: 'R1',
    statFile: (path) => {
      if (path === blocked) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return statSync(path);
    },
  });
  const result = reader.check({ extraFiles: ['blocked.log'] });
  assert.equal(result.result.sources['blocked.log'].state, 'unavailable');
  assert.equal(result.result.sources['blocked.log'].reason, 'EACCES');
  assert.equal(result.result.has_new_errors, null);
}));

test('missing/rejected logs are unavailable evidence, not a false green result', async () => withTemp(async (root) => {
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1' });
  const result = reader.check({ extraFiles: ['missing.log', '../escape.log'] });
  assert.equal(result.result.has_new_errors, null);
  assert.equal(result.result.evidence_complete, false);
  assert.equal(result.result.sources['missing.log'].state, 'absent');
  assert.equal(result.result.sources['../escape.log'].state, 'rejected');
}));

test('large logs have bounded reads/output and preserve first/last observed errors plus truncation metadata', async () => withTemp(async (root) => {
  const file = join(root, 'wh3_mcp_script_errors.log');
  await writeFile(file, '');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1', maxReadBytes: 128, maxOutputChars: 80 });
  await writeFile(file, `script error: first\n${'x'.repeat(1000)}\nscript error: last\n`);
  const result = reader.check();
  const source = result.result.sources['wh3_mcp_script_errors.log'];
  assert.equal(source.read_truncated, true);
  assert.equal(source.unread_bytes > 0, true);
  assert.equal(source.output_truncated, true);
  assert.match(source.first_error, /first/);
  assert.match(source.last_error, /last/);
  assert.equal(result.result.has_new_errors, true);
}));

test('bounded cursor advances only through contiguous bytes so unread middle data is eventually consumed', async () => withTemp(async (root) => {
  const file = join(root, 'wh3_mcp_script_errors.log');
  await writeFile(file, '');
  await writeFile(join(root, 'script_log_bounded.txt'), 'normal startup\n');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1', maxReadBytes: 64 });
  const payload = `${'a'.repeat(160)}\nscript error: middle failure\n${'b'.repeat(240)}\n`;
  await writeFile(file, payload);

  let result = reader.check();
  assert.equal(result.result.sources['wh3_mcp_script_errors.log'].read_truncated, true);
  assert.equal(result.result.sources['wh3_mcp_script_errors.log'].next_offset < Buffer.byteLength(payload), true);

  let sawMiddle = /middle failure/.test(result.result.sources['wh3_mcp_script_errors.log'].content);
  for (let i = 0; i < 12 && !sawMiddle; i += 1) {
    result = reader.check({ since: result.result.cursor });
    sawMiddle = /middle failure/.test(result.result.sources['wh3_mcp_script_errors.log'].content);
  }
  assert.equal(sawMiddle, true, 'bounded polling must eventually consume errors from the previously unread middle');
}));

test('partial UTF-8 across polls is carried forward and CRLF/LF are both handled', async () => withTemp(async (root) => {
  const file = join(root, 'wh3_mcp_script_errors.log');
  await writeFile(file, '');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1' });
  const euro = Buffer.from('€');
  await writeFile(file, Buffer.concat([Buffer.from('line\r\nscript error: '), euro.subarray(0, 2)]));
  const first = reader.check();
  assert.equal(first.result.sources['wh3_mcp_script_errors.log'].cursor.carry_base64.length > 0, true);
  await appendFile(file, Buffer.concat([euro.subarray(2), Buffer.from(' complete\n')]));
  const second = reader.check({ since: first.result.cursor });
  const content = second.result.sources['wh3_mcp_script_errors.log'].content;
  assert.match(content, /€ complete/);
  assert.doesNotMatch(content, /�/);
}));

test('newest script_log filename variation is accepted without timestamp-name assumptions', async () => withTemp(async (root) => {
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1' });
  await writeFile(join(root, 'script_log_custom-format.txt'), 'Error: new failure\n');
  const result = reader.check();
  assert.equal(result.result.has_new_errors, true);
  assert.equal(result.result.sources['script_log_custom-format.txt'].matching_error_count_observed, 1);
}));

test('zero-byte evidence is not reported as a clean run', async () => withTemp(async (root) => {
  await writeFile(join(root, 'wh3_mcp_script_errors.log'), '');
  await writeFile(join(root, 'script_log_zero.txt'), '');
  const reader = new DiagnosticsReader({ rootDir: root, sessionId: 'S1', runId: 'R1' });
  const result = reader.check();
  assert.equal(result.result.has_new_errors, null);
  assert.equal(result.result.evidence_complete, false);
}));
