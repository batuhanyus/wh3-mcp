# A02 — Implement correlated, atomic, serialized command transport

**Repo:** wh3-mcp  
**Depends on:** A01  
**Objective:** one unambiguous in-flight request, durable request identity, and safe filesystem exchange across Node and Lua.

## Current observed condition

The Node `sendCommand()` / `clearFiles()` flow and Lua `wh3_mcp_command.json` / `wh3_mcp_result.json` polling use fixed filenames. Blind cleanup and lack of response correlation are unsafe under overlapping calls, restarts or timeouts.

## Work

1. Extract a `CommandTransport` module from `server/index.js` where practical. Keep existing public MCP tool names and caller-visible results compatible. Centralize request creation, result validation, timeout and cleanup.
2. Implement a strict one-at-a-time async command queue/mutex. Queue acquisition and execution deadlines must be explicit; timed-out queued calls must not execute later. Ensure long-running MCP tools either acquire the same exclusive lease or document and enforce a separate session-wide lease, so no other tool can race them.
3. Use v2 `session_id` and monotonically increasing `request_id` (or equally unambiguous unique IDs). Reject replies whose protocol/session/request ID does not match the active request. Keep stale and mismatched replies for diagnostics or quarantine; do not turn them into the successful result of another call.
4. Publish commands atomically: write a unique temporary file, flush/close, rename to the established command filename on the same filesystem. On Windows, handle rename target already existing deliberately rather than assuming POSIX overwrite semantics. Lua publishes results via temporary-file-then-rename as supported by the game environment; handle rename failure and partial files safely. Do not delete the only valid response before the server has read/validated it.
5. Game-side parser must validate protocol/session/request fields **before** dispatch; return structured errors for known bad envelopes. Duplicate request IDs must not replay side effects. Define bounded in-session dedupe/reply replay; reject older sessions. Preserve protocol identity on handled command exceptions.
6. Implement handshake/readiness sequencing. Never let a fresh server call consume leftovers from a previous server or game process. A protocol mismatch fails visibly rather than silently falling back to v1.
7. Review `clearFiles()` and all direct protocol-file operations across server and Lua: change call sites to transport-owned safe cleanup. Ensure `wh3_eval` and all other existing tools go through the same transport.

## Tests

With temporary directories, fake responders and controllable delays test concurrent requests, reverse-order/stale results, duplicate requests, malformed/partial replies, command timeout, queue timeout, late post-timeout result, new session, invalid protocol, write/rename failure and result-file reuse. Assert only one command is active. Add a fake-game test that verifies execution/dispatch happens once on duplicate request IDs where game-side code is testable without WH3; otherwise record it as a live follow-up.

## Acceptance

- No code path treats an unmatched response as success.
- Existing MCP tools share the serialized, identity-checked transport; no old `clearFiles()` pattern races a pending call.
- Each timeout exposes request and session IDs, and failure does not poison subsequent requests.
- Offline tests pass; runtime handshake remains explicitly pending until a real game test.

## Out of scope

No new W&T API, UI tools, campaign state mutations or generic distributed-message broker.
