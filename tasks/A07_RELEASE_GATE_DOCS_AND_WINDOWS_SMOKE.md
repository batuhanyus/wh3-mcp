# A07 — Establish Batch A release gate and Windows/WH3 smoke procedure

**Repo:** wh3-mcp  
**Depends on:** A01-A06  
**Objective:** make this infrastructure shippable and establish clear evidence for offline vs live reliability.

## Work

1. Update README setup for environment paths, `WH3_INSTALL_DIR`, protocol v2, one-pack-only requirement, known WH3 launcher considerations and troubleshooting. Eliminate contradictory v1 assumptions in comments/docs where possible.
2. Add `docs/AGENT_RUNTIME_SAFETY.md` that requires an offline gate before live calls and restricts destructive commands to explicit scenarios/consent. Document one active controller/session and safe cancellation/reset.
3. Add `tools/verify-offline.*` or equivalent documented cross-platform npm script running Node syntax, tests, transport integration fixtures and available Lua syntax checks. Fail nonzero on any failed gate. Avoid depending on a running WH3 installation.
4. Add a reproducible packaging check that ensures the shipped pack contains the updated Lua bridge, server uses matching protocol version, no generated test credentials/paths leak into archives, and docs state how to spot duplicate MCP packs.
5. Add `docs/WINDOWS_SMOKE.md` with an operator-executable checklist that starts WH3 with **exactly one** MCP pack and records game version, installed pack hash and results. Include: fresh boot/main menu ready; read-only command success; two calls in quick succession; deliberately mismatched/stale response rejected (prefer offline fixture, not live file tampering); campaign transition; read-only campaign situation; return to menu; game stop; process crash/forced exit during pending command only in disposable test state; and log cursor check. Distinguish safe read-only smoke from disruptive crash testing.
6. Add `docs/BATCH_A_VERIFICATION.md` with per-task test command, observed result, unresolved risks, changes to external tool contracts, and explicit statuses `OFFLINE_VERIFIED`, `RUNTIME_VERIFIED`, `FAILED`, or `NOT_RUN`. Never label a non-executed test as passing.
7. Produce a concise Batch A changelog and compatibility guidance for W&T/.omp integration. Do not modify W&T unless explicitly instructed.

## Acceptance

- Fresh checkout can run the full offline gate with documented prerequisites.
- Tests include actual race/recovery failure injections, not just envelope happy paths.
- Packaging/version mismatch causes a failing gate.
- Manual Windows smoke is written clearly enough to hand to another agent/operator; report marks each as run/not run with artifacts.
- Final status distinguishes offline proof from live WH3 proof.

## Out of scope

Runtime profiles, W&T test API, baseline saves, generic UI inspection, scenario engine and screenshot improvements belong to later batches.
