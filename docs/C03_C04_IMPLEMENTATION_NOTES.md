# C03/C04 Implementation Notes

## Status

The implementation in this repository is **OFFLINE_VERIFIED** when the repository test and syntax gates pass. Nothing in these changes claims `RUNTIME_VERIFIED`; the live WH3 checkpoints from C03/C04 still require an authorised Windows game run and, for C03, actual inspection of the returned images.

## C03 — screenshot artifacts

The public `wh3_screenshot` tool still invokes the existing Lua `take_screenshot` command. The Node layer now creates the actual filename and never asks WH3 to reuse a prior capture name. The basename includes the transport session id, process run id and a random capture id.

Freshness is established by waiting for that exact new TGA to exist, become non-zero and report the same size/mtime for consecutive polls. A command acknowledgement by itself is not capture success. The main failure classes are:

- `PROCESS_EXITED`: WH3 was not running or exited during capture.
- `SCREENSHOT_MISSING`: WH3 acknowledged the request but the unique file never appeared.
- `SCREENSHOT_TIMEOUT`: a file appeared but did not become stable in time.
- `CONVERSION_ERROR`: TGA bytes exist but are malformed/unsupported or PNG verification failed.
- `IMAGE_TOO_LARGE`: configured safety limits were exceeded.

The built-in converter accepts 24/32-bit true-colour TGA image types 2 and 10 (raw and RLE), honours top/bottom and left/right origin bits, emits RGBA PNG, and re-reads the PNG IHDR dimensions before success. Source and PNG SHA-256 values are returned.

Artifacts default to the OS temporary directory under `wh3-mcp-artifacts`, or `WH3_MCP_ARTIFACT_DIR` if configured. A path inside the source repository is rejected. Default retention is 24 hours with a 200-file ceiling. Valid PNGs up to 8 MiB are emitted as MCP `image/png` content; larger images remain artifact-only.

`tools/screenshot.ps1` is deliberately separate: it captures the primary desktop for manual foreground debugging. It now creates a unique output by default, validates non-zero/maximum size and refuses overwrite without `-Force`.

## C04 — evidence sessions

The concrete session operations added by C04 are:

- `wh3_begin_test_session`
- `wh3_end_test_session`
- `wh3_export_evidence`

A session captures transport/process identity, server/protocol/Lua versions when available, the diagnostics cursor at the start boundary, start/end `get_situation`, command counts, command errors, bounded command observations and screenshot artifact references. Duplicate correlated command replies are de-duplicated by `(session_id, request_id)` in the evidence recorder.

`wh3_export_evidence` atomically writes three bounded JSON documents:

```text
evidence/<run_id>/manifest.json
evidence/<run_id>/commands.json
evidence/<run_id>/diagnostics.json
```

The manifest contains one evidence `run_id`, one starting transport session/process run identity, start/end log cursors, source read hashes where diagnostics supplied them, situation observations, command synopsis and screenshot references. If the process run or transport session changes, later-run observations are not merged and `identity_consistent` is false. Exports label themselves `OBSERVATIONS_ONLY`.

Illustrative manifest excerpt:

```json
{
  "schema": 1,
  "kind": "wh3_mcp_session_evidence",
  "verification": "OBSERVATIONS_ONLY",
  "test_session_id": "test-<uuid>",
  "run_id": "evidence-<timestamp>-<uuid>",
  "transport_session_id": "server-<redacted>",
  "process_run_id": "run-<redacted>",
  "identity_consistent": true,
  "log_boundaries": {
    "start": {"session_id":"<redacted>","run_id":"<redacted>","files":{}},
    "end": {"session_id":"<redacted>","run_id":"<redacted>","files":{}}
  },
  "command_summary": {"count": 8, "error_count": 0},
  "screenshot_artifacts": []
}
```

## C04 — soak compatibility and policy

C04 hardens the existing Lua `soak_turns` / `soak_status` / `soak_abort`; there is no parallel soak engine.

The default policy is now conservative:

- `turns` must be an integer from 1 to 200. `0` is rejected.
- `battle_policy` defaults to `stop`.
- dilemma and occupation choices default to no choice, which means stop on that blocker.
- generic confirmation dialogs and non-dilemma event dismissal default to disabled.
- every consequential automation path additionally requires a matching named scenario permission.
- unknown blockers stop with `status="blocked"` and a recorded blocker entry.
- move-options interruptions are cancelled, never confirmed into a war declaration.
- retreat failure stops; it does not silently autoresolve.
- requested dilemma/occupation choices must actually exist; there is no first-choice fallback.
- `cm:end_turn()` is issued once per confirmed player turn. Lack of progress is a deadline outcome, not justification for blind replay.

Soak summaries include `completed_turns`, `stop_reason`, `blockers`, `policy_decisions` and the effective policy. Server orchestration adds an overall runtime deadline, converts process death into partial resumable reporting, requests abort on server deadline, and caches the latest report so a post-CTD `wh3_soak_status` can still describe confirmed progress.

The compatibility consequence is intentional: callers that previously depended on implicit autoresolve, dilemma choice 1, automatic occupation, generic dialog confirmation, or event dismissal must name the exact action and grant its permission.
