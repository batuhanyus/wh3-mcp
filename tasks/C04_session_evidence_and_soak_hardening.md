# C04 — Session Evidence & Existing Soak Hardening (WH3-MCP)

**Repository:** `wh3-mcp`  
**Depends on:** Batch A sessions and errors; C02; C03  
**Order:** C04 of C08

## Goal
Turn a live MCP session into reproducible evidence and harden the existing `wh3_soak`/`wh3_soak_abort` instead of creating a second soak implementation.

## Required work
1. Extend Batch A `begin/end_test_session` equivalents (use their **actual** implemented names) to collect session metadata, process identity, protocol/build versions, request counts, command errors, and per-session log boundaries.
2. Add a bounded evidence export operation returning a manifest and structured outcome. Include start/end `get_situation`, fresh `wh3_check_errors`, optional screenshot artifact references, commands/observations summary, and source evidence hashes where available. Use a unique `run_id`; write files atomically.
3. Harden existing soak: positive bounded turn count, max runtime, per-turn deadline, explicit battle and blocker policies, abort/recovery, process death handling, and resumable **reporting** (not blind retry of turn-changing commands). Record which turns completed, why the run stopped, and unexpected decisions/blockers.
4. Default to conservative policies. Never auto-declare war, choose destructive occupation, modify diplomacy or spend treasury without a named scenario permission. Unknown blocker should stop with evidence, not be dismissed automatically.
5. Evidence export must not mark `RUNTIME_VERIFIED` itself; it reports observations. W&T scenarios decide acceptance. No response should claim more turns completed than confirmed.
6. Keep unbounded logs/screenshots out of MCP JSON responses: return manifest paths/resources plus a compact synopsis. Redact environment secrets/local usernames where practical.

## Acceptance criteria
- Evidence manifest binds exactly one session/run and fresh log offsets.
- Mid-soak process death, timeout, manual abort and unknown blocker produce distinct statuses and partial evidence.
- A completed soak reports confirmed turn transitions and explicit policy decisions.
- No hidden automatic irreversible game action remains under the conservative default policy.
- Existing soak commands remain usable with documented compatibility behaviour.

## Verification
Mock session/process/soak tests including 0 turns, abort, process exit, blocker, timeout, duplicate responses and evidence write failure. Live checkpoint with a short **read-only/low-risk** run on a disposable save, only when game access is explicitly authorised; no long unattended run in this task.

## Deliverables
Modified existing soak/session implementation, tests, documentation and example evidence manifest.
