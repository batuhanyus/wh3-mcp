import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { resolveBeneathRoot } from './wh3-runtime.js';

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_CHARS = 20000;
const ERROR_LINE = /script error|error(:| in )|traceback|assertion|attempt to|stack trace/i;

function stableIdentity(filePath, st) {
  const dev = Number(st.dev ?? 0);
  const ino = Number(st.ino ?? 0);
  if (dev !== 0 || ino !== 0) return `fs:${dev}:${ino}:${st.birthtimeMs ?? 0}`;

  // Some Windows filesystems expose no useful inode. In that case use the
  // creation time plus a short prefix fingerprint. This fallback is less
  // authoritative, so callers still surface rotation/truncation metadata.
  let prefix = '';
  try {
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(128, st.size));
      const got = readSync(fd, buf, 0, buf.length, 0);
      prefix = createHash('sha1').update(buf.subarray(0, got)).digest('hex').slice(0, 16);
    } finally { closeSync(fd); }
  } catch {}
  return `fallback:${st.birthtimeMs ?? 0}:${prefix}`;
}

function utf8CarrySplit(buffer) {
  if (buffer.length === 0) return { complete: buffer, carry: Buffer.alloc(0) };
  const max = Math.min(4, buffer.length);
  for (let back = 1; back <= max; back += 1) {
    const i = buffer.length - back;
    const byte = buffer[i];
    if ((byte & 0xC0) === 0x80) continue;
    let expected = 1;
    if ((byte & 0xE0) === 0xC0) expected = 2;
    else if ((byte & 0xF0) === 0xE0) expected = 3;
    else if ((byte & 0xF8) === 0xF0) expected = 4;
    const available = buffer.length - i;
    if (expected > available) {
      return { complete: buffer.subarray(0, i), carry: buffer.subarray(i) };
    }
    return { complete: buffer, carry: Buffer.alloc(0) };
  }
  return { complete: buffer, carry: Buffer.alloc(0) };
}

function snapshotOne(filePath) {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return { state: 'unavailable', reason: 'not_file' };
    return {
      state: 'available',
      identity: stableIdentity(filePath, st),
      size: st.size,
      mtime_ms: st.mtimeMs,
    };
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'absent' : 'unavailable', reason: error?.code ?? 'IO_FAILURE', error: error?.message };
  }
}

function readRanges(filePath, start, end, maxBytes) {
  const total = Math.max(0, end - start);
  if (total === 0) {
    return { chunks: [], bytesRead: 0, truncated: false, skippedBytes: 0, cursorOffset: start };
  }
  const fd = openSync(filePath, 'r');
  try {
    if (total <= maxBytes) {
      const buf = Buffer.alloc(total);
      const got = readSync(fd, buf, 0, total, start);
      return {
        chunks: [{ start, buffer: buf.subarray(0, got), contiguous: true }],
        bytesRead: got,
        truncated: false,
        skippedBytes: 0,
        cursorOffset: start + got,
      };
    }

    // Read a contiguous head so the returned cursor can make safe forward
    // progress, plus a tail preview so recent errors are still visible. The
    // cursor advances only through the head; unread middle bytes are therefore
    // consumed by later polls instead of being silently skipped.
    const headLen = Math.max(1, Math.floor(maxBytes / 2));
    const tailLen = Math.max(0, maxBytes - headLen);
    const head = Buffer.alloc(headLen);
    const gotHead = readSync(fd, head, 0, headLen, start);
    const chunks = [{ start, buffer: head.subarray(0, gotHead), contiguous: true }];
    let gotTail = 0;
    let tailStart = end;
    if (tailLen > 0) {
      tailStart = Math.max(start + gotHead, end - tailLen);
      const tail = Buffer.alloc(Math.max(0, end - tailStart));
      gotTail = tail.length ? readSync(fd, tail, 0, tail.length, tailStart) : 0;
      if (gotTail > 0) chunks.push({ start: tailStart, buffer: tail.subarray(0, gotTail), contiguous: false });
    }
    return {
      chunks,
      bytesRead: gotHead + gotTail,
      truncated: true,
      skippedBytes: Math.max(0, tailStart - (start + gotHead)),
      cursorOffset: start + gotHead,
    };
  } finally { closeSync(fd); }
}

function compactText(text, maxChars) {
  if (text.length <= maxChars) return { text, output_truncated: false };
  const half = Math.floor(maxChars / 2);
  return {
    text: `${text.slice(0, half)}\n...[output truncated]...\n${text.slice(-half)}`,
    output_truncated: true,
  };
}

export class DiagnosticsReader {
  constructor({
    rootDir,
    sessionId,
    runId = null,
    maxReadBytes = DEFAULT_MAX_READ_BYTES,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    statFile = statSync,
  }) {
    this.rootDir = rootDir;
    this.sessionId = sessionId;
    this.runId = runId;
    this.maxReadBytes = maxReadBytes;
    this.maxOutputChars = maxOutputChars;
    this.statFile = statFile;
    this.baselineAtMs = Date.now();
    this.baseline = new Map();
    this._snapshotRoot();
  }

  _snapshotRoot() {
    if (!this.rootDir) return;
    try {
      for (const name of readdirSync(this.rootDir)) {
        let path;
        try { path = resolveBeneathRoot(this.rootDir, name); } catch { continue; }
        this.baseline.set(name, snapshotOne(path));
      }
    } catch {}
  }

  beginRun(runId) {
    this.runId = runId;
    this.baselineAtMs = Date.now();
    this.baseline.clear();
    this._snapshotRoot();
  }

  _findNewestScriptLog() {
    try {
      const entries = readdirSync(this.rootDir)
        .filter((name) => /^script_log_.+\.txt$/i.test(name))
        .map((name) => {
          const path = resolveBeneathRoot(this.rootDir, name);
          const st = statSync(path);
          return { name, path, mtimeMs: st.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
      return entries[0] ?? null;
    } catch { return null; }
  }

  _normaliseSince(since) {
    if (!since || typeof since !== 'object' || Array.isArray(since)) return { kind: 'baseline', files: {}, warnings: [] };
    if (typeof since.session_id === 'string' && since.files && typeof since.files === 'object') {
      const warnings = [];
      if (since.session_id !== this.sessionId) warnings.push('cursor_session_mismatch');
      if ((since.run_id ?? null) !== (this.runId ?? null)) warnings.push('cursor_run_mismatch');
      return { kind: 'cursor', files: since.files, warnings };
    }
    return { kind: 'legacy', files: since, warnings: ['legacy_offset_cursor_has_no_session_or_file_identity'] };
  }

  _readSource(name, mode, { errorsOnly = false, allLinesAreErrors = false } = {}) {
    let path;
    try { path = resolveBeneathRoot(this.rootDir, name); }
    catch (error) {
      return { name, state: 'rejected', error_code: error.code ?? 'INVALID_PATH', error: error.message, evidence: 'unavailable' };
    }

    let st;
    try {
      st = this.statFile(path);
      if (!st.isFile()) return { name, path, state: 'unavailable', reason: 'not_file', evidence: 'unavailable' };
    } catch (error) {
      return {
        name,
        path,
        state: error?.code === 'ENOENT' ? 'absent' : 'unavailable',
        reason: error?.code ?? 'IO_FAILURE',
        error: error?.message,
        evidence: 'unavailable',
      };
    }

    const identity = stableIdentity(path, st);
    const baseline = this.baseline.get(name);
    const cursorEntry = mode.files?.[name];
    let start = 0;
    let classification = 'indeterminate';
    let rotated = false;
    let truncatedFromCursor = false;
    let carry = Buffer.alloc(0);

    if (mode.kind === 'cursor' && cursorEntry && typeof cursorEntry === 'object') {
      if (cursorEntry.identity && cursorEntry.identity !== identity) {
        rotated = true;
        start = 0;
        classification = 'current-since-rotation';
      } else {
        start = Number.isSafeInteger(cursorEntry.offset) ? cursorEntry.offset : 0;
        if (start > st.size || start < 0) {
          truncatedFromCursor = true;
          start = 0;
        }
        if (typeof cursorEntry.carry_base64 === 'string') {
          try { carry = Buffer.from(cursorEntry.carry_base64, 'base64'); } catch {}
        }
        classification = mode.warnings.length ? 'indeterminate' : 'current-since-cursor';
      }
    } else if (mode.kind === 'legacy') {
      const old = mode.files?.[name];
      start = Number.isFinite(old) ? Number(old) : 0;
      if (start > st.size || start < 0) {
        truncatedFromCursor = true;
        start = 0;
      }
      classification = 'indeterminate';
    } else if (baseline?.state === 'available' && baseline.identity === identity) {
      start = Math.min(baseline.size, st.size);
      classification = 'current-since-baseline';
      if (st.size < baseline.size) {
        start = 0;
        truncatedFromCursor = true;
        classification = 'current-since-truncation';
      }
    } else if (!baseline || baseline.state === 'absent') {
      start = 0;
      classification = 'current-since-baseline';
    } else {
      start = 0;
      rotated = true;
      classification = 'indeterminate';
    }

    let ranges;
    try { ranges = readRanges(path, start, st.size, this.maxReadBytes); }
    catch (error) {
      return { name, path, state: 'unavailable', reason: error?.code ?? 'IO_FAILURE', error: error?.message, evidence: 'unavailable' };
    }

    const decodedParts = [];
    let trailingCarry = Buffer.alloc(0);
    for (let i = 0; i < ranges.chunks.length; i += 1) {
      const chunk = ranges.chunks[i];
      let bytes = chunk.buffer;
      if (chunk.contiguous && carry.length) bytes = Buffer.concat([carry, bytes]);
      const split = utf8CarrySplit(bytes);
      if (chunk.contiguous) trailingCarry = split.carry;
      decodedParts.push(split.complete.toString('utf8'));
    }
    const text = decodedParts.join(ranges.truncated ? '\n...[unread bytes]...\n' : '');
    const lines = text.split(/\r?\n/);
    const matches = allLinesAreErrors
      ? lines.filter((line) => line.trim().length > 0)
      : lines.filter((line) => ERROR_LINE.test(line));
    const content = errorsOnly ? matches.join('\n') : text;
    const compact = compactText(content, this.maxOutputChars);

    return {
      name,
      path,
      state: 'available',
      evidence: classification,
      identity,
      size: st.size,
      mtime_ms: st.mtimeMs,
      start_offset: start,
      next_offset: ranges.cursorOffset,
      rotated,
      size_shrunk: truncatedFromCursor,
      read_bytes: ranges.bytesRead,
      unread_bytes: ranges.skippedBytes,
      read_truncated: ranges.truncated,
      output_truncated: compact.output_truncated,
      matching_error_count_observed: matches.length,
      first_error: matches[0] ?? null,
      last_error: matches.length ? matches[matches.length - 1] : null,
      content: compact.text,
      cursor: {
        offset: ranges.cursorOffset,
        identity,
        size: st.size,
        mtime_ms: st.mtimeMs,
        carry_base64: trailingCarry.length ? trailingCarry.toString('base64') : '',
      },
    };
  }

  check({ extraFiles = [], since = null } = {}) {
    if (!this.rootDir) {
      return {
        status: 'error',
        error: { code: 'WH3_PATH_NOT_FOUND', message: 'WH3 root is unavailable; logs cannot be inspected' },
      };
    }
    const mode = this._normaliseSince(since);
    const sources = {};
    const requested = [{ name: 'wh3_mcp_script_errors.log', errorsOnly: false, allLinesAreErrors: true }];
    const script = this._findNewestScriptLog();
    if (script) requested.push({ name: script.name, errorsOnly: true });
    else sources.script_log = { state: 'absent', evidence: 'unavailable', reason: 'no_matching_script_log' };

    for (const raw of extraFiles.slice(0, 10)) requested.push({ name: String(raw), errorsOnly: false });
    const seen = new Set();
    for (const req of requested) {
      if (seen.has(req.name)) continue;
      seen.add(req.name);
      const source = this._readSource(req.name, mode, req);
      sources[req.name] = source;
    }

    const available = Object.values(sources).filter((s) => s?.state === 'available');
    const unavailable = Object.values(sources).filter((s) => s?.state !== 'available');
    const observedErrors = available.reduce((sum, s) => sum + (s.matching_error_count_observed ?? 0), 0);
    const zeroByteEvidence = available.length > 0 && available.every((s) => s.size === 0);
    const incomplete = available.some((s) => s.read_truncated) || unavailable.length > 0 || mode.warnings.length > 0 || zeroByteEvidence;
    const hasNewErrors = observedErrors > 0 ? true : (incomplete ? null : false);
    const files = {};
    const offsets = {};
    for (const [name, source] of Object.entries(sources)) {
      if (source?.cursor) {
        files[name] = source.cursor;
        offsets[name] = source.cursor.offset;
      }
    }

    return {
      status: 'ok',
      result: {
        session_id: this.sessionId,
        run_id: this.runId,
        baseline_at_ms: this.baselineAtMs,
        has_new_errors: hasNewErrors,
        evidence_complete: !incomplete,
        observed_error_count: observedErrors,
        warnings: [...mode.warnings, ...(zeroByteEvidence ? ['zero_byte_evidence'] : [])],
        sources,
        offsets,
        cursor: { session_id: this.sessionId, run_id: this.runId, files },
        note: 'Prefer cursor as since on the next call. Legacy filename->offset maps remain accepted but are identity/session-indeterminate.',
      },
    };
  }
}
