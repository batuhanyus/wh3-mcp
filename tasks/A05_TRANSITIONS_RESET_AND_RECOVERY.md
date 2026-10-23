# A05 — Correlate context transitions and recover safely from resets

**Repo:** wh3-mcp  
**Depends on:** A02, A03, A04  
**Objective:** make menu/campaign/battle transitions explicit state changes rather than stale-marker roulette.

## Work

1. Identify every direct read/write of transition-marker files and every tool that loads a save, enters battle, exits battle or quits to menu. Inventory them in the implementation notes.
2. Give transition operations a `session_id` and `request_id` (plus optional `transition_id`). A completion marker must echo identity, destination/context and outcome. Ignore or quarantine uncorrelated markers.
3. Define states such as `READY`, `TRANSITIONING`, `RECONNECTING`, `FAILED` and `GAME_EXITED`. Block ordinary commands during transitions unless explicitly documented as safe.
4. Handle Lua-script reload and lost session state. The server must negotiate a new ready state before issuing another command and must not replay a timed-out state-mutating command automatically.
5. On timeout or process exit report what is known and what is **unknown**. Differentiate a transition finishing late from a fresh transition. Clear stale files safely only after ownership checks.
6. Ensure session ownership/leases survive long-running operations and do not collide with ordinary `sendCommand()` calls or soak-related polling.

## Tests

Fake responders should simulate delayed loading, stale completion markers, game crash before completion, context reload, duplicated marker, request timeout, read-only reconnect and two concurrent transition attempts. Verify old markers cannot complete new requests and an ambiguous state-changing command is never silently retried.

## Acceptance

- All transition completions are identity-correlated.
- No game-state mutation is retried after uncertain execution without explicit user/agent intervention.
- Recovery paths are finite, tested and return actionable diagnostics.
- Existing transition tool names retain compatible public behaviour or have explicitly documented migration notes.
