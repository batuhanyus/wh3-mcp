# Batch A verification record

Status vocabulary is exact: `OFFLINE_VERIFIED`, `RUNTIME_VERIFIED`, `FAILED`, `NOT_RUN`. A syntax check is not runtime verification, and an unexecuted live check is not passing by optimism.

## Current repository evidence

| Task | Offline command/evidence | Observed result | Offline status | Live WH3 status | Remaining risk |
|---|---|---|---|---|---|
| A01 protocol contract | `node --test test/protocol-v2.test.js` | Protocol envelope, mismatch, stale identity and transition validators pass. | `OFFLINE_VERIFIED` | `NOT_RUN` | Real WH3/Lua file timing still needs smoke. |
| A02 atomic serial transport | `node --test test/command-transport.test.js` | Includes concurrent callers, reverse-order stale reply, malformed reply, queue/execution timeout, late reply quarantine, v1 mismatch, restart/session separation and lease tests. | `OFFLINE_VERIFIED` | `NOT_RUN` | Windows filesystem/AV timing may differ from fixtures. |
| A03 Lua poll singleton/lifecycle | Lua syntax gate plus standalone bootstrap fixture scenarios where a Lua interpreter is available. | Standalone Lua 5.5 fixture execution passed all 12 scenarios: invalid timer capability variants, registration failure/fallback, duplicate load, controlled rebind, duplicate request, NOT_READY, protocol mismatch and older-session rejection. | `OFFLINE_VERIFIED` | `NOT_RUN` | WH3 timer/context behaviour must be confirmed live. |
| A04 process/path/filesystem safety | `node --test test/wh3-runtime.test.js` | Explicit path priority, traversal/symlink escape, spawn/early-exit, external-process ownership and graceful/forced stop tests pass. | `OFFLINE_VERIFIED` | `NOT_RUN` | Real Steam install permissions/process semantics remain live-only. |
| A05 transitions/reset/recovery | transition/recovery cases in `test/command-transport.test.js` | Correlated transitions, duplicate/uncorrelated transition rejection, timeout no-replay, game exit, concurrent transitions and wrong-context recovery pass. | `OFFLINE_VERIFIED` | `NOT_RUN` | Actual frontend/campaign/battle reload timing remains live-only. |
| A06 incremental diagnostics | `node --test test/diagnostics.test.js` | Baseline, append, rotation, truncation, cursor mismatch, missing/rejected logs, bounded reads, UTF-8 carry, filename variation and zero-byte evidence pass. | `OFFLINE_VERIFIED` | `NOT_RUN` | Real WH3 log rotation/locking requires smoke. |
| A07 release gate/docs/package check | `npm run verify:offline` and package mismatch regression | Unified gate passed: 52 Node tests, package/hash/protocol consistency, JavaScript syntax and Lua bridge/bootstrap-fixture syntax. Windows smoke and safety docs added. | `OFFLINE_VERIFIED` | `NOT_RUN` | Full Windows smoke remains operator work. |

The observed statuses above must be updated to `FAILED` or `NOT_RUN` if the listed commands are not actually executed on a future revision. They describe this Batch A checkout, not every descendant commit.

## Full offline gate

From `server/`:

```text
npm run verify:offline
```

Prerequisites: Node 18+, npm, and `luac` on `PATH` or `WH3_LUAC=<compiler executable>`. WH3 does not need to be installed or running.

The gate fails non-zero on JavaScript syntax failure, Node test failure, package/protocol/hash mismatch, unexpected shipping artefacts, or Lua syntax failure. The Node tests contain real failure injections for races/recovery rather than only envelope happy paths.

## Package evidence

`pack/manifest.json` records protocol version and SHA-256 for the Lua bridge/readme. `tools/verify-package.mjs` checks it against `server/lib/protocol-v2.js`, the Lua `PROTOCOL_VERSION`, exact `pack/` ship-file set and `build.ps1` payload declarations. `build.ps1` runs this check before RPFM and prints both built and installed pack hashes.

A protocol or source-hash mismatch is a failing gate and must be resolved by updating the intended source/manifest together, not by weakening the check.

## External tool contract notes

- MCP tool surface: no deliberate breaking rename from Batch A.
- Raw file transport: v1 is removed; protocol v2 is required and has no fallback.
- Install override: `WH3_INSTALL_DIR` preferred; `WH3_INSTALL_PATH` retained as legacy alias.
- Agents/controllers: one active server session; direct file writers must not run concurrently.
- W&T: unchanged by Batch A.

## Live verification

Use `docs/WINDOWS_SMOKE.md` and attach its recorded artefacts. Until those rows are executed, the overall live status for Batch A is:

`NOT_RUN`

Do not promote it to `RUNTIME_VERIFIED` from offline tests alone.
