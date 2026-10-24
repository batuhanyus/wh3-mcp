import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

export const SCREENSHOT_LIMITS = Object.freeze({
  minTimeoutMs: 500,
  maxTimeoutMs: 30000,
  defaultTimeoutMs: 10000,
  stablePollMs: 75,
  stableSamples: 2,
  maxSourceBytes: 128 * 1024 * 1024,
  maxPngBytes: 64 * 1024 * 1024,
  maxInlineBytes: 8 * 1024 * 1024,
  maxPixels: 40_000_000,
  defaultRetentionMs: 24 * 60 * 60 * 1000,
  maxRetainedFiles: 200,
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function safeSegment(value, fallback = 'unknown') {
  const text = String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return (text || fallback).slice(0, 72);
}

function ensureOutsideRoot(candidate, forbiddenRoot) {
  const root = resolve(forbiddenRoot);
  const path = resolve(candidate);
  const rel = relative(root, path);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    const error = new Error('artifact directory must not be inside the source repository');
    error.code = 'INVALID_ARTIFACT_DIRECTORY';
    throw error;
  }
  return path;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

export function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw Object.assign(new Error('invalid PNG signature'), { code: 'INVALID_PNG' });
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw Object.assign(new Error('PNG is missing IHDR'), { code: 'INVALID_PNG' });
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) throw Object.assign(new Error('PNG dimensions are invalid'), { code: 'INVALID_PNG' });
  return { width, height };
}

export function parseTga(buffer, { maxPixels = SCREENSHOT_LIMITS.maxPixels } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 18) throw Object.assign(new Error('TGA header is truncated'), { code: 'MALFORMED_TGA' });
  const idLength = buffer[0];
  const colourMapType = buffer[1];
  const imageType = buffer[2];
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const bpp = buffer[16];
  const descriptor = buffer[17];
  if (colourMapType !== 0) throw Object.assign(new Error('colour-mapped TGA is unsupported'), { code: 'UNSUPPORTED_TGA' });
  if (![2, 10].includes(imageType)) throw Object.assign(new Error(`TGA image type ${imageType} is unsupported`), { code: 'UNSUPPORTED_TGA' });
  if (![24, 32].includes(bpp)) throw Object.assign(new Error(`TGA pixel depth ${bpp} is unsupported`), { code: 'UNSUPPORTED_TGA' });
  if (!width || !height || width * height > maxPixels) throw Object.assign(new Error('TGA dimensions exceed safe limits'), { code: 'IMAGE_TOO_LARGE' });
  const bytesPerPixel = bpp / 8;
  let offset = 18 + idLength;
  if (offset > buffer.length) throw Object.assign(new Error('TGA image id is truncated'), { code: 'MALFORMED_TGA' });
  const pixelCount = width * height;
  const pixels = Buffer.allocUnsafe(pixelCount * 4);
  let decoded = 0;

  const writePixel = (sourceOffset) => {
    if (sourceOffset + bytesPerPixel > buffer.length) throw Object.assign(new Error('TGA pixel data is truncated'), { code: 'MALFORMED_TGA' });
    const b = buffer[sourceOffset];
    const g = buffer[sourceOffset + 1];
    const r = buffer[sourceOffset + 2];
    const a = bytesPerPixel === 4 ? buffer[sourceOffset + 3] : 255;
    const xFile = decoded % width;
    const yFile = Math.floor(decoded / width);
    const topOrigin = (descriptor & 0x20) !== 0;
    const rightOrigin = (descriptor & 0x10) !== 0;
    const x = rightOrigin ? width - 1 - xFile : xFile;
    const y = topOrigin ? yFile : height - 1 - yFile;
    const target = (y * width + x) * 4;
    pixels[target] = r;
    pixels[target + 1] = g;
    pixels[target + 2] = b;
    pixels[target + 3] = a;
    decoded += 1;
  };

  if (imageType === 2) {
    const needed = pixelCount * bytesPerPixel;
    if (offset + needed > buffer.length) throw Object.assign(new Error('TGA pixel data is truncated'), { code: 'MALFORMED_TGA' });
    while (decoded < pixelCount) {
      writePixel(offset);
      offset += bytesPerPixel;
    }
  } else {
    while (decoded < pixelCount) {
      if (offset >= buffer.length) throw Object.assign(new Error('TGA RLE packet is truncated'), { code: 'MALFORMED_TGA' });
      const packet = buffer[offset++];
      const count = (packet & 0x7f) + 1;
      if (decoded + count > pixelCount) throw Object.assign(new Error('TGA RLE packet exceeds image bounds'), { code: 'MALFORMED_TGA' });
      if (packet & 0x80) {
        const pixelOffset = offset;
        if (pixelOffset + bytesPerPixel > buffer.length) throw Object.assign(new Error('TGA RLE pixel is truncated'), { code: 'MALFORMED_TGA' });
        for (let i = 0; i < count; i += 1) writePixel(pixelOffset);
        offset += bytesPerPixel;
      } else {
        for (let i = 0; i < count; i += 1) {
          writePixel(offset);
          offset += bytesPerPixel;
        }
      }
    }
  }

  return { width, height, pixels, image_type: imageType, bits_per_pixel: bpp };
}

export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new TypeError('invalid PNG dimensions');
  if (!Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) throw new TypeError('RGBA buffer size does not match dimensions');
  const rowBytes = width * 4;
  const raw = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (rowBytes + 1);
    raw[target] = 0;
    rgba.copy(raw, target + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writeAtomic(path, bytes) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, bytes, { flag: 'wx' });
  try { await rename(temp, path); }
  catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function probeTgaHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 18) return { width: null, height: null, bits_per_pixel: null, image_type: null };
  return {
    width: buffer.readUInt16LE(12) || null,
    height: buffer.readUInt16LE(14) || null,
    bits_per_pixel: buffer[16] || null,
    image_type: buffer[2] || null,
  };
}

export async function convertTgaFile(sourcePath, outputPath, limits = {}) {
  const maxSourceBytes = limits.maxSourceBytes ?? SCREENSHOT_LIMITS.maxSourceBytes;
  const maxPngBytes = limits.maxPngBytes ?? SCREENSHOT_LIMITS.maxPngBytes;
  const st = await stat(sourcePath);
  if (!st.isFile() || st.size <= 0) throw Object.assign(new Error('TGA source is empty'), { code: 'MALFORMED_TGA' });
  if (st.size > maxSourceBytes) throw Object.assign(new Error('TGA source exceeds size limit'), { code: 'IMAGE_TOO_LARGE' });
  const source = await readFile(sourcePath);
  const decoded = parseTga(source, limits);
  const png = encodePng(decoded.width, decoded.height, decoded.pixels);
  if (png.length > maxPngBytes) throw Object.assign(new Error('PNG artifact exceeds size limit'), { code: 'IMAGE_TOO_LARGE' });
  const verified = readPngDimensions(png);
  if (verified.width !== decoded.width || verified.height !== decoded.height) throw Object.assign(new Error('PNG dimension verification failed'), { code: 'CONVERSION_ERROR' });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeAtomic(outputPath, png);
  return {
    width: decoded.width,
    height: decoded.height,
    tga_image_type: decoded.image_type,
    bits_per_pixel: decoded.bits_per_pixel,
    source_sha256: sha256(source),
    png_sha256: sha256(png),
    png_bytes: png.length,
    png,
  };
}

async function waitForStableFile(path, { timeoutMs, pollMs, stableSamples, isRunning, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const started = now();
  let seen = false;
  let stable = 0;
  let previous = null;
  while (now() - started <= timeoutMs) {
    if (isRunning && !isRunning()) return { ok: false, code: 'PROCESS_EXITED', seen };
    try {
      const current = await stat(path);
      if (current.isFile() && current.size > 0) {
        seen = true;
        const signature = `${current.size}:${current.mtimeMs}`;
        stable = signature === previous ? stable + 1 : 1;
        previous = signature;
        if (stable >= stableSamples) return { ok: true, stat: current };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, code: 'SCREENSHOT_IO_ERROR', error };
    }
    await sleep(pollMs);
  }
  return { ok: false, code: seen ? 'SCREENSHOT_TIMEOUT' : 'SCREENSHOT_MISSING', seen };
}

async function cleanupOldArtifacts(root, { now = Date.now, retentionMs = SCREENSHOT_LIMITS.defaultRetentionMs, maxFiles = SCREENSHOT_LIMITS.maxRetainedFiles } = {}) {
  let entries = [];
  const walk = async (dir) => {
    let children;
    try { children = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      const path = join(dir, child.name);
      if (child.isDirectory()) await walk(path);
      else if (child.isFile()) {
        try { const st = await stat(path); entries.push({ path, mtimeMs: st.mtimeMs }); } catch {}
      }
    }
  };
  await walk(root);
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const expiredBefore = now() - retentionMs;
  for (let i = 0; i < entries.length; i += 1) {
    if (i >= maxFiles || entries[i].mtimeMs < expiredBefore) await rm(entries[i].path, { force: true }).catch(() => {});
  }
}

export class ScreenshotArtifactManager {
  constructor({
    rootDir,
    sourceRepoRoot,
    sessionId,
    getRunId = () => null,
    isGameRunning = () => true,
    sendCommand,
    artifactDir = process.env.WH3_MCP_ARTIFACT_DIR || join(tmpdir(), 'wh3-mcp-artifacts'),
    inlineLimitBytes = SCREENSHOT_LIMITS.maxInlineBytes,
    captureTimeoutMs = SCREENSHOT_LIMITS.defaultTimeoutMs,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    this.rootDir = rootDir ? resolve(rootDir) : null;
    this.sessionId = sessionId;
    this.getRunId = getRunId;
    this.isGameRunning = isGameRunning;
    this.sendCommand = sendCommand;
    this.now = now;
    this.sleep = sleep;
    this.inlineLimitBytes = clampInt(inlineLimitBytes, 64 * 1024, SCREENSHOT_LIMITS.maxPngBytes, SCREENSHOT_LIMITS.maxInlineBytes);
    this.captureTimeoutMs = clampInt(captureTimeoutMs, SCREENSHOT_LIMITS.minTimeoutMs, SCREENSHOT_LIMITS.maxTimeoutMs, SCREENSHOT_LIMITS.defaultTimeoutMs);
    try {
      this.artifactDir = sourceRepoRoot ? ensureOutsideRoot(artifactDir, sourceRepoRoot) : resolve(artifactDir);
      this.configurationError = null;
    } catch (error) {
      this.artifactDir = resolve(artifactDir);
      this.configurationError = error;
    }
  }

  async capture(args = {}) {
    if (this.configurationError) return { status: 'error', error: { code: this.configurationError.code, message: this.configurationError.message } };
    if (!this.rootDir) return { status: 'error', error: { code: 'WH3_PATH_NOT_FOUND', message: 'WH3 root is unavailable' } };
    if (!this.isGameRunning()) return { status: 'error', error: { code: 'PROCESS_EXITED', message: 'WH3 is not running' } };
    const requested = String(args.filename ?? 'wh3_mcp_screenshot.tga');
    if (basename(requested) !== requested) return { status: 'error', error: { code: 'INVALID_FILENAME', message: 'screenshot filename must be a basename, not a path' } };
    const ext = extname(requested).toLowerCase();
    const requestedStem = safeSegment(requested.slice(0, requested.length - (ext ? ext.length : 0)), 'wh3_mcp_screenshot');
    const captureId = `capture-${this.now()}-${randomUUID()}`;
    const runId = safeSegment(this.getRunId() ?? 'external', 'external');
    const session = safeSegment(this.sessionId, 'session');
    const sourceFilename = `${requestedStem}-${session}-${runId}-${safeSegment(captureId)}.tga`;
    const sourcePath = join(this.rootDir, sourceFilename);
    const artifactSubdir = join(this.artifactDir, session, runId);
    const pngPath = join(artifactSubdir, `${captureId}.png`);
    const requestedAtMs = this.now();
    await mkdir(artifactSubdir, { recursive: true });
    await cleanupOldArtifacts(this.artifactDir, { now: this.now }).catch(() => {});

    const ack = await this.sendCommand('take_screenshot', { filename: sourceFilename }, Math.min(this.captureTimeoutMs, 15000));
    if (ack?.status !== 'ok') {
      const upstream = ack?.error?.code ?? 'SCREENSHOT_COMMAND_FAILED';
      const code = upstream === 'GAME_EXITED' ? 'PROCESS_EXITED' : 'SCREENSHOT_COMMAND_FAILED';
      return { status: 'error', error: { code, message: 'game screenshot command failed', upstream: ack?.error ?? ack }, capture_id: captureId };
    }

    const stable = await waitForStableFile(sourcePath, {
      timeoutMs: clampInt(args.timeout_ms, SCREENSHOT_LIMITS.minTimeoutMs, SCREENSHOT_LIMITS.maxTimeoutMs, this.captureTimeoutMs),
      pollMs: SCREENSHOT_LIMITS.stablePollMs,
      stableSamples: SCREENSHOT_LIMITS.stableSamples,
      isRunning: this.isGameRunning,
      now: this.now,
      sleep: this.sleep,
    });
    if (!stable.ok) {
      return {
        status: 'error',
        error: {
          code: stable.code,
          message: stable.code === 'SCREENSHOT_MISSING'
            ? 'game acknowledged capture but no fresh screenshot file appeared before the deadline'
            : stable.code === 'PROCESS_EXITED' ? 'WH3 exited while waiting for screenshot output'
              : 'screenshot file did not become stable before the deadline',
        },
        capture_id: captureId,
        source_filename: sourceFilename,
      };
    }

    const sourceStat = stable.stat;
    let converted;
    try {
      converted = await convertTgaFile(sourcePath, pngPath);
    } catch (error) {
      const source = await readFile(sourcePath).catch(() => null);
      const header = source ? probeTgaHeader(source) : probeTgaHeader(null);
      return {
        status: 'error',
        error: { code: error?.code === 'IMAGE_TOO_LARGE' ? 'IMAGE_TOO_LARGE' : 'CONVERSION_ERROR', message: error?.message ?? String(error) },
        capture_id: captureId,
        source: {
          filename: sourceFilename,
          path: sourcePath,
          bytes: sourceStat.size,
          created_ms: sourceStat.birthtimeMs,
          modified_ms: sourceStat.mtimeMs,
          sha256: source ? sha256(source) : null,
          ...header,
        },
      };
    }

    const inline = converted.png.length <= this.inlineLimitBytes;
    return {
      status: 'ok',
      result: {
        capture_id: captureId,
        session_id: this.sessionId,
        run_id: this.getRunId() ?? null,
        requested_at_ms: requestedAtMs,
        source: {
          filename: sourceFilename,
          path: sourcePath,
          bytes: sourceStat.size,
          created_ms: sourceStat.birthtimeMs,
          modified_ms: sourceStat.mtimeMs,
          sha256: converted.source_sha256,
          width: converted.width,
          height: converted.height,
          bits_per_pixel: converted.bits_per_pixel,
          image_type: converted.tga_image_type,
        },
        artifact: {
          format: 'png',
          mime_type: 'image/png',
          path: pngPath,
          relative_path: relative(this.artifactDir, pngPath).replaceAll('\\', '/'),
          bytes: converted.png_bytes,
          sha256: converted.png_sha256,
          width: converted.width,
          height: converted.height,
          inline,
          inline_limit_bytes: this.inlineLimitBytes,
        },
        converter: 'built-in Node TGA(24/32-bit true-colour, raw/RLE) -> PNG converter',
        _png: converted.png,
      },
    };
  }
}

export function redactLocalPath(value) {
  if (typeof value !== 'string') return value;
  let text = value;
  const home = homedir();
  if (home) text = text.replaceAll(home, '~');
  text = text.replace(/([A-Za-z]:\\Users\\)[^\\/]+/gi, '$1<user>');
  text = text.replace(/(\/home\/)[^/]+/g, '$1<user>');
  return text;
}
