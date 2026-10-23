# A01 — Define protocol v2 and establish the automated test harness

**Repo:** wh3-mcp  
**Depends on:** none  
**Objective:** specify transport identity/error semantics BEFORE refactoring both ends; make `npm test` a meaningful gate.

## Current observed condition

`server/package.json` specifies `node --test test/`, but the archive contains no `server/test/` directory. The present command/result file contract does not correlate replies to requests. Both `server/index.js` and `pack/script/_lib/mod/wh3_mcp.lua` own undocumented assumptions.

## Work

1. Add `docs/PROTOCOL_V2.md` defining request envelope `{protocol:2,session_id,request_id,command,params}` and reply `{protocol:2,session_id,request_id,status,result?,error?}`. Specify types and unique identifiers; request IDs should not repeat within a session. Document timeout and session-reset behaviour.
2. Define error categories at minimum: `GAME_NOT_RUNNING`, `NOT_READY`, `IO_FAILURE`, `INVALID_REQUEST`, `INVALID_RESPONSE`, `PROTOCOL_MISMATCH`, `STALE_RESPONSE`, `COMMAND_TIMEOUT`, `CONTEXT_CHANGED`, `GAME_EXITED`, `COMMAND_FAILED`, `UNSUPPORTED_CAPABILITY`.
3. Define exactly-once **acceptance** within a game session (duplicate request IDs must not execute twice); describe response replay/duplicate handling for the bounded dedupe window, including what happens after Lua context reload. Do NOT promise exactly-once game-side effects across crash/relaunch: report outcome unknown when needed.
4. Specify atomic file publication and clean-up ownership, including partial writes, temporary files, prior-run leftovers, JSON parse failures, and session changes. Decide a deterministic bootstrap/ready handshake. The server must never guess that an arbitrary result file belongs to its active request.
5. Add modular protocol validation helpers with no dependency on WH3 being installed. Add tests exercising valid envelopes, missing/wrong fields, unexpected versions, stale session/request IDs, malformed JSON, duplicate IDs and invalid status/error payloads.
6. Update `server/package.json` test script if needed to make an empty/missing test suite fail loudly. Keep Node built-in test runner and avoid unnecessary dependencies.

## Acceptance

- A real `server/test/` tree exists and `npm test` passes with substantive protocol tests.
- `docs/PROTOCOL_V2.md` includes illustrative request, success, failure and session-reset exchanges.
- A01 intentionally does **not** claim the game transport has been migrated. Identify the exact subsequent call sites in the hand-off notes.
- `node --check server/index.js` still succeeds.

## Out of scope

Do not modify campaign tools, introduce game automation, or treat a simulated Lua response as proof of WH3 runtime correctness.
