# Protocol v2 live verification checklist

A01-A03 are offline-verifiable but not WH3-runtime-verified by the repository tests. The following checks require a real game process and are intentionally not claimed by the automated suite.

1. Start the MCP server with WH3 closed. Confirm no old command/result file is treated as a reply.
2. Launch WH3 and call `wh3_wait_for_mod`. Confirm the first successful exchange is protocol v2 and the server reports `transport.ready=true` plus a Lua instance token.
3. In frontend, campaign, and battle contexts, confirm the startup log contains one concise line with `poll_backend`, `instance`, `context`, `protocol=2`, and `registered=true`.
4. Transition frontend -> campaign and campaign -> battle -> campaign. Confirm each new Lua context initially requires/re-establishes handshake and stale replies never satisfy the next command.
5. Trigger a command that crosses a Lua-context reload (`start_campaign` or `quit_to_menu`). Confirm the deferred result preserves the original `session_id` and `request_id`.
6. Start two copies of the MCP pack in the same Lua context if practical. Confirm only one poll callback is active and the second copy logs suppression rather than registering another callback.
7. Verify `core:get_tm()` returning a non-manager value does not raise `attempt to index a boolean value`; campaign context should use the campaign-manager fallback only when `repeat_real_callback` is actually available.
8. Force/observe a command timeout, then send another command. Confirm any late result is quarantined and the later command receives only its own correlated response.
9. Run `wh3_soak_turns`; while it is active, verify unrelated tools cannot race it, while `wh3_soak_status` and `wh3_soak_abort` remain usable through the explicit lease allow-list.
10. Stop/restart the MCP server while WH3 remains open. Confirm a newer handshake replaces the old server session and an older-session handshake is rejected.

A crash after a command is accepted but before its result is published remains an intentionally ambiguous outcome. Protocol v2 reports that ambiguity; it does not claim transactional exactly-once game-side effects across a WH3 process crash or relaunch.

11. Set `WH3_INSTALL_DIR` to the actual custom Steam install and confirm `wh3_status` reports that exact validated root. Repeat with an invalid explicit path and confirm startup reports `WH3_PATH_NOT_FOUND` rather than using a guessed fallback.
12. Start WH3 outside MCP, then call `wh3_stop`. Confirm MCP reports the process as not owned and does not terminate it. Start WH3 through MCP and confirm graceful/forced stop outcomes reflect the real process exit.
13. During frontend -> campaign, quit-to-menu, and battle round-trip operations, inspect `wh3_status.transport.state`; it should move through `TRANSITIONING`/`RECONNECTING` and return to `READY` only after the new Lua context handshakes.
14. Perform two successive WH3 runs with the same MCP server. Call `wh3_check_errors` after each, passing the structured `cursor` forward. Confirm historical errors are not re-reported as current, and rotation/truncation/session mismatch is surfaced explicitly rather than as a clean result.
