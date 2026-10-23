#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(THIS_DIR, '..');

async function readText(path) {
  return readFile(path, 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function walk(root, dir = root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(root, path));
    else out.push(path);
  }
  return out;
}

function parseVersion(text, label, errors) {
  const match = text.match(/\bPROTOCOL_VERSION\s*=\s*(\d+)\b/);
  if (!match) {
    errors.push(`${label}: PROTOCOL_VERSION constant not found`);
    return null;
  }
  return Number(match[1]);
}

export async function verifyPackaging(root = DEFAULT_ROOT) {
  root = resolve(root);
  const errors = [];
  const info = [];
  const manifestPath = join(root, 'pack', 'manifest.json');
  const luaPath = join(root, 'pack', 'script', '_lib', 'mod', 'wh3_mcp.lua');
  const readmePath = join(root, 'pack', 'readme.txt');
  const protocolPath = join(root, 'server', 'lib', 'protocol-v2.js');
  const buildPath = join(root, 'build.ps1');

  for (const path of [manifestPath, luaPath, readmePath, protocolPath, buildPath]) {
    if (!existsSync(path)) errors.push(`missing required packaging input: ${relative(root, path)}`);
  }
  if (errors.length) return { ok: false, errors, info };

  let manifest;
  try {
    manifest = JSON.parse(await readText(manifestPath));
  } catch (error) {
    return { ok: false, errors: [`pack/manifest.json is invalid JSON: ${error.message}`], info };
  }

  const [lua, packReadme, protocol, build] = await Promise.all([
    readText(luaPath), readText(readmePath), readText(protocolPath), readText(buildPath),
  ]);

  const luaProtocol = parseVersion(lua, 'Lua bridge', errors);
  const serverProtocol = parseVersion(protocol, 'Node protocol', errors);
  if (!Number.isInteger(manifest.protocol)) errors.push('pack/manifest.json protocol must be an integer');
  if (serverProtocol !== null && luaProtocol !== null && serverProtocol !== luaProtocol) {
    errors.push(`protocol mismatch: server=${serverProtocol}, lua=${luaProtocol}`);
  }
  if (serverProtocol !== null && manifest.protocol !== serverProtocol) {
    errors.push(`protocol mismatch: manifest=${manifest.protocol}, server=${serverProtocol}`);
  }

  const luaHash = sha256(lua);
  const readmeHash = sha256(packReadme);
  if (!/^[a-f0-9]{64}$/.test(manifest.lua_sha256 ?? '')) {
    errors.push('pack/manifest.json lua_sha256 must be a lowercase SHA-256 hex digest');
  } else if (manifest.lua_sha256 !== luaHash) {
    errors.push(`Lua bridge hash mismatch: manifest=${manifest.lua_sha256}, actual=${luaHash}`);
  }

  if (!/^[a-f0-9]{64}$/.test(manifest.readme_sha256 ?? '')) {
    errors.push('pack/manifest.json readme_sha256 must be a lowercase SHA-256 hex digest');
  } else if (manifest.readme_sha256 !== readmeHash) {
    errors.push(`Pack readme hash mismatch: manifest=${manifest.readme_sha256}, actual=${readmeHash}`);
  }

  if (manifest.lua_bridge !== 'script/_lib/mod/wh3_mcp.lua') {
    errors.push('pack/manifest.json lua_bridge must be script/_lib/mod/wh3_mcp.lua');
  }
  if (manifest.pack_name !== 'wh3_mcp_server.pack') {
    errors.push('pack/manifest.json pack_name must be wh3_mcp_server.pack');
  }

  if (!/protocol v2/i.test(packReadme) || !/"protocol"\s*:\s*2/.test(packReadme)) {
    errors.push('pack/readme.txt must document the protocol v2 envelope explicitly');
  }
  for (const stale of [
    'Delete the result file before sending',
    'Everything reduces to one function:',
  ]) {
    if (packReadme.includes(stale)) errors.push(`pack/readme.txt still contains obsolete v1 guidance: ${stale}`);
  }

  const requiredBuildFragments = [
    'pack\\script\\_lib\\mod\\wh3_mcp.lua',
    'pack\\readme.txt',
    'pack\\manifest.json',
    'script/_lib/mod/wh3_mcp.lua',
    'readme.txt',
    'manifest.json',
    'verify-package.mjs',
  ];
  for (const fragment of requiredBuildFragments) {
    if (!build.includes(fragment)) errors.push(`build.ps1 does not package/verify required payload fragment: ${fragment}`);
  }

  const packFiles = (await walk(join(root, 'pack'))).map((p) => relative(join(root, 'pack'), p).replaceAll('\\', '/')).sort();
  const expectedPackFiles = ['manifest.json', 'readme.txt', 'script/_lib/mod/wh3_mcp.lua'];
  if (JSON.stringify(packFiles) !== JSON.stringify(expectedPackFiles)) {
    errors.push(`pack/ contains unexpected or missing ship files: ${packFiles.join(', ')}`);
  }

  const allFiles = await walk(root);
  const bannedNames = /(^|[\\/])(?:\.env(?:\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|wh3_mcp_(?:command|result)\.json|wh3_mcp_.*\.marker|wh3_mcp_.*\.log)$/i;
  for (const path of allFiles) {
    const rel = relative(root, path).replaceAll('\\', '/');
    if (rel.startsWith('server/test/')) continue;
    if (bannedNames.test(rel)) errors.push(`generated credential/runtime artefact must not ship in repository/archive: ${rel}`);
  }

  const leakPatterns = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key material'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
    [/[A-Za-z]:\\Users\\[^\\\r\n]+\\AppData\\Local\\Temp\\/i, 'generated Windows temp path'],
    [/(?:^|[\s"'])\/tmp\/[A-Za-z0-9_.-]+\//m, 'generated POSIX temp path'],
  ];
  for (const path of [luaPath, readmePath, protocolPath]) {
    const text = await readText(path);
    for (const [pattern, label] of leakPatterns) {
      if (pattern.test(text)) errors.push(`${relative(root, path)} contains ${label}`);
    }
  }

  info.push(`protocol=${serverProtocol ?? 'unknown'}`);
  info.push(`lua_sha256=${luaHash}`);
  info.push(`readme_sha256=${readmeHash}`);
  info.push(`pack_source_files=${packFiles.length}`);
  return { ok: errors.length === 0, errors, info };
}

function parseRootArg(argv) {
  const index = argv.indexOf('--root');
  if (index === -1) return DEFAULT_ROOT;
  if (!argv[index + 1]) throw new Error('--root requires a path');
  return resolve(argv[index + 1]);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = await verifyPackaging(parseRootArg(process.argv.slice(2)));
    if (!result.ok) {
      console.error('PACKAGING CHECK FAILED');
      for (const error of result.errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log('PACKAGING CHECK PASSED');
    for (const line of result.info) console.log(`- ${line}`);
  } catch (error) {
    console.error(`PACKAGING CHECK FAILED: ${error.message}`);
    process.exit(1);
  }
}
