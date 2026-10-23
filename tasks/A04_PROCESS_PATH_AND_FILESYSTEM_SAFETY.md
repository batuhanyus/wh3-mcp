# A04 — Harden WH3 process lifecycle and path resolution

**Repo:** wh3-mcp  
**Depends on:** A01  
**Objective:** reliable nonblocking start/stop, strict install-path validation, and safe filesystem boundaries.

## Current observed condition

`server/index.js` uses fallback path guesses, `startWh3()` spawns with stdout/stderr pipes that are not consumed, and `stopWh3()` has synchronous waiting that can block the Node event loop.

## Work

1. Refactor install discovery behind a small function with injected filesystem/process dependencies. Support explicit `WH3_INSTALL_DIR` first, validate expected game executable/path and filesystem permissions, then documented autodetection. If neither resolves, return `WH3_PATH_NOT_FOUND` (or mapped `NOT_READY`), never silently accept a nonexistent fallback.
2. Validate that all protocol/log files resolve beneath the approved WH3 root; reject traversal, alternate-root or arbitrary user-provided paths. Distinguish absent files from inaccessible files. Preserve valid existing custom install locations.
3. Start the process with stdout/stderr ignored or actively consumed, not unconsumed `pipe`s. Handle spawn error, early exit and an already-running instance without creating a duplicate game. Maintain PID/process ownership so stop cannot accidentally kill an unrelated process.
4. Replace blocking waits in `stopWh3()` with promise/event-driven asynchronous checks. Stop/quit escalation must have bounded deadlines and detailed termination outcomes. Don't claim success until the process has actually exited.
5. Define what happens when the process exits while a protocol request is active. The current call must terminate promptly with `GAME_EXITED`; queued work must not execute against a vanished process.
6. Keep any test path override, executable stub or fake process fixture explicitly test-only.

## Tests

Use a fake child process and temporary directories to cover path priority, missing executable, unwritable directory, unrelated process, spawn error, early exit, stdout flood, graceful exit, escalation, stop timeout, active-command interruption, path traversal and event-loop responsiveness during shutdown.

## Acceptance

- Missing/invalid install paths stop startup with explicit errors.
- No event-loop-blocking sleep loop remains in process management.
- No unconsumed child stdio pipes remain.
- Failed startup/stop cannot be reported as success; no unrelated process is terminated.
- Windows/Steam-path manual smoke remains a separately recorded check.
