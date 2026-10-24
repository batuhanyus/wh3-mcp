# WH3-MCP

WH3-MCP is a Node MCP server plus a Total War: WARHAMMER III Lua bridge used to inspect and automate the game for mod testing. Batch A hardens the file transport, process/path handling, context recovery and diagnostics around protocol v2.

## Prerequisites

Offline development does **not** require a running WH3 installation.

- Node.js 18 or newer and npm.
- A Lua compiler (`luac`) on `PATH`, or set `WH3_LUAC` to the compiler executable. The offline release gate fails rather than silently skipping Lua syntax validation.
- For live Windows smoke only: Total War: WARHAMMER III, the MCP pack, and normal permission to read/write the game install directory.
- For rebuilding the `.pack`: the RPFM MCP service used by `build.ps1` must be running on `127.0.0.1:45127`.

Install Node dependencies from `server/`:

```text
npm ci
```

## WH3 install path

Set `WH3_INSTALL_DIR` to the directory that directly contains `Warhammer3.exe`:

```powershell
$env:WH3_INSTALL_DIR = 'D:\SteamLibrary\steamapps\common\Total War WARHAMMER III'
```

`WH3_INSTALL_PATH` is still accepted as a legacy compatibility alias. An explicit invalid path is an error; the server does not quietly fall back to a different guessed installation. When neither variable is set, documented Steam locations and the Windows Steam uninstall registry are used as discovery candidates.

Protocol files, diagnostics and helper data are resolved beneath the validated install root. The mod pack itself belongs in `<WH3_INSTALL_DIR>\data\wh3_mcp_server.pack`.

## One MCP pack, one controller

Run **exactly one** copy of `wh3_mcp_server.pack`. Duplicate copies can register competing Lua instances and make every subsequent observation suspect, which is a rather expensive way to discover that two is not always better than one.

Before live testing:

1. Check `%APPDATA%\The Creative Assembly\Warhammer3\scripts\user.script.txt` and ensure it has one active `mod "wh3_mcp_server.pack";` entry.
2. Check the WH3 `data` directory for renamed/old MCP pack copies. Remove or disable duplicates rather than loading them together.
3. Run only one WH3-MCP Node server/controller against that game process. Do not use direct command-file helper scripts concurrently with the server.

The Lua bridge also suppresses a secondary copy in one context, but that is a safety net, not permission to ship duplicate packs.

## Protocol v2

The Node server and Lua bridge use correlated file transport protocol v2. Every request and reply carries `protocol`, `session_id` and `request_id`; context-changing requests may also carry transition identity. Writes are atomic, requests are serialised, stale/mismatched replies are quarantined, and a fresh Lua context must handshake before normal commands resume.

There is **no v1 fallback**. Do not write raw `{command, params}` files or accept a result merely because `wh3_mcp_result.json` appeared. See `docs/PROTOCOL_V2.md` for the wire contract.

## Structured UI inspection and bounded waits

`wh3_inspect_ui` is the structured counterpart to the existing `wh3_list_ui`. `wh3_list_ui` remains unchanged for discovery/debug dumps; use `wh3_inspect_ui` when an agent needs machine-readable assertions about one exact component. The selector always requires `component_id`. If that id exists more than once, the tool reports ambiguity instead of quietly picking whichever copy happens to be found first. An exact direct-child `path` (ending in the target id) or exact `parent_path` can disambiguate it.

Examples:

```json
{
  "component_id": "wat_harness_launcher",
  "max_depth": 1,
  "max_nodes": 16
}
```

```json
{
  "component_id": "button_group_settlement",
  "max_depth": 0,
  "max_nodes": 1
}
```

An **illustrative, redacted** successful result has this shape; these numbers and paths are examples, not claims about a current WH3 session:

```json
{
  "found": true,
  "component_id": "wat_harness_launcher",
  "path": ["<ui_root>", "<redacted>", "button_group_settlement", "wat_harness_launcher"],
  "parent_id": "button_group_settlement",
  "visible": true,
  "position": {"x": 100, "y": 200},
  "size": {"width": 55, "height": 55},
  "text": null,
  "state": "active",
  "child_count": 0,
  "children": [],
  "root_size": {"width": 1920, "height": 1080},
  "errors": [],
  "truncated": false
}
```

Geometry is returned exactly from WH3's UIC `Position()` / `Bounds()` calls. The bridge does not translate those values into desktop, capture-image or multi-monitor coordinates. Unsupported fields remain `null` and are accompanied by an `API_UNSUPPORTED` entry rather than guessed values. Descendant output is bounded by `max_depth` (0..8) and `max_nodes` (1..256); `truncated=true` means the requested/lookup bound prevented a complete traversal.

`wh3_wait_for` replaces arbitrary sleep loops with fresh, bounded reads. Conditions are typed: `context`, `turn`, `saving`, `blocking.kind`, `ui.exists`, `ui.visible`, and `ui.parent_id`. The default `mode` is `all`; `mode: "any"` is explicit. UI conditions use the same exact selectors as `wh3_inspect_ui`. The result records elapsed time, the final observation, unmet conditions and a compact changed-state timeline. Process exit, session replacement, cancellation, unsupported conditions and unavailable/failed UI lookup are distinct outcomes.

Example campaign/UI readiness wait:

```json
{
  "conditions": [
    {"type": "context", "equals": "campaign"},
    {"type": "saving", "equals": false},
    {"type": "ui.exists", "component_id": "wat_harness_launcher", "equals": true},
    {"type": "ui.visible", "component_id": "wat_harness_launcher", "equals": true},
    {"type": "ui.parent_id", "component_id": "wat_harness_launcher", "equals": "button_group_settlement"}
  ],
  "timeout_ms": 30000,
  "poll_interval_ms": 250
}
```

`wh3_wait_for` is read-only. A blocker is observed, never auto-dismissed; the tool will not answer dilemmas, move armies or otherwise manufacture progress. It is also the wrong tool for a state that the scenario itself never triggers. For example, waiting for a settlement panel to become visible is pointless if no preceding action opens/selects a settlement. Use a deliberate action first, then wait for the resulting observable state.

## Screenshot artifacts

`wh3_screenshot` is a fresh-capture artifact operation, not a filename existence check. Every request creates a unique TGA basename containing the active transport session, WH3 run identity and capture id. The server waits for that exact new file to become non-zero and stable before reading it, then records timestamps, dimensions and SHA-256 evidence. An old `wh3_mcp_screenshot.tga` can therefore never satisfy a new call.

The server contains a bounded TGA converter for the true-colour formats WH3 emits (24/32-bit, uncompressed or RLE) and verifies the PNG signature/dimensions after conversion. No ImageMagick/Pillow installation is required. Unsupported/malformed input is returned as `CONVERSION_ERROR` with the original TGA metadata/hash rather than being presented as PNG data. `PROCESS_EXITED`, `SCREENSHOT_MISSING`, `SCREENSHOT_TIMEOUT`, conversion failure and size-limit failure remain distinct outcomes.

Successful PNGs are stored under `WH3_MCP_ARTIFACT_DIR` when configured; otherwise the OS temporary directory is used. Repository-local artifact directories are rejected. Cleanup is bounded (24-hour retention and a 200-file ceiling by default). PNGs up to 8 MiB are also emitted as MCP `image/png` content so an agent can actually inspect them; larger valid artifacts remain on disk and return metadata without stuffing unbounded base64 into MCP JSON.

The historical `filename` argument is retained as a basename/prefix only. Paths are rejected and the exact requested filename is no longer reused. This is the deliberate migration needed to prevent stale captures. `tools/screenshot.ps1` remains a host-side desktop PNG fallback for manual foreground inspection; by default it also generates a unique temporary output and refuses accidental overwrite.

Live screenshot claims still require visual inspection. Offline conversion tests prove parser/converter behaviour, not what WH3 happened to render.

## Evidence sessions and conservative soak

Use `wh3_begin_test_session` and `wh3_end_test_session` to bracket a reproducible live check. The evidence session records the MCP transport session, WH3 process/run identity, protocol/server/Lua versions when known, command counts/errors, starting and ending `get_situation` observations, and a structured diagnostics cursor that fixes the per-session log boundary. Screenshots captured with `wh3_screenshot` while the session is active are referenced by hash/metadata rather than embedded into evidence JSON.

`wh3_export_evidence` writes `manifest.json`, `commands.json` and `diagnostics.json` atomically beneath the artifact directory and returns only a compact synopsis/path. The manifest is explicitly `OBSERVATIONS_ONLY`; exporting evidence never awards `RUNTIME_VERIFIED`. If the transport session or WH3 run changes during the bracket, later-run observations are not merged into the earlier run's evidence. Local home-directory names and obvious secret assignments are redacted where practical.

Typical flow:

```text
wh3_begin_test_session {"label":"wat launcher checkpoint","capture_start_screenshot":true}
...perform the scenario and bounded waits...
wh3_screenshot {}
wh3_end_test_session {"capture_end_screenshot":true}
wh3_export_evidence {}
```

`wh3_soak_turns` keeps the existing background Lua soak/status/abort implementation but now uses conservative defaults. `turns` must be 1..200; both per-turn and overall runtime are finite. The runner issues `end_turn` once for each confirmed player turn and does not blindly retry it. It records confirmed turn numbers, policy decisions, blockers and a structured stop reason. Process exit, manual abort, blocker stop and timeout remain distinct; `wh3_soak_status` can return the last server-cached partial report after a process death.

Decision automation is opt-in. By default battles, dilemmas, settlement capture, generic confirmation dialogs and event panels stop the run with evidence. Consequential automation requires both the relevant option and a named permission from `battle`, `dilemma`, `occupation`, `confirm_dialogs`, `dismiss_events`, or `suppress_events`. A retreat request that cannot retreat stops instead of silently becoming an autoresolve; an unavailable occupation/dilemma choice stops instead of falling back to the first choice; move-options interruptions are cancelled rather than auto-declaring war.

A low-risk default soak therefore looks like:

```json
{"turns": 3, "battle_policy": "stop", "max_seconds_per_turn": 300, "max_runtime_seconds": 1000}
```

A scenario that intentionally permits specific decisions must say so explicitly, for example:

```json
{
  "turns": 2,
  "battle_policy": "retreat",
  "dilemma_choice": 1,
  "permissions": ["battle", "dilemma"]
}
```

This is a compatibility tightening, not a second soak system: `wh3_soak_turns`, `wh3_soak_status` and `wh3_soak_abort` remain the public commands, but old callers that relied on implicit autoresolve/choice-1/occupy behaviour must now provide explicit policy and permission arguments.

## Offline release gate

From `server/` run:

```text
npm run verify:offline
```

The gate performs JavaScript syntax checks, the Node regression/integration suite, package/protocol/hash consistency checks, and Lua syntax checks for both the bridge and bootstrap fixture. It does not launch WH3 and does not require a WH3 install.

Useful narrower commands are:

```text
npm test
npm run verify:package
node --check index.js
```

A passing offline gate is `OFFLINE_VERIFIED`, not `RUNTIME_VERIFIED`. Live proof requires the Windows/WH3 procedure in `docs/WINDOWS_SMOKE.md`.

## Build and package verification

`pack/manifest.json` pins the protocol number and SHA-256 of the exact Lua bridge/readme source used to build the pack. `tools/verify-package.mjs` fails if the Node protocol, Lua protocol or manifest drift apart, if the source hash changed without an updated manifest, if unexpected generated files enter `pack/`, or if obvious credential/temp artefacts appear in shipping inputs.

On Windows:

```powershell
.\build.ps1
```

The build runs the package verifier before contacting RPFM, adds only the verified Lua bridge, embedded manual and manifest, saves `wh3_mcp_server.pack`, prints its SHA-256, deploys to the configured WH3 install when available, and confirms the installed pack hash matches the built file.

## Launch considerations

For deterministic automation, direct executable launch is preferred over relying on the CA launcher state. `--feature disable_intro_videos` can shorten startup. `user.script.txt` must still enable the one MCP pack; launcher rewrites of that file can disable or duplicate mod entries depending on the operator workflow.

A legal/splash screen can occasionally require a real foreground mouse click before scripted interaction is possible. Treat that as a launcher/startup prerequisite, not evidence that the Lua bridge failed.

## Troubleshooting

- `WH3_PATH_NOT_FOUND`: verify `WH3_INSTALL_DIR` points to the folder containing `Warhammer3.exe`, not its `data` child.
- `PROTOCOL_MISMATCH`: server, Lua bridge and pack manifest are from different generations. Run `npm run verify:package`, rebuild, then ensure only the rebuilt pack is enabled.
- `NOT_READY`: the Lua context has loaded but the protocol-v2 handshake is not established yet. Allow the server to re-handshake; do not bypass it with direct file writes.
- `STALE_RESPONSE`: an old/late reply was correctly rejected. Do not rename it back into place or replay a state-changing request automatically.
- Commands time out after a menu/campaign/battle transition: inspect `wh3_status.transport.state`; the server should reconnect and handshake in the new context before further ordinary commands.
- Errors seem to repeat across launches: pass the structured cursor returned by `wh3_check_errors`; session/run mismatch, rotation and truncation are reported explicitly.
- MCP pack appears loaded twice: inspect both `user.script.txt` and the `data` directory for old/renamed copies, then restart WH3 with exactly one pack.

## Safety and verification documents

- `docs/AGENT_RUNTIME_SAFETY.md` — agent/operator safety rules for live control.
- `docs/WINDOWS_SMOKE.md` — reproducible Windows/WH3 smoke checklist.
- `docs/BATCH_A_VERIFICATION.md` — per-task evidence and status vocabulary.
- `docs/BATCH_A_CHANGELOG.md` — Batch A changes and W&T/.omp compatibility guidance.
- `docs/LIVE_PROTOCOL_V2_CHECKLIST.md` — deeper protocol transition checks.

Batch A does not modify W&T. Consumers should use the MCP tool surface and treat direct protocol-file ownership as an internal WH3-MCP responsibility.
