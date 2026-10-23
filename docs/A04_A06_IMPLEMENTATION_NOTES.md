# A04-A06 implementation notes

These notes record the offline-verifiable changes for Batch A tasks A04, A05 and A06. They do not claim Windows/WH3 runtime verification.

## A04 process, install path and filesystem safety

Install discovery is centralized in `server/lib/wh3-runtime.js`.

Priority is:

1. `WH3_INSTALL_DIR` (preferred explicit override),
2. legacy `WH3_INSTALL_PATH` (kept for compatibility),
3. documented Steam candidate directories,
4. the Windows Steam App 1142710 uninstall registry entry.

An explicit override is authoritative. If it is invalid, inaccessible, lacks `Warhammer3.exe`, or is not writable, startup returns `WH3_PATH_NOT_FOUND` rather than silently trying an unrelated guessed location. Protocol, docs and diagnostic paths are resolved beneath the validated root; caller-provided log names reject absolute paths, traversal and nested alternate roots.

`Wh3ProcessManager` owns only a child it spawned. An already-running external `Warhammer3.exe` is reported but never adopted for termination. Child stdio is ignored, startup observes `spawn`/`error`/early `exit`, and stop waits asynchronously for SIGTERM before bounded SIGKILL escalation. A stop timeout is reported as a failure instead of success.

The Lua poll diagnostic filename is now relative to the game's validated working directory instead of being hard-coded to one `D:` Steam install.

## A05 transition inventory and recovery

Direct transition marker ownership is confined to `pack/script/_lib/mod/wh3_mcp.lua`:

- `wh3_mcp_starting_campaign.marker`: written for deferred frontend -> campaign operations and consumed after Lua context reload.
- `wh3_mcp_quitting.marker`: written by `quit_to_menu` before leaving campaign and consumed by the new frontend/main-menu Lua context.

The public/server context-changing inventory is:

- `wh3_start_campaign` -> `start_campaign` -> campaign (deferred marker),
- `wh3_load_campaign` -> `load_campaign` -> campaign (deferred marker),
- `wh3_continue_campaign` -> `continue_campaign` -> campaign (deferred marker),
- `wh3_confirm_load` -> `confirm_load` -> campaign (deferred marker),
- `wh3_quit_to_menu` -> `quit_to_menu` -> main menu/frontend (deferred marker),
- `wh3_exit_windows` -> `exit_to_windows` -> process exit (result is published before the confirm click because the process then dies),
- `wh3_fight_battle` -> `fight_battle` -> battle, optionally round-tripping back to campaign; the server owns this as one managed transition under an exclusive lease,
- `wh3_end_battle` -> `end_battle` can dismiss the in-battle results popup and thereby trigger the battle -> campaign script reload; it is not marker-backed, so the following command recovers through protocol `NOT_READY` + handshake,
- `wh3_start_battle` starts the deployment phase inside an already-loaded battle context and does not itself cross a Lua context,
- `wh3_autoresolve_battle`, `wh3_retreat_battle`, and `wh3_dismiss_battle_results` operate on campaign-side battle UI/results and do not enter the battle Lua context.

UI-selection helpers such as `wh3_select_campaign` and `wh3_select_save` only select frontend UI state; the actual context-changing operations remain the correlated `start/load/continue/confirm` commands above.

Protocol-managed transition requests receive a `transition_id` and `transition_destination` in addition to protocol `session_id` and `request_id`. Lua replies echo the transition identity; successful completion metadata must echo the same destination and include observed context plus outcome before Node accepts it. Deferred marker data also stores `transition_id` and expected destination. On reload, marker ownership must match the persisted active session and last accepted request; an uncorrelated marker is quarantined rather than allowed to complete a newer operation. The session ledger also persists the last completed transition identity, so a duplicated deferred marker cannot resurrect an already-completed transition. Campaign-start markers are retained until the correlated result is actually published, allowing another Lua context reload during the Continue/loading phase to recover the same pending transition.

`CommandTransport` exposes `READY`, `TRANSITIONING`, `RECONNECTING`, `FAILED` and `GAME_EXITED` states. A successful context-changing operation requires a fresh handshake before the next ordinary command. A reconnect into the wrong context returns `CONTEXT_CHANGED` once and does not replay the ambiguous mutation. A timed-out accepted mutation is never automatically retried. The `wh3_fight_battle` tool holds the existing exclusive session lease and reports `TRANSITIONING` while battle contexts reload.

## A06 incremental diagnostics

`server/lib/diagnostics.js` owns all `wh3_check_errors` disk reads. Each source records canonical path, filesystem identity, size, mtime, start/next byte offsets, rotation/size-shrink observations, bounded read/output truncation and the current MCP session/run identity.

The old `since: {filename: offset}` input remains accepted, but is labelled identity/session-indeterminate. The preferred cursor is:

```json
{
  "session_id": "server-...",
  "run_id": "run-...",
  "files": {
    "wh3_mcp_script_errors.log": {
      "offset": 1234,
      "identity": "fs:...",
      "size": 1234,
      "mtime_ms": 1234567890,
      "carry_base64": ""
    }
  }
}
```

A new owned WH3 launch starts a fresh diagnostic baseline before new game output is evaluated. Historical bytes are therefore not counted as current-run errors. Cursor session/run mismatches, missing logs, rejected paths, bounded unread ranges and zero-byte-only evidence cannot produce a misleading `has_new_errors=false`; the result becomes indeterminate (`null`) unless a new error was positively observed.

Reads are capped by default, preserve first/last observed matching errors and counts, and carry incomplete trailing UTF-8 bytes across polls. When a range is larger than the cap, the diagnostic response may preview the tail, but the structured cursor advances only through the contiguous head actually consumed; later polls therefore drain the unread middle instead of silently skipping it. Script log discovery accepts filename variation matching `script_log_*.txt` and does not rely on filename timestamps.

## Offline evidence

Run from `server/`:

```text
npm test
```

The A04-A06 implementation adds tests for path priority/validation, path escape rejection, ignored child stdio, spawn error, early exit, graceful and forced shutdown, stop timeout, event-loop responsiveness, unrelated external process safety, active-command game exit, correlated transitions, stale transition replies, timeout recovery without replay, concurrent transitions, baseline/history separation, append/truncate/rotate, cursor mismatch, missing/rejected logs, bounded large logs, split UTF-8, CRLF/LF, script-log filename variation and zero-byte evidence.

The repository's Node Lua syntax helper requires `luaparse`, which is not installed in the supplied archive/runtime. As an independent syntax check, the modified Lua file was loaded successfully by a small checker linked against the supplied Lua 5.5 library. This verifies Lua 5.5 syntax only; it is not a WH3 runtime test.

## Remaining live Windows/WH3 checks

A04-A06 still require a real Windows/Steam smoke pass: validate explicit/custom install discovery and permissions, launch/stop the real process, verify no external WH3 process can be killed, cross frontend/campaign/battle transitions while observing `transport.state`, confirm stale marker quarantine behaviour, then perform two successive game runs and verify `wh3_check_errors` separates historical from current-run lines using the structured cursor.
