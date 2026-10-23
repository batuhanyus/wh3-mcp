# Windows / WH3 Batch A smoke procedure

This is an operator-executable live check. Complete `npm run verify:offline` first. Use **exactly one** `wh3_mcp_server.pack` and one Node controller.

## Record before starting

```text
Date/time:
Operator/agent:
WH3 version/build:
WH3 install root:
WH3-MCP git/archive revision:
Built pack SHA-256:
Installed pack SHA-256:
user.script.txt evidence/path:
Enabled MCP pack count (must be 1):
Offline gate result/artifact:
Disposable save/state for disruptive test (if used):
```

PowerShell pack hash example:

```powershell
Get-FileHash -Algorithm SHA256 "$env:WH3_INSTALL_DIR\data\wh3_mcp_server.pack"
```

Check `user.script.txt` and the `data` directory for old or renamed MCP packs. Do not continue if more than one MCP pack will load.

## Phase 1: safe read-only smoke

These steps should not intentionally mutate campaign state.

| Step | Action | Expected evidence | Status |
|---|---|---|---|
| 1 | Fresh boot to main menu and wait until UI is ready. | WH3 process alive; `wh3_wait_for_mod`/ping completes protocol-v2 handshake; transport `READY`. | `NOT_RUN` |
| 2 | Run one read-only status/ping command. | Correlated success with current Lua instance/context. | `NOT_RUN` |
| 3 | Submit two read-only calls in quick succession from separate callers if the client permits. | Both succeed with distinct request IDs; transport serialises them; no reply crossover. | `NOT_RUN` |
| 4 | Verify stale/mismatched-response rejection **offline**, using the regression fixture/tests. Do not tamper with live protocol files merely to prove this. | `stale reverse-order result...`, `protocol mismatch...`, and late-timeout quarantine tests pass. Record test output. | `NOT_RUN` |
| 5 | Load/start the agreed disposable campaign to exercise frontend -> campaign transition. This is the first state-changing step; require explicit scenario consent. | Transport enters transition/reconnect states, new Lua context handshakes, no stale reply accepted. | `NOT_RUN` |
| 6 | In campaign, run read-only situation/status queries. | Correct campaign context and plausible read-only data. | `NOT_RUN` |
| 7 | Capture `wh3_check_errors` with its structured cursor. Call again with the returned cursor without creating new errors. | Historical bytes are not reported as new; cursor advances/stays stable without false error duplication. | `NOT_RUN` |
| 8 | Return to main menu using the planned transition. | Frontend context reloads and re-handshakes before next ordinary command. | `NOT_RUN` |
| 9 | Stop WH3 through the owned-process path if WH3 was launched by MCP. | Graceful stop, or bounded escalation if required; final process state is stopped. | `NOT_RUN` |

Record command/result excerpts and relevant log/cursor artefacts for every executed row. If any row fails, stop mutation work and classify it `FAILED` rather than continuing until something happens to look green.

## Phase 2: disruptive crash/forced-exit recovery

Run only in a disposable test state with explicit consent. This is not part of the safe read-only smoke.

1. Launch WH3 through MCP so the server owns the process. Do not use an externally started process for this test.
2. Establish `READY` and start a deliberately pending command whose test consequences are disposable and understood.
3. Force/observe process exit while the request is pending using the planned test mechanism.
4. Confirm the active request returns `GAME_EXITED`/bounded failure rather than success, queued work does not execute, and the outcome is treated as unknown when side effects could have occurred.
5. Restart WH3, allow a fresh Lua context/session handshake, inspect state read-only, and verify the ambiguous mutation was not automatically replayed.
6. Confirm an unrelated external WH3 process is never adopted/killed by the MCP stop path in a separate safe setup if practical.

```text
Disruptive test consent/reference:
Pending command:
Expected disposable side effect:
Observed result/error:
Queued command outcome:
Restart/re-handshake evidence:
No-auto-replay evidence:
Status: NOT_RUN
```

## Log cursor / second-run check

For stronger A06 proof, perform two successive WH3 runs with the same MCP server process when practical. Carry the structured `wh3_check_errors` cursor forward. Record whether rotation, truncation or session/run mismatch is surfaced explicitly. A zero-byte/missing log must not be reported as clean evidence.

## Completion status

Use `RUNTIME_VERIFIED` only for rows actually executed successfully on WH3. Leave all unexecuted rows `NOT_RUN`. The overall Batch A runtime status is `RUNTIME_VERIFIED` only when the required live rows for the claimed scope are complete; otherwise report the exact partial statuses.
