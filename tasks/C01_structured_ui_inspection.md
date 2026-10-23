# C01 — Structured UI Inspection (WH3-MCP)

**Repository:** `wh3-mcp`  
**Depends on:** completed Batch A transport/session hardening  
**Order:** C01 of C08  
**Scope:** MCP only

## Goal
Add a bounded, machine-readable UI component inspector so agents can assert existence, ancestry, visibility, geometry and state without parsing a text-only `wh3_list_ui` dump. Extend the existing UI inspection path, do not duplicate it.

## Required work
1. Locate and reuse the existing `wh3_list_ui` implementation and Lua component lookup helpers. Add `wh3_inspect_ui` (or a backwards-compatible structured mode on existing tooling) with selectors by exact component ID and optional parent/path context. Never silently choose an ambiguous match.
2. Return JSON-safe fields: `found`, `component_id`, `path`, `parent_id`, `visible`, `position`, `size`, `text` where accessible, `state` where accessible, `child_count`, `children` (bounded), `root_size`, `errors` and `truncated`. Distinguish absent, hidden, API-unsupported and lookup failure. Document coordinate-space semantics; do not invent screen-space or absolute positions if the game API exposes only local geometry.
3. Support bounded descendants with `max_depth` and `max_nodes`, clamped to safe limits. Protect against nil/invalid UI components and cyclic/reused traversal references. Responses must remain bounded even on a full-screen UI root.
4. Handle campaign, frontend, missing UI root and context changes without Lua exceptions. Inspection is read-only and must not click/change UI.
5. Preserve compatibility with existing `wh3_list_ui` consumers and Batch A protocol/session IDs.
6. Update README/tool help with examples for `wat_harness_launcher` and `button_group_settlement` using **illustrative** expected fields, not assertions of actual game state.

## Acceptance criteria
- A specific visible component yields structured ancestry and geometry, with numeric coordinates and dimensions when supported.
- A missing component yields a typed not-found response, not transport timeout or an invented empty component.
- Ambiguous ID lookup is reported or disambiguated deterministically by an explicit path.
- Traversal obeys all node/depth/output bounds and handles changing UI during lookup.
- Previous `wh3_list_ui` behaviour is unchanged.

## Verification
- Add offline tests for selectors, ambiguity, bounds, absent root and malformed request. Mock game interfaces where necessary; do not pretend mocks prove live UI behaviour.
- Run repository JS/Lua checks and report exact commands/results.
- **Live checkpoint:** when WH3 is available, inspect a known vanilla UI element and W&T launcher; verify structured values against the game UI/screenshot. Until then label `OFFLINE_VERIFIED`, not `RUNTIME_VERIFIED`.

## Deliverables
Modified MCP server/Lua files, tests, README changes and an example redacted inspection response. No W&T changes in this task.
