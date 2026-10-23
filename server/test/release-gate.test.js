import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackaging } from '../../tools/verify-package.mjs';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SERVER_ROOT, '..');

async function withPackageFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wh3-mcp-package-gate-'));
  try {
    await cp(join(REPO_ROOT, 'pack'), join(root, 'pack'), { recursive: true });
    await cp(join(REPO_ROOT, 'server', 'lib', 'protocol-v2.js'), join(root, 'server', 'lib', 'protocol-v2.js'), { recursive: true });
    await cp(join(REPO_ROOT, 'build.ps1'), join(root, 'build.ps1'));
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('release packaging gate accepts the checked-in protocol/hash payload', async () => {
  const result = await verifyPackaging(REPO_ROOT);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('release packaging gate fails on manifest/server protocol mismatch', async () => withPackageFixture(async (root) => {
  const path = join(root, 'pack', 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.protocol = manifest.protocol + 1;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = await verifyPackaging(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((line) => line.includes('protocol mismatch')));
}));

test('release packaging gate fails when the shipped Lua source drifts from its manifest hash', async () => withPackageFixture(async (root) => {
  const path = join(root, 'pack', 'script', '_lib', 'mod', 'wh3_mcp.lua');
  await writeFile(path, `${await readFile(path, 'utf8')}\n-- deliberate test drift\n`, 'utf8');

  const result = await verifyPackaging(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((line) => line.includes('Lua bridge hash mismatch')));
}));

test('release packaging gate rejects generated credential/runtime artefacts from archive inputs', async () => withPackageFixture(async (root) => {
  await writeFile(join(root, '.env'), 'TOKEN=fixture-secret\n', 'utf8');
  const result = await verifyPackaging(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((line) => line.includes('generated credential/runtime artefact')));
}));
