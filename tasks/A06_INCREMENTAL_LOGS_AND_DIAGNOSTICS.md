# A06 — Make error reporting incremental, session-aware and bounded

**Repo:** wh3-mcp  
**Depends on:** A01; integrate with A02/A04 session metadata  
**Objective:** reliably detect NEW errors without mistaking historical log content for a current regression.

## Current observed condition

`wh3_check_errors` can read log files from disk and accepts offsets. It needs stable semantics across rotation, truncation and successive WH3 runs.

## Work

1. Centralize diagnostics/log-tail reading; record for each file canonical path, file identity (where available), size, last-modified time, byte offset, truncation/rotation observation and current run/session ID.
2. Keep the existing `wh3_check_errors` public arguments valid; offer an additive structured `since`/cursor format or safely interpret the old format. Never silently skip data on file rotation or size shrink.
3. Establish an explicit baseline when a new MCP test session begins (do not introduce full scenario orchestration, which is Batch B). Label log lines as current-since-baseline, historic or indeterminate. On session mismatch, return a warning/error rather than declaring zero new errors.
4. Bound file reads and output sizes; keep the first/last relevant error plus counts and truncation metadata. Do not read unbounded enormous logs into memory by default. Preserve useful details for fault diagnosis.
5. Ensure absent/unreadable logs, timestamp collisions, zero-byte files, and script-log filename variation cannot yield misleading green status. Differentiate `no new matching lines` from `logs unavailable`.
6. Keep diagnostics completely read-only and available while WH3 is hung or closed.

## Tests

Use temp logs with append, truncation, rotate/recreate, identical timestamps, partial UTF-8, CRLF/LF, missing file, inaccessible file and large output. Assert offsets never make errors disappear silently and normal no-change polling is stable.

## Acceptance

- Error reading never requires a game round trip.
- Returned cursors distinguish successive runs and file rotation.
- No result interprets unavailable evidence as zero errors without qualification.
- Tests show current errors can be separated from historical ones.
