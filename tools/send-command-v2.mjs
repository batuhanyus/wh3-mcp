#!/usr/bin/env node
// Standalone protocol-v2 helper. Do not run while the WH3-MCP Node server or
// any other controller owns the protocol files.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WH3 = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Total War WARHAMMER III';
const WH3 = resolve(process.env.WH3_INSTALL_DIR?.trim() || process.env.WH3_INSTALL_PATH?.trim() || DEFAULT_WH3);
const CMD = join(WH3, 'wh3_mcp_command.json');
const RES = join(WH3, 'wh3_mcp_result.json');
const QUARANTINE = join(WH3, 'wh3_mcp_quarantine');

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function quarantine(path, reason) {
  if (!existsSync(path)) return null;
  await mkdir(QUARANTINE, { recursive: true });
  const name = `${Date.now()}-${reason}-${basename(path)}-${randomBytes(3).toString('hex')}`;
  const destination = join(QUARANTINE, name);
  await rename(path, destination);
  return destination;
}

async function atomicPublish(path, value) {
  if (existsSync(path)) {
    throw new Error(`${basename(path)} already exists; another controller may be active`);
  }
  const temp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await writeFile(temp, JSON.stringify(value), 'utf8');
  try {
    await rename(temp, path);
  } catch (error) {
    try { await quarantine(temp, 'publish-failed'); } catch {}
    throw error;
  }
}

async function waitForReply(request, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(RES)) {
      await sleep(200);
      continue;
    }

    let reply;
    try {
      reply = JSON.parse(await readFile(RES, 'utf8'));
    } catch {
      await quarantine(RES, 'invalid-json');
      continue;
    }

    if (reply?.protocol !== 2 || reply?.session_id !== request.session_id || reply?.request_id !== request.request_id) {
      await quarantine(RES, 'stale-or-mismatched');
      continue;
    }

    await quarantine(RES, 'consumed');
    return reply;
  }

  // If Lua never consumed the command, quarantine our own unpublished work so
  // it cannot execute unexpectedly after this helper exits. If it was consumed,
  // the outcome is ambiguous and must not be retried automatically.
  let commandStillPending = false;
  if (existsSync(CMD)) {
    commandStillPending = true;
    await quarantine(CMD, 'timed-out-unconsumed-command');
  }
  const error = new Error(`request ${request.request_id} timed out after ${timeoutMs} ms`);
  error.code = 'COMMAND_TIMEOUT';
  error.outcome = commandStillPending ? 'not_accepted' : 'unknown';
  throw error;
}

export async function sendStandaloneCommand(command, params = {}, { timeoutMs = 30000 } = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('command must be a non-empty string');
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('params must be a JSON object');
  if (!existsSync(WH3)) throw new Error(`WH3 install directory does not exist: ${WH3}`);

  if (existsSync(CMD)) throw new Error(`${basename(CMD)} already exists; refuse to compete with another controller`);
  if (existsSync(RES)) await quarantine(RES, 'preflight-stale-result');

  const sessionId = `helper-${Date.now()}-${process.pid}-${randomBytes(5).toString('hex')}`;
  const startedAt = Date.now();
  const handshake = {
    protocol: 2,
    session_id: sessionId,
    request_id: 1,
    command: '__handshake',
    params: { server_started_at_ms: startedAt },
  };
  await atomicPublish(CMD, handshake);
  const hello = await waitForReply(handshake, timeoutMs);
  if (hello.status !== 'ok' || hello.result?.ready !== true) {
    throw new Error(`protocol-v2 handshake failed: ${JSON.stringify(hello)}`);
  }

  const request = {
    protocol: 2,
    session_id: sessionId,
    request_id: 2,
    command,
    params,
  };
  await atomicPublish(CMD, request);
  return waitForReply(request, timeoutMs);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    // Avoid a sync fs dependency in the library path; CLI JSON-file reading stays here.
    let args = process.argv.slice(2);
    let logical;
    let timeoutMs = 30000;
    if (args[0] === '--json-file') {
      if (!args[1]) throw new Error('--json-file requires a path');
      logical = JSON.parse(await readFile(args[1], 'utf8'));
      if (args[2]) timeoutMs = Number(args[2]) * 1000;
    } else if (args[0] === '--json') {
      if (!args[1]) throw new Error('--json requires a JSON string');
      logical = JSON.parse(args[1]);
      if (args[2]) timeoutMs = Number(args[2]) * 1000;
    } else {
      throw new Error('usage: node send-command-v2.mjs --json-file command.json [timeout_s]');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeout must be positive');
    const reply = await sendStandaloneCommand(logical.command, logical.params ?? {}, { timeoutMs });
    console.log(JSON.stringify(reply));
    process.exit(reply.status === 'ok' ? 0 : 1);
  } catch (error) {
    console.error(JSON.stringify({
      status: 'error',
      error: { code: error.code ?? 'HELPER_FAILURE', message: error.message, outcome: error.outcome },
    }));
    process.exit(1);
  }
}
