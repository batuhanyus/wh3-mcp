# WH3-MCP Batch A: Infrastructure Integrity

Target repository: **wh3-mcp** (the 2026-10-23 archive). W&T stays unchanged in Batch A, except that agents may read it as an integration fixture. Copy these task files into the MCP repository, e.g. `tasks/batch-a/`.

## Execution order

1. A01 — protocol contract and test harness
2. A02 — correlated, atomic, serialized transport
3. A03 — Lua poll lifecycle and duplicate-load safety
4. A04 — game process, install path, and filesystem safety
5. A05 — context transitions and crash recovery
6. A06 — log-offset and diagnostics reliability
7. A07 — integration gate, packaging, and documentation

A01 is a prerequisite for all others. A02 and A03 must land before A05. A04 and A06 can be implemented after A01 in parallel branches, but merge only after relevant tests pass. A07 comes last.


## WH3 install override

Use `WH3_INSTALL_DIR` for a custom Warhammer III install. The older `WH3_INSTALL_PATH` variable remains accepted for compatibility. Explicit overrides are validated and never silently replaced by a guessed fallback when invalid.

## Non-negotiable rules

- No fake `RUNTIME_VERIFIED` claims. Batch A is **offline-verifiable** with mocks and Node tests. The game-dependent smoke suite is documented and remains pending until actually executed on the Windows/WH3 host.
- Do not invent WH3 Lua API behaviour. Guard calls and produce explicit diagnostics for unsupported capabilities.
- Existing public MCP tools and their input/output contracts remain compatible unless a protocol-level breaking change is documented and justified. Avoid adding unrelated gameplay tools or W&T functionality.
- No live mutation or automatic campaign progression in tests. Use fake game-side responder fixtures; live smoke commands are read-only wherever possible.
- Keep protocol files in the established WH3 directory unless there is a demonstrated need to relocate them; avoid introducing an HTTP service.
- `wh3_eval` remains an explicitly powerful diagnostic escape hatch. Do not expand its surface in Batch A.
- Every task: implement, add focused regression tests, run `npm test` from `server/`, run `node --check server/index.js`, perform Lua syntax checking via repository-supported tooling where available, and report exact commands/results. Never equate Lua syntax checking with game API validation.
- Keep task changes scoped; avoid a whole-server rewrite. Prefer extracting isolated transport/process modules with injected filesystem/clock/process dependencies for testing.

## Delivery format

For each task provide: changed files, tests added, offline test results, behaviour/compatibility notes, and remaining live-game checks. No untested success declaration. At the end, provide a Batch A evidence checklist, including Windows/WH3 smoke prerequisites.

## Definition of Batch A done

Transport cannot accept a stale/mismatched response as success; requests are serialized; all protocol writes are atomic; timeout/reset and game-context transitions are recoverable; poll startup is safe and idempotent; process control is non-blocking; missing installs are explicit failures; log reads are safely incremental; `npm test` passes with meaningful tests; docs tell agents exactly how to verify the game-dependent remainder.
