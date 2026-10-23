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
