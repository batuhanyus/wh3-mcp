#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const LUA = join(ROOT, 'pack', 'script', '_lib', 'mod', 'wh3_mcp.lua');
const LUA_FIXTURE = join(ROOT, 'server', 'test', 'fixtures', 'lua_poll_bootstrap_harness.lua');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, command, args, options = {}) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (options.capture && result.stdout) process.stdout.write(result.stdout);
  if (options.capture && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label}: exited ${result.status}`);
}

async function collectJs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectJs(path));
    else if (['.js', '.mjs', '.cjs'].includes(extname(entry.name))) out.push(path);
  }
  return out;
}

function findLuac() {
  const explicit = process.env.WH3_LUAC?.trim();
  const candidates = explicit ? [explicit] : ['luac', 'luac5.5', 'luac55', 'luac5.4', 'luac5.1'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-p', LUA], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('Lua compiler not found. Install luac or set WH3_LUAC to the compiler executable. The offline gate does not silently skip Lua syntax.');
}

try {
  const syntaxFiles = [...await collectJs(join(ROOT, 'server')), ...await collectJs(join(ROOT, 'tools'))].sort();
  console.log(`Checking JavaScript syntax in ${syntaxFiles.length} files...`);
  for (const file of syntaxFiles) run(`node --check ${file.slice(ROOT.length + 1)}`, process.execPath, ['--check', file]);

  run('Node regression/integration tests', npmCommand, ['test'], { cwd: SERVER });
  run('Packaging/protocol consistency', process.execPath, [join(ROOT, 'tools', 'verify-package.mjs')]);

  const luac = findLuac();
  run('Lua bridge syntax', luac, ['-p', LUA]);
  run('Lua bootstrap fixture syntax', luac, ['-p', LUA_FIXTURE]);

  console.log('\nOFFLINE GATE PASSED');
} catch (error) {
  console.error(`\nOFFLINE GATE FAILED: ${error.message}`);
  process.exit(1);
}
