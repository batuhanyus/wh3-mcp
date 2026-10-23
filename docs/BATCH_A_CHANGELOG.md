# Batch A changelog and compatibility guidance

## What changed

- Protocol v2 replaces uncorrelated v1 file exchange with session/request correlation, strict validation, atomic publication, quarantine of stale/malformed replies, serial execution and a deterministic handshake.
- Lua poll startup is singleton/idempotent and guards timer-manager capabilities instead of assuming a particular WH3 context implementation.
- WH3 install/process handling validates explicit paths, supports `WH3_INSTALL_DIR`, prevents path escape, does not adopt externally started processes for termination, and uses bounded asynchronous stop/escalation.
- Context-changing operations carry transition identity and recover through re-handshake. Ambiguous timed-out mutations are not replayed automatically.
- Error/log reads use structured cursors with filesystem/session identity, bounded incremental reads, rotation/truncation detection and current-run baselines.
- A07 adds a single offline release gate, package/hash/protocol consistency checks, runtime safety policy and a reproducible Windows smoke record.

## External contract changes

The MCP tool names/input-output surface is intended to remain compatible for normal clients. The **raw file protocol is intentionally breaking**: direct v1 `{command, params}` / `{status, ...}` controllers are unsupported. Consumers that bypass the MCP server must implement protocol v2 exactly; using the bundled server is preferred.

`WH3_INSTALL_DIR` is the preferred install override. `WH3_INSTALL_PATH` remains accepted for compatibility.

## W&T compatibility

Batch A does not modify Warhammer & Taxes. W&T should continue to be treated as the system under test while WH3-MCP owns transport/process/diagnostic concerns.

For W&T automation:

- use WH3-MCP tools rather than writing command/result files directly;
- run `npm run verify:offline` before live sessions using a newly changed MCP checkout;
- enable one MCP pack only;
- distinguish read-only inspection from campaign-changing test scenarios;
- after context transitions or ambiguous failures, re-establish readiness and inspect state before another mutation;
- use structured `wh3_check_errors` cursors when comparing W&T logs across steps/runs.

No W&T source or pack changes are required merely to adopt Batch A.

## .omp / agent integration guidance

Agent workflows should treat the offline gate as a mandatory preflight and `docs/AGENT_RUNTIME_SAFETY.md` as the live-call policy. An agent must not create a second file-protocol controller beside the Node MCP server, must not "fix" stale replies by moving/deleting files manually, and must not claim live verification from fixture evidence.

Automated task reports should carry one of `OFFLINE_VERIFIED`, `RUNTIME_VERIFIED`, `FAILED`, or `NOT_RUN` for each relevant check. Windows/WH3 smoke artefacts belong with the task/run report, including game version and installed pack hash.
