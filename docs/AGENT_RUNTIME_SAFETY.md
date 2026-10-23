# Agent runtime safety

These rules apply to agents/operators controlling a real WH3 process through WH3-MCP.

## Gate before live calls

1. Run `cd server && npm run verify:offline` from the exact checkout to be used.
2. Do not proceed on a failing gate. Do not relabel a skipped Lua/package check as passing.
3. Confirm `WH3_INSTALL_DIR` when the install is non-default and verify exactly one `wh3_mcp_server.pack` is enabled.
4. Record the built/installed pack SHA-256 before claiming runtime evidence.

Offline success proves repository behaviour under fixtures. It does not prove WH3 engine/API behaviour. Use `OFFLINE_VERIFIED` until the relevant live steps have actually run.

## One active owner

There must be one active Node controller/session for one WH3 process. Do not run `send-cmd.ps1`, `send-eval.mjs`, another MCP server, or manual command/result file edits while the server owns the protocol files. Stale files are evidence for quarantine, not invitations to drag them back into service.

A server restart intentionally creates a new `session_id`. Let the new session handshake; never make old replies satisfy new requests.

## Read-only first

Begin every live investigation with read-only status/ping/situation/diagnostic calls. Establish context and transport readiness before any state-changing command.

Treat the following as disruptive and require an explicit test scenario plus operator/user consent:

- starting/loading/continuing campaigns or changing saves;
- ending turns, battles, autoresolve/retreat, diplomacy/event choices or other game-state mutations;
- raw `wh3_eval` capable of mutation;
- quitting to menu, exiting Windows, stopping or force-killing WH3;
- crash/forced-exit tests, protocol-file tampering, save deletion/overwrite, or destructive filesystem actions.

Consent to test a feature is not blanket consent to unrelated destructive recovery steps. Prefer a disposable save/state for mutation and crash testing.

## Ambiguous outcomes are not retries

If WH3 exits, the Lua context reloads unexpectedly, or a state-changing request times out after acceptance, its outcome may be unknown. Do **not** automatically replay it.

1. Stop issuing mutations.
2. Allow the transport to time out/reconnect normally.
3. Re-establish a protocol-v2 handshake.
4. Inspect the current game/context with read-only calls.
5. Decide explicitly whether the intended mutation already happened before attempting another action.

`GAME_EXITED`, `COMMAND_TIMEOUT`, `CONTEXT_CHANGED` and stale-response evidence are safety signals, not reasons to bypass correlation.

## Safe cancellation and reset

Use a tool-specific abort operation when one exists, for example the soak abort path. Do not cancel work by deleting `wh3_mcp_command.json` or `wh3_mcp_result.json` under an active controller.

For an ordinary in-flight command without a supported abort, stop submitting new work and let its bounded timeout resolve. After timeout, inspect transport state and game state before continuing.

If a disposable test requires process termination, prefer the MCP-owned graceful stop path. The server must not adopt or terminate an externally started WH3 process. Forced termination belongs only to the explicit disruptive smoke scenario in `WINDOWS_SMOKE.md`.

A safe controller reset is: no new mutations -> settle/timeout current work -> stop the MCP server -> restart it -> fresh session handshake -> read-only state inspection. Restarting the server does not make an ambiguous game mutation safe to replay.

## Evidence discipline

Record exact commands, game version, pack hash, context, result and relevant log cursor/artifacts. Use only these statuses:

- `OFFLINE_VERIFIED` — required offline checks were executed and passed.
- `RUNTIME_VERIFIED` — the stated live WH3 scenario was executed and passed.
- `FAILED` — the stated check was executed and failed.
- `NOT_RUN` — it was not executed.

Never infer `RUNTIME_VERIFIED` from unit tests, Lua syntax, screenshots, old logs or another machine's run.
