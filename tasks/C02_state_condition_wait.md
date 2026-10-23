# C02 — Structured Wait Conditions (WH3-MCP)

**Repository:** `wh3-mcp`  
**Depends on:** C01 and Batch A session/correlation protocol  
**Order:** C02 of C08

## Goal
Replace arbitrary sleep-and-hope loops with a bounded `wh3_wait_for` orchestration primitive grounded in fresh `wh3_get_situation` and `wh3_inspect_ui` observations.

## Required work
1. Implement server-side `wh3_wait_for` supporting an explicit typed condition set (e.g. `context`, `turn`, `saving`, `blocking.kind`, `ui.exists`, `ui.visible`, `ui.parent_id`). Support `all` as the default; support `any` only if clearly specified and tested. Avoid arbitrary eval expressions.
2. Each poll must use the current Batch A session/command identity. Reject stale responses, process restart/session change and transport error. Report `matched`, `timed_out`, `process_exited`, `session_changed` or `unsupported_condition` distinctly.
3. Require or clamp a finite timeout, polling interval and maximum observations; return elapsed time, final observation, unmet conditions and a compact bounded timeline of changed states.
4. Use asynchronous waits: no blocking the Node event loop, no concurrent command-file access outside the Batch A serialisation mechanism, and support cancellation/abort when a caller disconnects if supported by the MCP runtime.
5. Never automatically dismiss dilemmas, answer choices, move armies or change game state. Unknown blockers are observations, not prompts to auto-click.
6. Document when `wh3_wait_for` is inappropriate (e.g. waiting for a state the scenario itself never triggers).

## Acceptance criteria
- State already true returns promptly.
- State becoming true after several polls succeeds within the bound.
- Timeouts include the last valid observation and unmet conditions.
- WH3 exit, session replacement, unavailable UI and unsupported conditions are distinguishable failures.
- Two waits or a wait plus another command cannot corrupt/overwrite a response.

## Verification
Add offline fake-clock/fake-transport tests for success, timeout, cancellation, process death, transient conditions, and concurrent use. Run standard MCP checks. Live-check one campaign readiness wait and one UI visibility wait when permitted; report offline and runtime status separately.

## Deliverables
MCP tool implementation, tests and documentation, with no new auto-action capability.
