# C03 — Agent-readable Screenshot Capture (WH3-MCP)

**Repository:** `wh3-mcp`  
**Depends on:** Batch A file/session protocol; C01 recommended  
**Order:** C03 of C08

## Goal
Upgrade existing `wh3_screenshot`/`tools/screenshot.ps1` into a reliable screenshot capture and artifact API that coding agents can inspect as a real image, not just an opaque TGA filename.

## Required work
1. Reuse the existing screenshot implementation. Generate unique capture IDs and filenames including current session/run identity; never reuse a stale capture from a previous request.
2. Wait for a newly created, stable nonzero screenshot file within bounded timeout. Record source path, creation/mtime, dimensions if available, and content hash. Never report success solely because an old file exists.
3. Convert TGA to PNG for portable consumption using an available, documented converter; verify conversion result and dimensions. If conversion support is absent, return a typed failure with original evidence rather than mislabelled bytes.
4. Expose screenshot image content to the MCP client in the supported image response format (or, if MCP host constraints preclude it, an explicit artifact resource/read operation returning the PNG bytes). Keep the filesystem path as supplemental metadata.
5. Add reasonable image/payload size limits and configurable artifact output directory. Do not copy screenshots into source-controlled directories or leak unrelated user files.
6. Verify campaign/menu/context behaviour and process exit behaviour. Capturing must not mutate campaign state.
7. Document dependencies, platform limits, artifact retention/cleanup and visually checkable examples.

## Acceptance criteria
- New capture yields viewable PNG and correlated metadata.
- A prior TGA/PNG cannot satisfy a fresh request.
- Missing screenshot, conversion error, process death and timeout are differentiated.
- Multiple consecutive captures produce distinct files and hashes when image content differs.
- The existing screenshot tool remains backwards-compatible or has an explicit documented migration.

## Verification
Offline tests with fixture TGAs (including malformed and truncated files), stale-file tests and image metadata assertions. If a test fixture cannot legally be included, generate a tiny synthetic TGA. Live checkpoint: capture two different visible game states and verify both are readable. Do not call this visually verified until the image was actually inspected.

## Deliverables
MCP capture changes, converter/tool updates, tests and documentation.
