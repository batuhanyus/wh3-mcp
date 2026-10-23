// Standalone protocol-v2 eval helper. Do not run while the WH3-MCP Node server
// or another controller is active.
// Usage: node send-eval.mjs <file.lua> [timeout_s]
//        node send-eval.mjs --cmd <logical-command.json> [timeout_s]
import { readFile } from 'node:fs/promises';
import { sendStandaloneCommand } from './send-command-v2.mjs';

try {
  let logical;
  let timeoutS;
  if (process.argv[2] === '--cmd') {
    if (!process.argv[3]) throw new Error('--cmd requires a JSON file');
    logical = JSON.parse(await readFile(process.argv[3], 'utf8'));
    timeoutS = Number(process.argv[4] ?? 30);
  } else {
    if (!process.argv[2]) throw new Error('usage: node send-eval.mjs <file.lua> [timeout_s]');
    const code = await readFile(process.argv[2], 'utf8');
    logical = { command: 'eval', params: { code } };
    timeoutS = Number(process.argv[3] ?? 30);
  }
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error('timeout must be positive');
  const reply = await sendStandaloneCommand(logical.command, logical.params ?? {}, { timeoutMs: timeoutS * 1000 });
  console.log(JSON.stringify(reply));
  process.exit(reply.status === 'ok' ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({
    status: 'error',
    error: { code: error.code ?? 'HELPER_FAILURE', message: error.message, outcome: error.outcome },
  }));
  process.exit(1);
}
