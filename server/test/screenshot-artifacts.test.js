import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScreenshotArtifactManager,
  convertTgaFile,
  parseTga,
  readPngDimensions,
} from '../lib/screenshot-artifacts.js';

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wh3-mcp-shot-test-'));
  const artifacts = await mkdtemp(join(tmpdir(), 'wh3-mcp-shot-artifacts-'));
  try { await fn(root, artifacts); }
  finally {
    await rm(root, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
}

function tga24(width, height, rgbRowsTopDown, { topOrigin = true } = {}) {
  const header = Buffer.alloc(18);
  header[2] = 2;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 24;
  header[17] = topOrigin ? 0x20 : 0;
  const rows = topOrigin ? rgbRowsTopDown : [...rgbRowsTopDown].reverse();
  const pixels = [];
  for (const row of rows) {
    for (const [r, g, b] of row) pixels.push(b, g, r);
  }
  return Buffer.concat([header, Buffer.from(pixels)]);
}

function fakeClock() {
  let time = 10_000;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
  };
}

test('synthetic TGA converts to a verified PNG with matching dimensions', async () => withTemp(async (root, artifacts) => {
  const source = join(root, 'fixture.tga');
  const output = join(artifacts, 'fixture.png');
  await writeFile(source, tga24(2, 2, [
    [[255, 0, 0], [0, 255, 0]],
    [[0, 0, 255], [255, 255, 255]],
  ]));
  const result = await convertTgaFile(source, output);
  assert.deepEqual({ width: result.width, height: result.height }, { width: 2, height: 2 });
  const png = await readFile(output);
  assert.deepEqual(readPngDimensions(png), { width: 2, height: 2 });
  assert.equal(result.source_sha256.length, 64);
  assert.equal(result.png_sha256.length, 64);
}));

test('malformed and truncated TGAs fail with typed parser errors', () => {
  assert.throws(() => parseTga(Buffer.alloc(4)), (error) => error.code === 'MALFORMED_TGA');
  const truncated = Buffer.alloc(18);
  truncated[2] = 2;
  truncated.writeUInt16LE(2, 12);
  truncated.writeUInt16LE(2, 14);
  truncated[16] = 24;
  assert.throws(() => parseTga(truncated), (error) => error.code === 'MALFORMED_TGA');
  const unsupported = Buffer.alloc(18);
  unsupported[2] = 1;
  unsupported.writeUInt16LE(1, 12);
  unsupported.writeUInt16LE(1, 14);
  unsupported[16] = 24;
  assert.throws(() => parseTga(unsupported), (error) => error.code === 'UNSUPPORTED_TGA');
});

test('fresh capture uses unique correlated filenames and returns inline PNG bytes', async () => withTemp(async (root, artifacts) => {
  let colour = 10;
  const manager = new ScreenshotArtifactManager({
    rootDir: root,
    sourceRepoRoot: join(root, 'not-the-artifact-root'),
    artifactDir: artifacts,
    sessionId: 'server-session-1',
    getRunId: () => 'run-1',
    isGameRunning: () => true,
    sendCommand: async (command, params) => {
      assert.equal(command, 'take_screenshot');
      await writeFile(join(root, params.filename), tga24(1, 1, [[[colour++, 0, 0]]]));
      return { status: 'ok', result: { filename: params.filename } };
    },
  });
  const a = await manager.capture({ filename: 'wh3_mcp_screenshot.tga' });
  const b = await manager.capture({ filename: 'wh3_mcp_screenshot.tga' });
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.notEqual(a.result.source.filename, b.result.source.filename);
  assert.match(a.result.source.filename, /server-session-1/);
  assert.match(a.result.source.filename, /run-1/);
  assert.equal(a.result.artifact.inline, true);
  assert.ok(Buffer.isBuffer(a.result._png));
  assert.notEqual(a.result.source.sha256, b.result.source.sha256);
}));

test('a stale file with the legacy requested name cannot satisfy a fresh capture', async () => withTemp(async (root, artifacts) => {
  await writeFile(join(root, 'legacy.tga'), tga24(1, 1, [[[1, 2, 3]]]));
  const clock = fakeClock();
  const manager = new ScreenshotArtifactManager({
    rootDir: root,
    artifactDir: artifacts,
    sessionId: 's1',
    getRunId: () => 'r1',
    isGameRunning: () => true,
    sendCommand: async () => ({ status: 'ok', result: { filename: 'legacy.tga' } }),
    captureTimeoutMs: 500,
    now: clock.now,
    sleep: clock.sleep,
  });
  const result = await manager.capture({ filename: 'legacy.tga', timeout_ms: 500 });
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'SCREENSHOT_MISSING');
}));

test('process death while waiting is distinct from a missing screenshot', async () => withTemp(async (root, artifacts) => {
  const clock = fakeClock();
  let running = true;
  const manager = new ScreenshotArtifactManager({
    rootDir: root,
    artifactDir: artifacts,
    sessionId: 's1',
    getRunId: () => 'r1',
    isGameRunning: () => running,
    sendCommand: async () => { running = false; return { status: 'ok', result: {} }; },
    captureTimeoutMs: 500,
    now: clock.now,
    sleep: clock.sleep,
  });
  const result = await manager.capture({ timeout_ms: 500 });
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'PROCESS_EXITED');
}));

test('conversion errors preserve source evidence instead of pretending bytes are PNG', async () => withTemp(async (root, artifacts) => {
  const manager = new ScreenshotArtifactManager({
    rootDir: root,
    artifactDir: artifacts,
    sessionId: 's1',
    getRunId: () => 'r1',
    isGameRunning: () => true,
    sendCommand: async (_command, params) => {
      await writeFile(join(root, params.filename), Buffer.from('not a tga but nonzero'));
      return { status: 'ok', result: {} };
    },
  });
  const result = await manager.capture();
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'CONVERSION_ERROR');
  assert.equal(result.source.sha256.length, 64);
}));
