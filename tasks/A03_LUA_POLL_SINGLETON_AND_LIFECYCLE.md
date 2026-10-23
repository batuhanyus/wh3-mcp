# A03 — Make the Lua polling loop capability-safe and idempotent

**Repo:** wh3-mcp  
**Depends on:** A01, coordinate with A02  
**Objective:** prevent `tm was boolean`, duplicate poll loops and context-reload-induced duplicate execution.

## Current observed condition

`pack/script/_lib/mod/wh3_mcp.lua` attempts `core:get_tm():repeat_real_callback(...)` if `core:get_tm()` returns truthy. A boolean can therefore trigger a method call failure. There is no robust singleton gate for two loaded MCP pack instances.

## Work

1. Guard access to `core`, `core.get_tm`, timer-manager return value, and the `repeat_real_callback` method. Validate method capability and wrap registration in `pcall`; fall back to a supported campaign timer only when capability is verified. Emit concise reason codes rather than dumping enormous trace logs.
2. Implement a per-Lua-context global singleton registry, e.g. `__wh3_mcp_runtime_v2`, storing instance token, script version, callback registration status and session state. Secondary copies must not start a second poller or overwrite active transport state.
3. Make poll registration idempotent even if initialization is invoked twice. If supported, explicitly remove/re-register named callbacks on controlled context reset. Do not indiscriminately remove another owner's callback.
4. Account for the global registry being reset on main-menu/campaign/battle Lua-context transitions. Reinitialization must be safe, and server session/readiness must distinguish a fresh context from the previous one.
5. Keep every game-engine capability probe conservative. Never use boolean truthiness as proof that an API exposes a method.
6. Log a single startup summary: `poll_backend`, `instance`, `context`, `protocol`, `registered=true|false`, `failure_reason` (only if failed). Avoid per-tick diagnostic spam.

## Tests

Add Lua-side fixture/mocks or a testable bootstrap module to cover boolean `get_tm`, nil/missing method, thrown registration, valid timer, valid campaign fallback, repeated initialization and duplicate pack load. A Lua syntax check is necessary but insufficient: document game-runtime checks separately.

## Acceptance

- No unguarded timer-manager method invocation remains in polling bootstrap.
- Initializing twice registers only one active poller in the same Lua context.
- Unsupported environments fail with a meaningful diagnostic and never claim ready.
- Startup failures cannot produce a false positive result to Node.
