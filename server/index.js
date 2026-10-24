#!/usr/bin/env node

/**
 * WH3-MCP Server
 *
 * MCP server that controls Warhammer 3 for automated mod testing.
 * Communicates with the wh3_mcp_server Lua mod via JSON files in the WH3 install directory.
 *
 * Tools exposed to the agent:
 *   wh3_start          - Launch Warhammer 3
 *   wh3_stop           - Stop a WH3 process owned by this MCP
 *   wh3_status         - Check if WH3 is running
 *   wh3_send_command   - Send a command to the WH3 mod and wait for result
 *   wh3_ping           - Test if the mod is responding
 *   wh3_wait_for_mod   - Poll until the mod responds (game is loaded)
 *
 * The server connects via MCP stdio transport (Origami launches this as a subprocess).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'url';
import { CommandTransport } from './lib/command-transport.js';
import { DiagnosticsReader } from './lib/diagnostics.js';
import { normalizeUiInspectionArgs } from './lib/ui-inspection.js';
import { waitForConditions } from './lib/wait-for.js';
import { ScreenshotArtifactManager } from './lib/screenshot-artifacts.js';
import { SessionEvidenceManager } from './lib/session-evidence.js';
import { normalizeSoakArgs, runSoak, SOAK_PERMISSIONS } from './lib/soak.js';
import { resolveBeneathRoot, resolveWh3Install, Wh3ProcessManager } from './lib/wh3-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_REPO_ROOT = resolve(__dirname, '..');
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Resolve once at server startup. An invalid explicit override is a hard error;
// it is never replaced by a guessed fallback path.
const WH3_INSTALL = await resolveWh3Install();
const WH3_PATH = WH3_INSTALL.ok ? WH3_INSTALL.path : null;
const WH3_EXE = WH3_INSTALL.ok ? WH3_INSTALL.exe : null;

// Files live in the validated WH3 root. Lua opens these names relative to the
// game process working directory, so there is no reason to allow arbitrary
// paths here.
const COMMAND_FILE = WH3_PATH ? resolveBeneathRoot(WH3_PATH, 'wh3_mcp_command.json') : null;
const RESULT_FILE = WH3_PATH ? resolveBeneathRoot(WH3_PATH, 'wh3_mcp_result.json') : null;

// cm_search docs corpus: committed in server/data, deployed to the WH3 root.
const DOCS_SRC = join(__dirname, 'data', 'wh3_mcp_docs.tsv');
const DOCS_DEST = WH3_PATH ? resolveBeneathRoot(WH3_PATH, 'wh3_mcp_docs.tsv') : null;

function deployDocsCorpus() {
  if (!DOCS_DEST) return;
  try {
    if (!existsSync(DOCS_SRC)) {
      console.error('[wh3-mcp] docs corpus missing (server/data/wh3_mcp_docs.tsv) - wh3_cm_search will run introspection-only');
      return;
    }
    const src = statSync(DOCS_SRC);
    if (existsSync(DOCS_DEST)) {
      const dest = statSync(DOCS_DEST);
      if (dest.size === src.size && dest.mtimeMs >= src.mtimeMs) return;
    }
    copyFileSync(DOCS_SRC, DOCS_DEST);
    console.error(`[wh3-mcp] deployed docs corpus (${src.size} bytes) to ${DOCS_DEST}`);
  } catch (err) {
    console.error('[wh3-mcp] docs corpus deploy failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// WH3 Process Management
// ---------------------------------------------------------------------------

function externalWh3Running() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/fi', 'IMAGENAME eq Warhammer3.exe', '/nh'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    return /Warhammer3\.exe/i.test(out);
  } catch {
    return false;
  }
}

const processManager = new Wh3ProcessManager({
  install: WH3_INSTALL,
  externalProcessProbe: externalWh3Running,
});

function isWh3Running() {
  return processManager.isRunning();
}

async function startWh3() {
  const result = await processManager.start();
  if (result.status === 'started') {
    await commandTransport?.reset({ quarantine: true });
    diagnostics.beginRun(result.run_id);
  } else if (result.status === 'already_running' && diagnostics.runId === null) {
    diagnostics.beginRun(result.run_id ?? 'external-running');
  }
  return result;
}

async function stopWh3() {
  const result = await processManager.stop();
  if (result.stopped === true) await commandTransport?.reset({ quarantine: true });
  return result;
}

function getWh3Status() {
  return {
    ...processManager.getStatus(),
    install_resolution: WH3_INSTALL.ok ? { source: WH3_INSTALL.source } : {
      code: WH3_INSTALL.code,
      error: WH3_INSTALL.error,
      attempts: WH3_INSTALL.attempts,
    },
    command_file: COMMAND_FILE,
    result_file: RESULT_FILE,
    transport: commandTransport?.getStatus?.() ?? null,
    diagnostics: {
      session_id: diagnostics.sessionId,
      run_id: diagnostics.runId,
      baseline_at_ms: diagnostics.baselineAtMs,
    },
  };
}

// ---------------------------------------------------------------------------
// File-based Communication (protocol v2)
// ---------------------------------------------------------------------------

const commandTransport = WH3_PATH ? new CommandTransport({
  rootDir: WH3_PATH,
  commandFile: COMMAND_FILE,
  resultFile: RESULT_FILE,
  isGameRunning: isWh3Running,
}) : null;

const diagnostics = new DiagnosticsReader({
  rootDir: WH3_PATH,
  sessionId: commandTransport?.sessionId ?? `server-unconfigured-${Date.now()}`,
});

processManager.onExit((info) => {
  commandTransport?.markGameExited(info);
});

async function sendCommand(command, params = {}, timeoutMs = 60000) {
  const startedAtMs = Date.now();
  let reply;
  if (!commandTransport) {
    reply = {
      status: 'error',
      error: {
        code: 'NOT_READY',
        message: 'WH3 install path is unavailable',
        details: { install_error: WH3_INSTALL.error, path_code: WH3_INSTALL.code },
      },
    };
  } else {
    reply = await commandTransport.send(command, params, timeoutMs);
  }
  sessionEvidence?.recordCommand(command, reply, { startedAtMs, endedAtMs: Date.now() });
  return reply;
}

const screenshotArtifacts = new ScreenshotArtifactManager({
  rootDir: WH3_PATH,
  sourceRepoRoot: SOURCE_REPO_ROOT,
  sessionId: commandTransport?.sessionId ?? `server-unconfigured-${Date.now()}`,
  getRunId: () => processManager.getStatus().run_id ?? diagnostics.runId,
  isGameRunning: isWh3Running,
  sendCommand,
});

const sessionEvidence = new SessionEvidenceManager({
  sourceRepoRoot: SOURCE_REPO_ROOT,
  getIdentity: () => {
    const processStatus = processManager.getStatus();
    const transport = commandTransport?.getStatus?.() ?? null;
    return {
      running: processStatus.running,
      owned: processStatus.owned,
      pid: processStatus.pid ?? null,
      run_id: processStatus.run_id ?? diagnostics.runId ?? null,
      session_id: transport?.session_id ?? diagnostics.sessionId,
      transport_state: transport?.state ?? null,
      next_request_id: transport?.next_request_id ?? null,
      context: transport?.context ?? null,
    };
  },
  getVersions: () => {
    const transport = commandTransport?.getStatus?.() ?? null;
    return {
      server_version: SERVER_VERSION,
      protocol: transport?.protocol ?? 2,
      lua_script_version: transport?.script_version ?? null,
    };
  },
  getDiagnostics: ({ extraFiles = [], since = null } = {}) => diagnostics.check({ extraFiles, since }),
  getSituation: () => sendCommand('get_situation', {}, 15000),
});

let lastSoakReport = null;

// ---------------------------------------------------------------------------
// Script-error surfacing — read log files straight from disk, no game
// round-trip. Sources: the mod's own script_error capture file, the newest
// CA script_log_*.txt (only written when CA's log-to-file debug config is
// on), and any extra mod logs the caller names (they live in the WH3 root,
// e.g. Shenzoo_log.txt, lua_mod_log.txt).
// ---------------------------------------------------------------------------

// Diagnostics are centralized in DiagnosticsReader (disk-only; no game round-trip).

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: 'wh3-mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'wh3_start',
      description: 'Launch Warhammer 3. Mods load via user.script.txt (must be read-only). Skips intro videos. Returns immediately.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_stop',
      description: 'Stop a Warhammer 3 process launched by this MCP: request graceful termination, then use bounded force termination only if needed. An unrelated already-running WH3 process is never adopted or killed.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_status',
      description: 'Check if Warhammer 3 is running and show paths.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_begin_test_session',
      description: 'Begin a bounded evidence session tied to the current MCP transport/process run. Captures a fresh log boundary and starting get_situation observation; it does not declare anything RUNTIME_VERIFIED.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional short scenario/test label.' },
          extra_files: { type: 'array', items: { type: 'string' }, description: 'Optional extra WH3-root log files to include in the per-session diagnostic boundary (max 10).' },
          capture_start_screenshot: { type: 'boolean', description: 'Also capture a fresh screenshot artifact after the session begins (default false).' },
        },
      },
    },
    {
      name: 'wh3_end_test_session',
      description: 'End the active evidence session with an ending get_situation observation and fresh diagnostics since its starting log cursor. Does not grant RUNTIME_VERIFIED status.',
      inputSchema: {
        type: 'object',
        properties: {
          capture_end_screenshot: { type: 'boolean', description: 'Capture a fresh screenshot artifact before ending the session (default false).' },
        },
      },
    },
    {
      name: 'wh3_export_evidence',
      description: 'Atomically export the current/last test-session evidence manifest plus bounded command and diagnostic documents. Returns compact paths/synopsis, not unbounded logs or image bytes.',
      inputSchema: {
        type: 'object',
        properties: {
          include_active: { type: 'boolean', description: 'Allow a snapshot export while a session is still active (default true).' },
        },
      },
    },
    {
      name: 'wh3_ping',
      description: 'Test if the WH3 MCP mod is responding. The mod must be loaded in a campaign.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_wait_for_mod',
      description: 'Poll the mod until it responds, or timeout. Use after starting WH3 to wait for campaign load.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout_seconds: {
            type: 'number',
            description: 'Maximum seconds to wait (default 120)',
            default: 120,
          },
        },
      },
    },
    {
      name: 'wh3_start_campaign',
      description: 'Click the Start Campaign button (UI click, not frontend API). Must be on lord_select screen with a lord selected. Waits up to 120s for campaign to load.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_key: {
            type: 'string',
            description: 'Campaign key (default wh3_main_combi)',
            default: 'wh3_main_combi',
          },
          faction_key: {
            type: 'string',
            description: 'Faction key (default mixer_cth_shenzoo)',
            default: 'mixer_cth_shenzoo',
          },
          party_key: {
            type: 'string',
            description: 'Political party key (optional)',
          },
        },
      },
    },
    {
      name: 'wh3_load_campaign',
      description: 'Load a campaign save file. Works reliably.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Save filename (e.g. Shenzoo\'s Expedition.13055359887.save)',
          },
        },
        required: ['filename'],
      },
    },
    {
      name: 'wh3_continue_campaign',
      description: 'Load the most recent campaign save.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_click_ui',
      description: 'Click a UI component by path. Use for navigating menus when frontend.start_campaign() fails.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'array',
            items: { type: 'string' },
            description: 'Component path, e.g. ["button_campaign"] or ["list_parent","CcoRecord","button_campaign_entry"]',
          },
          child_index: {
            type: 'number',
            description: 'Optional: click child at this index instead of the component itself',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'wh3_list_ui',
      description: 'Dump the UI component tree to the debug log. Use to discover component names. Optionally dump only a subtree, limit the depth, skip hidden components, or return the tree inline.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional component path to start from, e.g. ["hud_campaign","faction_buttons_docker"]. Omit to dump from the UI root.',
          },
          max_depth: {
            type: 'number',
            description: 'Maximum depth to walk (default 12)',
            default: 12,
          },
          visible_only: {
            type: 'boolean',
            description: 'Skip hidden components and their children (default false)',
            default: false,
          },
          return_tree: {
            type: 'boolean',
            description: 'Also return the tree text in the result (truncated at 200000 chars). Default false — the dump always goes to the debug log.',
            default: false,
          },
        },
      },
    },
    {
      name: 'wh3_inspect_ui',
      description: 'Read one UI component as bounded structured data without clicking it. Exact component ids are required. If the id is ambiguous, provide an exact direct-child path or parent_path. Geometry is the raw WH3 UIC coordinate space; it is not converted to desktop/screenshot coordinates.',
      inputSchema: {
        type: 'object',
        properties: {
          component_id: {
            type: 'string',
            description: 'Exact UI component Id(), e.g. "wat_harness_launcher".',
          },
          path: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional exact direct-child path to the target. It must end with component_id. Include the UI root id only if known.',
          },
          parent_path: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional exact direct-child path to the target parent. The target must be a direct child of that parent.',
          },
          max_depth: {
            type: 'number',
            description: 'Descendant depth to return (default 2, clamped 0..8).',
            default: 2,
          },
          max_nodes: {
            type: 'number',
            description: 'Maximum selected+descendant nodes to inspect (default 64, clamped 1..256).',
            default: 64,
          },
        },
        required: ['component_id'],
      },
    },
    {
      name: 'wh3_list_races',
      description: 'List all available races from the race selection popup. Returns each race with index, id, and culture key.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_list_lords',
      description: 'List all available lords for the currently selected race. Returns each lord with index, id, and faction key.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_select_race',
      description: 'Select a race by culture key (e.g. wh3_main_ksl_kislev) or index. See wh3_list_races for available races.',
      inputSchema: {
        type: 'object',
        properties: {
          culture_key: {
            type: 'string',
            description: 'Culture key to select (e.g. wh3_main_ksl_kislev, wh3_main_cth_cathay). Mutually exclusive with index.',
          },
          index: {
            type: 'number',
            description: 'Index of race in the list (0-based, skip template at index 0). Mutually exclusive with culture_key.',
          },
        },
      },
    },
    {
      name: 'wh3_select_lord',
      description: 'Select a lord by faction key (e.g. wh3_main_ksl_ursun_revivalists) or index. See wh3_list_lords for available lords.',
      inputSchema: {
        type: 'object',
        properties: {
          faction_key: {
            type: 'string',
            description: 'Faction key to select (e.g. wh3_main_ksl_ursun_revivalists, mixer_cth_shenzoo). Mutually exclusive with index.',
          },
          index: {
            type: 'number',
            description: 'Index of lord in the list (0-based, skip template at index 0). Mutually exclusive with faction_key.',
          },
        },
      },
    },
    {
      name: 'wh3_new_game',
      description: 'Click Campaign button, then click New Campaign after 2s delay. Returns immediately; the second click is scheduled. Wait 3-4s before calling next command.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_select_campaign',
      description: 'Select a campaign type by name: prologue, roc (realm_of_chaos), or ie (immortal_empires). Must be on campaign select screen first.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_type: {
            type: 'string',
            description: 'Campaign type: "prologue", "roc" (realm_of_chaos), or "ie" (immortal_empires)',
          },
        },
        required: ['campaign_type'],
      },
    },
    {
      name: 'wh3_get_screen',
      description: 'Detect what screen we are on: main_menu, campaign_select, lord_select, load_game, or campaign. When on load_game, also returns playthrough and save details.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_list_playthroughs',
      description: 'List all playthroughs on the load game screen. Returns each with index, campaign type (e.g. Immortal Empires), and faction name (e.g. The Ice Court). Must be on load_game screen first.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_list_saves',
      description: 'List all save games in the selected playthrough. Returns each with index, save name text, and turn number. Must be on load_game screen with a playthrough selected.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_select_playthrough',
      description: 'Select a playthrough by index on the load game screen. Use get_screen first to see available playthroughs.',
      inputSchema: {
        type: 'object',
        properties: {
          index: {
            type: 'number',
            description: 'Playthrough index (0-based)',
          },
        },
        required: ['index'],
      },
    },
    {
      name: 'wh3_select_save',
      description: 'Select a save game by index or name on the load game screen. Use get_screen first to see available saves with names and turn numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          index: {
            type: 'number',
            description: 'Save index (0-based). Mutually exclusive with name.',
          },
          name: {
            type: 'string',
            description: 'Save name substring to match. Mutually exclusive with index.',
          },
        },
      },
    },
    {
      name: 'wh3_confirm_load',
      description: 'Click the Confirm Load button and wait for campaign to load. No Continue button handling needed (load games skip it).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_dismiss_advisor',
      description: 'Close the default game advisor popup (e.g. "Take Refuge" introduction). Clicks the close button in the advice panel.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_accept_mission',
      description: 'Accept/dismiss the current mission popup (e.g. "Mission Issued!"). Clicks the accept button in the mission review panel.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_close_shenzoo_advisor',
      description: 'Close the Shenzoo mod custom advisor popup. Clicks the exit button in the passing_advisor_menu.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_screenshot',
      description: 'Capture a fresh in-game screenshot, wait for a new stable TGA, convert it to a verified PNG artifact, and return the PNG as MCP image content when within the inline size limit. The legacy filename argument is now a basename/prefix; the actual capture filename is always unique and correlated to session/run identity.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Legacy-compatible basename/prefix (default wh3_mcp_screenshot.tga). Paths are rejected; the actual TGA filename is unique per request.',
            default: 'wh3_mcp_screenshot.tga',
          },
          timeout_ms: { type: 'number', description: 'Bounded wait for the newly-created screenshot file to become stable (500..30000 ms).' },
        },
      },
    },
    {
      name: 'wh3_open_menu',
      description: 'Open the in-campaign ESC menu (clicks menu_bar > buttongroup > button_menu). Returns menu_open true/false. The ESC menu is where Save, Load, Exit to Main Menu and Exit to Windows live.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_resume',
      description: 'Close the ESC menu and resume the campaign (clicks button_resume). Returns resumed true/false. Requires the ESC menu to be open.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_confirm_dialog',
      description: 'Click the confirm (tick) button on the visible confirmation dialog. Picks the on-screen root-level dialogue_box, not the hidden one inside hud_campaign. Returns the dialog text so you can see what was confirmed.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_cancel_dialog',
      description: 'Click the cancel button on the visible confirmation dialog. Returns the dialog text so you can see what was dismissed.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_quit_to_menu',
      description: 'Quit the campaign back to the main menu: opens the ESC menu if needed, clicks Exit to Main Menu, then confirms the "you will lose all unsaved progress" dialog. Waits for the transition (the game reloads all mod scripts), up to 120s. UNSAVED PROGRESS IS LOST — save first if you need the state.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_exit_windows',
      description: 'Quit Warhammer 3 entirely (ESC menu > Exit to Windows > confirm). The game process dies, so success is confirmed either by the result the mod writes just before confirming, or by the process disappearing within ~15s. UNSAVED PROGRESS IS LOST.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_end_turn',
      description: 'End the current campaign turn. method "api" (default) calls cm:end_turn(); method "ui" clicks the END TURN button. Returns immediately with the turn number BEFORE ending — the turn advance is asynchronous, so poll wh3_send_command get_status to see the new turn.',
      inputSchema: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            description: '"api" (cm:end_turn, default) or "ui" (click button_end_turn)',
            default: 'api',
          },
          force: {
            type: 'boolean',
            description: 'Force the turn to end at the next opportunity. Only intended for the player faction. Default false.',
            default: false,
          },
        },
      },
    },
    {
      name: 'wh3_get_hud',
      description: 'Read the campaign HUD state: turn number, current notification text ("Lord not moved" etc.), the bottom-right radial buttons with their visibility, the top-left menu bar button ids, whether END TURN is visible, and which panel is open.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_open_panel',
      description: 'Open a campaign panel by clicking its HUD button. All four routes verified live. The panel needs a frame to open — confirm with wh3_get_screen or wh3_get_hud.',
      inputSchema: {
        type: 'object',
        properties: {
          panel: {
            type: 'string',
            description: 'One of: technology, diplomacy, missions, factions',
          },
        },
        required: ['panel'],
      },
    },
    {
      name: 'wh3_close_panel',
      description: 'Close an open campaign panel. Tries CampaignUI.ClosePanel first, then the panel\'s own verified close button (missions has no close button, so its radial button is re-clicked as a toggle). Omit panel to close whichever panel is currently open.',
      inputSchema: {
        type: 'object',
        properties: {
          panel: {
            type: 'string',
            description: 'One of: technology, diplomacy, missions, factions. Omit to auto-detect the open panel.',
          },
        },
      },
    },
    {
      name: 'wh3_get_camera',
      description: 'Read the campaign camera position: x, y (display coords of the look-at target), d (distance to target — this is the zoom level, smaller = closer), b (bearing in radians), h (height above target).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_set_camera',
      description: 'Move the camera instantly (hard cut) to the given position. Every field is optional and defaults to the current value, so you can change zoom alone by passing only d.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Display x of the look-at target' },
          y: { type: 'number', description: 'Display y of the look-at target' },
          d: { type: 'number', description: 'Distance to target (zoom; smaller = more zoomed in)' },
          b: { type: 'number', description: 'Bearing in radians' },
          h: { type: 'number', description: 'Camera height above the target' },
        },
      },
    },
    {
      name: 'wh3_pan_camera',
      description: 'Scroll the camera smoothly from where it is now to the given position over "time" seconds. Same 5 optional fields as wh3_set_camera, all defaulting to the current value.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Display x of the look-at target' },
          y: { type: 'number', description: 'Display y of the look-at target' },
          d: { type: 'number', description: 'Distance to target (zoom)' },
          b: { type: 'number', description: 'Bearing in radians' },
          h: { type: 'number', description: 'Camera height above the target' },
          time: { type: 'number', description: 'Scroll duration in seconds (default 2)', default: 2 },
        },
      },
    },
    {
      name: 'wh3_zoom_to',
      description: 'Bring a character or a region on screen. Pass cqi to zoom to that character (uses its display position), or region to pan to that region\'s settlement. Useful before wh3_select_army, which needs the target rendered to click it.',
      inputSchema: {
        type: 'object',
        properties: {
          cqi: {
            type: 'number',
            description: 'Character command-queue-index (see wh3_get_armies char_cqi). Mutually exclusive with region.',
          },
          region: {
            type: 'string',
            description: 'Region key, e.g. wh3_main_combi_region_altdorf. Mutually exclusive with cqi.',
          },
          time: {
            type: 'number',
            description: 'Pan duration in seconds for the region variant (default 2)',
            default: 2,
          },
        },
      },
    },
    {
      name: 'wh3_get_armies',
      description: 'List a faction\'s military forces: mf_cqi, char_cqi, general name, subtype, logical position (the integer grid that move/teleport use), display position (camera space), unit count, and whether it is that faction\'s turn. Forces with no general are returned with no_general true.',
      inputSchema: {
        type: 'object',
        properties: {
          faction: {
            type: 'string',
            description: 'Faction key (e.g. wh_main_grn_greenskins). Defaults to the local player faction.',
          },
        },
      },
    },
    {
      name: 'wh3_move_army',
      description: 'Order an army to path-move to a LOGICAL map position (see logical x/y from wh3_get_armies — display coords will not work). Normal movement rules apply: only on that faction\'s turn, open terrain only, not into settlements or enemy armies. Fire-and-forget: the engine returns no success flag.',
      inputSchema: {
        type: 'object',
        properties: {
          cqi: { type: 'number', description: 'Character cqi of the army general (char_cqi from wh3_get_armies)' },
          x: { type: 'number', description: 'Target LOGICAL x' },
          y: { type: 'number', description: 'Target LOGICAL y' },
          queued: {
            type: 'boolean',
            description: 'Queue the order behind the character\'s current action instead of replacing it (default false)',
            default: false,
          },
        },
        required: ['cqi', 'x', 'y'],
      },
    },
    {
      name: 'wh3_teleport_army',
      description: 'Teleport an army instantly to a LOGICAL map position, bypassing movement points. Returns teleported true/false (the engine reports success here, unlike move). Only valid on that faction\'s turn.',
      inputSchema: {
        type: 'object',
        properties: {
          cqi: { type: 'number', description: 'Character cqi of the army general' },
          x: { type: 'number', description: 'Target LOGICAL x' },
          y: { type: 'number', description: 'Target LOGICAL y' },
        },
        required: ['cqi', 'x', 'y'],
      },
    },
    {
      name: 'wh3_select_army',
      description: 'EXPERIMENTAL. Select an army the way a player would, by clicking its map plate — WH3 exposes no scripted selection setter. Matches on the plate name, so the army must be on screen (call wh3_zoom_to first). Returns found_label false when no matching plate was rendered.',
      inputSchema: {
        type: 'object',
        properties: {
          cqi: {
            type: 'number',
            description: 'Character cqi; its name is resolved and matched against the map plates. Mutually exclusive with name.',
          },
          name: {
            type: 'string',
            description: 'Army/general name as shown on the map plate, e.g. "Skram da Roughey". Mutually exclusive with cqi.',
          },
        },
      },
    },
    {
      name: 'wh3_save_game',
      description: 'Save the campaign with a chosen name, through the UI (ESC menu > Save > type name > confirm) — WH3 has no scripted named-save API. Pass the name WITHOUT a .save extension; the game appends its own suffix. Confirms the overwrite dialog if one appears.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Save name, no extension (default wh3_mcp_autosave)',
            default: 'wh3_mcp_autosave',
          },
          overwrite: {
            type: 'boolean',
            description: 'Confirm the overwrite dialog when the name already exists (default true). Set false to leave the dialog up.',
            default: true,
          },
        },
      },
    },
    {
      name: 'wh3_quick_save',
      description: 'Trigger an unnamed engine save via cm:save(). Faster and more reliable than the UI flow, but you do not choose the name — use wh3_save_game when the name matters.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_get_situation',
      description: 'CALL THIS INSTEAD OF A SCREENSHOT. One structured read of everything you would otherwise need to see: context (campaign/main_menu/frontend), turn, faction, is_players_turn, treasury, the pending-battle flags, the current HUD notification, whether the game is saving, a strings_ok health flag — and "blocking": an ORDERED array of everything demanding a response right now (dialog, event/dilemma/incident with its choices, pre_battle, post_battle, open panel, esc_menu, advisor/mission popups). Handle blocking[0] first. Vision is unavailable whenever another window covers the game, so this is the primary way to know where you are.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_wait_for',
      description: 'Wait for bounded typed game/UI conditions using fresh wh3_get_situation and wh3_inspect_ui observations. Read-only: it never dismisses blockers or changes game state. Default mode is all; any is available explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          conditions: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['context', 'turn', 'saving', 'blocking.kind', 'ui.exists', 'ui.visible', 'ui.parent_id'],
                  description: 'Typed condition name. Arbitrary expressions/eval are not supported.',
                },
                equals: { description: 'Expected value; type depends on the condition.' },
                component_id: { type: 'string', description: 'Required for ui.* conditions.' },
                path: { type: 'array', items: { type: 'string' }, description: 'Optional exact target path for ui.* conditions.' },
                parent_path: { type: 'array', items: { type: 'string' }, description: 'Optional exact parent path for ui.* conditions.' },
              },
              required: ['type'],
            },
          },
          mode: {
            type: 'string',
            enum: ['all', 'any'],
            default: 'all',
            description: 'all requires every condition in one observation; any succeeds when one condition matches.',
          },
          timeout_ms: {
            type: 'number',
            default: 30000,
            description: 'Finite wait bound in milliseconds, clamped to 100..120000.',
          },
          poll_interval_ms: {
            type: 'number',
            default: 250,
            description: 'Asynchronous polling interval in milliseconds, clamped to 50..5000.',
          },
          max_observations: {
            type: 'number',
            description: 'Maximum fresh observations, clamped to 1..500. Defaults from timeout/poll interval.',
          },
        },
        required: ['conditions'],
      },
    },
    {
      name: 'wh3_read_event',
      description: 'Read the open dilemma or incident panel on its own: event_type ("dilemma" | "incident" | "other"), title, body text, and for dilemmas every choice with its 1-based index, button text, and payload (effect) lines. Errors when no event panel is open.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_answer_dilemma',
      description: 'Answer the open dilemma by clicking one of its choice buttons. choice is 1-BASED (1 = the first option); the engine confirms with DilemmaChoiceMadeEvent, whose own choice() is 0-indexed. Read the options first with wh3_read_event or wh3_get_situation. Incidents cannot be answered — dismiss them instead.',
      inputSchema: {
        type: 'object',
        properties: {
          choice: {
            type: 'number',
            description: '1-based choice index (1..4), matching the index field from wh3_read_event',
          },
        },
        required: ['choice'],
      },
    },
    {
      name: 'wh3_dismiss_event',
      description: 'Dismiss the open incident/event panel (clicks events > button_set > accept_holder > button_accept). Dilemmas keep that button hidden — use wh3_answer_dilemma for those.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_trigger_dilemma',
      description: 'Fire a dilemma at a faction via cm:trigger_dilemma_raw. The engine validates the record itself, so issued=false means it REFUSED the record (unmet conditions, missing targets, or a legacy WH1-era row that never fires in Immortal Empires) — that is not an error, pick another key. Known-good test key: wh2_dlc15_dilemma_dragon_encounter_generic_moon. Poll wh3_get_situation afterwards to see the panel.',
      inputSchema: {
        type: 'object',
        properties: {
          dilemma_key: {
            type: 'string',
            description: 'Dilemma record key from the dilemmas table',
          },
          faction: {
            type: 'string',
            description: 'Target faction KEY (a string, never an object). Defaults to the local player faction.',
          },
          fire_immediately: {
            type: 'boolean',
            description: 'Skip the record\'s turn-delay/wait period (default true)',
            default: true,
          },
          whitelist: {
            type: 'boolean',
            description: 'Bypass event-feed suppression (default true)',
            default: true,
          },
        },
        required: ['dilemma_key'],
      },
    },
    {
      name: 'wh3_trigger_incident',
      description: 'Fire an incident at a faction via cm:trigger_incident. Same semantics as wh3_trigger_dilemma: issued=false means the engine rejected the record, not that the call failed. Known-good test key: wh_main_incident_grn_waaagh_success_raze. Incidents are dismissed with wh3_dismiss_event.',
      inputSchema: {
        type: 'object',
        properties: {
          incident_key: {
            type: 'string',
            description: 'Incident record key from the incidents table',
          },
          faction: {
            type: 'string',
            description: 'Target faction KEY (a string). Defaults to the local player faction.',
          },
          fire_immediately: {
            type: 'boolean',
            description: 'Skip the record\'s turn-delay/wait period (default true)',
            default: true,
          },
        },
        required: ['incident_key'],
      },
    },
    {
      name: 'wh3_attack',
      description: 'Order a character to attack another character (cm:attack) or a SETTLEMENT (cm:attack_region — pass target_settlement with the region key; a "settlement:" lookup through cm:attack silently never executes). Only works on that faction\'s turn. The attacker paths on model time, so this returns immediately — poll wh3_get_situation for a "pre_battle" blocking entry. Traps learned live: re-issuing an attack RESTARTS pathing (wait instead); a long approach drains action points and stalls silently (send replenish=true; the result reports action_points_percent); crossing a new faction\'s land raises a move_options "Declare War?" blocker (see wh3_answer_move_options). If the approach is hopeless terrain, wh3_send_command teleport_army with near_settlement snaps to a valid adjacent tile first.',
      inputSchema: {
        type: 'object',
        properties: {
          attacker_cqi: {
            type: 'number',
            description: 'Attacking character cqi (char_cqi from wh3_get_armies)',
          },
          target_cqi: {
            type: 'number',
            description: 'Target character cqi (character battles)',
          },
          target_settlement: {
            type: 'string',
            description: 'Region key to attack the settlement of (settlement battles; uses cm:attack_region)',
          },
          lay_siege: {
            type: 'boolean',
            description: 'Lay siege on a character-target garrison (default false; ignored for target_settlement)',
            default: false,
          },
          replenish: {
            type: 'boolean',
            description: 'Refill the attacker\'s action points first (default false)',
          },
        },
        required: ['attacker_cqi'],
      },
    },
    {
      name: 'wh3_autoresolve_battle',
      description: 'Resolve the open pre-battle WITHOUT loading the battle map: optionally rig the win, click Autoresolve, then clear the post-battle panel (captive choice or accept) and report the outcome. Requires the pre-battle panel to be open. **CTD WARNING: never call cm:win_next_autoresolve_battle yourself via wh3_eval without a pending battle — it crashes the game to desktop (reproduced twice).** This tool guards that call with cm:is_pending_battle_active() and refuses rather than crash. Takes several seconds; the mod answers when the results panel is gone.',
      inputSchema: {
        type: 'object',
        properties: {
          win: {
            type: 'boolean',
            description: 'Rig the outcome so the local faction wins (default true). false leaves the engine\'s own prediction alone.',
            default: true,
          },
          captives: {
            type: 'string',
            description: 'What to do with captives when a victory asks: "kill" (default), "enslave", or "release"',
            default: 'kill',
          },
        },
      },
    },
    {
      name: 'wh3_retreat_battle',
      description: 'Retreat from the open pre-battle instead of fighting it (clicks the visible button_retreat). Errors when the button is hidden — retreat is not offered for every battle, and never twice in a row.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'wh3_open_diplomacy',
      description: 'Open the diplomacy screen and optionally select a faction\'s row in the list. Only factions you have MET appear, so faction_row_clicked comes back false for unknown ones. To CHANGE a diplomatic state without negotiating, use wh3_force_diplomacy instead — it needs no UI at all.',
      inputSchema: {
        type: 'object',
        properties: {
          faction: {
            type: 'string',
            description: 'Faction key whose row to click, e.g. wh_main_grn_greenskins. Omit to just open the panel.',
          },
        },
      },
    },
    {
      name: 'wh3_force_diplomacy',
      description: 'Force a diplomatic state between two factions with no negotiation and no UI (cm:force_declare_war / force_make_peace / force_alliance / force_make_trade_agreement / force_grant_military_access). War and peace also report at_war before and after so you can see the change landed.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'One of: declare_war, make_peace, alliance_military, alliance_defensive, trade_agreement, military_access',
          },
          faction_a: {
            type: 'string',
            description: 'Acting faction key (the declarer/granter). Defaults to the local player faction.',
          },
          faction_b: {
            type: 'string',
            description: 'Target faction key',
          },
          invite_a_allies: {
            type: 'boolean',
            description: 'declare_war only: let faction A\'s allies join (default false)',
            default: false,
          },
          invite_b_allies: {
            type: 'boolean',
            description: 'declare_war only: let faction B\'s allies join (default false)',
            default: false,
          },
        },
        required: ['action', 'faction_b'],
      },
    },
    {
      name: 'wh3_get_diplomacy',
      description: 'Read a faction\'s diplomatic state: at_war flag, at_war_with, allies, and trade_partners as faction-key arrays. Any accessor the build does not answer is listed under "unavailable" instead of being faked.',
      inputSchema: {
        type: 'object',
        properties: {
          faction: {
            type: 'string',
            description: 'Faction key. Defaults to the local player faction.',
          },
        },
      },
    },
    {
      name: 'wh3_occupy_choice',
      description: 'Decide the settlement_captured occupation panel that appears after taking a settlement: Occupy / Loot & Occupy / Sack / Raze / etc. ONE click decides (no confirm step). wh3_get_situation reports the panel as kind "occupation" with the available option texts; match by text (case-insensitive substring, exact wins) or 1-based index. The panel option ids are db record ids that vary by faction — never hardcode them.',
      inputSchema: {
        type: 'object',
        properties: {
          choice: {
            description: 'Option text (e.g. "occupy", "sack", "raze", "loot") or 1-based index. Default "occupy".',
          },
        },
      },
    },
    {
      name: 'wh3_answer_move_options',
      description: 'Answer a move_options interruption (the "Declare War? / Cancel Move" style panel a move or attack order can raise — it is NOT a dialog; wh3_get_situation reports it as kind "move_options" with the option texts). Picks the given option bar; a Declare War option routes through the diplomacy screen\'s confirmation, which this tool auto-confirms and closes. NOTE: the original move order is CONSUMED by the interruption — reissue the move/attack afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          option: { type: 'number', description: '1-based option index from the move_options blocking entry' },
          confirm_war: { type: 'boolean', description: 'Auto-confirm the war declaration on the diplomacy screen (default true)' },
        },
        required: ['option'],
      },
    },
    {
      name: 'wh3_soak_turns',
      description: 'Bounded conservative multi-turn soak. Ending turns is the requested scenario action; decision blockers STOP by default. Battles, dilemmas, occupation choices, dialog confirmation, event dismissal/suppression require explicit named permissions. The call blocks while polling but preserves partial reporting on abort, timeout or process exit.',
      inputSchema: {
        type: 'object',
        properties: {
          turns: { type: 'number', description: 'Positive integer full turn cycles (default 5, max 200). Zero is rejected instead of silently becoming one.' },
          battle_policy: { type: 'string', enum: ['autoresolve', 'retreat', 'stop'], description: 'Default stop. autoresolve/retreat require permissions:["battle"]. Retreat no longer silently falls back to autoresolve.' },
          rig_battles: { type: 'boolean', description: 'Rig explicitly-permitted autoresolves as wins. Requires battle permission.' },
          captives: { type: 'string', enum: ['kill', 'enslave', 'release'], description: 'Captive choice used only when battle automation is explicitly permitted (default kill).' },
          dilemma_choice: { type: 'number', description: 'Explicit 1-based dilemma choice (1..4). Requires permissions:["dilemma"]. Omit to stop on dilemmas.' },
          occupation: { type: 'string', description: 'Explicit occupation option text. Requires permissions:["occupation"]. Omit to stop on settlement capture.' },
          confirm_dialogs: { type: 'boolean', description: 'Allow generic confirmation-dialog clicks. Requires permissions:["confirm_dialogs"]. Default false.' },
          dismiss_events: { type: 'boolean', description: 'Allow dismissing non-dilemma event UI. Requires permissions:["dismiss_events"]. Default false.' },
          suppress_events: { type: 'boolean', description: 'Suppress event UI for the run. Requires permissions:["suppress_events"]. Default false.' },
          permissions: { type: 'array', items: { type: 'string', enum: SOAK_PERMISSIONS }, description: 'Named scenario permissions for potentially consequential automatic actions.' },
          max_seconds_per_turn: { type: 'number', description: 'Per-turn deadline, integer 5..900 seconds (default 300).' },
          max_runtime_seconds: { type: 'number', description: 'Overall soak deadline, integer 1..7200 seconds. Defaults to a finite bound derived from turn count/deadline.' },
        },
      },
    },
    {
      name: 'wh3_soak_status',
      description: 'Progress of the running (or the last finished) soak: turns completed, events dismissed, dilemmas answered, battles with outcomes, notes, strings_ok.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wh3_soak_abort',
      description: 'Stop the running soak; the final summary is then available via wh3_soak_status (and is returned by the still-blocking wh3_soak_turns call).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wh3_check_errors',
      description: 'Read script errors and log output from disk with NO game round-trip (works even when the game is hung or closed). Sources: wh3_mcp_script_errors.log (the mod hooks the global script_error — every scripted error lands here with a turn stamp), the newest CA script_log_*.txt if CA file logging is on (error-matching lines only), plus any extra mod log files named (e.g. "Shenzoo_log.txt", "lua_mod_log.txt" — they live in the WH3 root). Pass the returned structured cursor back as since to get only NEW content next call (legacy filename->offset maps are still accepted but are identity-indeterminate). Call after a soak or any test run.',
      inputSchema: {
        type: 'object',
        properties: {
          extra_files: { type: 'array', items: { type: 'string' }, description: 'Additional log filenames in the WH3 root to tail (max 10)' },
          since: { type: 'object', description: 'Previous structured cursor (preferred) or legacy map of filename -> byte offset. Structured cursors detect session/run mismatch, rotation and truncation.' },
        },
      },
    },
    {
      name: 'wh3_build_building',
      description: 'Instantly add a building to a settlement via cm:add_building_to_settlement (test setup; a slot must be free and the key valid — the result reports building_present read back from the region). For the player-flow build queue use the settlement UI via wh3_click_ui.',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'Region key (e.g. wh3_main_combi_region_...)' },
          building: { type: 'string', description: 'Building key from the buildings table' },
        },
        required: ['region', 'building'],
      },
    },
    {
      name: 'wh3_transfer_region',
      description: 'Instantly transfer a region to a faction via cm:transfer_region_to_faction (state-level occupation for test setup). Result reads back the new owner. The post-battle occupation-choice flow is separate UI.',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'Region key' },
          faction: { type: 'string', description: 'Receiving faction key. Defaults to the local player faction.' },
        },
        required: ['region'],
      },
    },
    {
      name: 'wh3_start_research',
      description: 'Start researching a technology by driving the tech-panel UI (WH3 has no cm function for this): opens the panel, clicks the tech node (id <tech_key> or tech_<tech_key>), verifies via faction:is_currently_researching, closes the panel. Fails if the node is locked, hidden, or the key is wrong.',
      inputSchema: {
        type: 'object',
        properties: {
          tech_key: { type: 'string', description: 'Technology key from the technologies table' },
        },
        required: ['tech_key'],
      },
    },
    {
      name: 'wh3_level_character',
      description: 'Instantly add levels to a character via cm:add_agent_experience(by_level=true). Result reports rank before and after. Get cqis from wh3_get_armies or wh3_get_characters.',
      inputSchema: {
        type: 'object',
        properties: {
          cqi: { type: 'number', description: 'Character cqi' },
          levels: { type: 'number', description: 'Levels to add (default 1)' },
        },
        required: ['cqi'],
      },
    },
    {
      name: 'wh3_grant_skill',
      description: 'Grant a skill (or add a point to it) via cm:force_add_skill. Result reads back has_skill. Combine with wh3_level_character to test skill-tree content without manual clicking.',
      inputSchema: {
        type: 'object',
        properties: {
          cqi: { type: 'number', description: 'Character cqi' },
          skill_key: { type: 'string', description: 'Skill key from the character_skills table' },
        },
        required: ['cqi', 'skill_key'],
      },
    },
    {
      name: 'wh3_cco_query',
      description: 'Raw read from the Component Context Object system via common.get_context_value — the same expression engine the UI uses, so it can read values no script interface exposes (character/unit stats, tech state, UI-computed numbers). Pass either object_id (e.g. from UIC GetContextObjectId) or type + data (e.g. type "CcoCampaignCharacter", data a cqi) plus an expression. The tool tries the known argument forms and reports which one answered. Discovery aid: wh3_cm_search context "ui", and CA expression syntax from the context viewer.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'CCO expression to evaluate (e.g. "Name", "Treasury")' },
          object_id: { type: 'string', description: 'Full context object id, when you have one' },
          type: { type: 'string', description: 'Context object typename (e.g. CcoCampaignRoot, CcoCampaignCharacter)' },
          data: { description: 'Construction data for the type, usually a cqi' },
        },
        required: ['expression'],
      },
    },
    {
      name: 'wh3_cm_search',
      description: 'Search the WH3 scripting API (5,300+ documented functions: cm/campaign_manager, the episodic scripting interface, CampaignUI, campaign_ui_manager, core, uicomponent, battle classes, model script interfaces like FACTION_SCRIPT_INTERFACE, and event context accessors) by keyword. Returns name, signature, return type, one-line description, contexts, and exists_at_runtime (probed on the LIVE game where possible), plus runtime_only rows for functions the docs miss. Use this to DISCOVER an API, then execute it with wh3_eval. Multi-word queries AND together (e.g. "faction treasury").',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords to search for, case-insensitive. All words must match a record (function name scores highest, then class, then description).',
          },
          context: {
            type: 'string',
            enum: ['campaign', 'battle', 'frontend', 'global', 'events', 'ui'],
            description: 'Optional filter. campaign = cm/episodic/model interfaces; battle = bm-side classes (note: this mod runs in campaign, so battle functions cannot be probed live); events = event context accessors; ui = uicomponent/CampaignUI/campaign_ui_manager only. Omit to search everything.',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 15, cap 50)',
            default: 15,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'wh3_trigger_dilemma_targeted',
      description: 'Fire a dilemma that needs target game objects, via cm:trigger_dilemma_with_targets (faction as NUMERIC cqi; optional target cqis for faction/secondary faction/character/military force/region/settlement). Use for mod dilemmas whose records reference targets — plain wh3_trigger_dilemma rejects those. Delivery is wrapped in an intervention: issued=true means QUEUED, so poll wh3_get_situation for the event panel afterwards. Get character cqis from wh3_get_armies, faction cqi is read from the local faction when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          dilemma_key: {
            type: 'string',
            description: 'Dilemma record key from the dilemmas table',
          },
          faction_cqi: {
            type: 'number',
            description: 'Numeric cqi of the faction receiving the dilemma. Defaults to the local player faction.',
          },
          target_faction_cqi: { type: 'number', description: 'Optional target faction cqi' },
          secondary_faction_cqi: { type: 'number', description: 'Optional secondary faction cqi' },
          character_cqi: { type: 'number', description: 'Optional target character cqi' },
          military_force_cqi: { type: 'number', description: 'Optional target military force cqi' },
          region_cqi: { type: 'number', description: 'Optional target region cqi' },
          settlement_cqi: { type: 'number', description: 'Optional target settlement cqi' },
        },
        required: ['dilemma_key'],
      },
    },
    {
      name: 'wh3_eval',
      description: 'ESCAPE HATCH: execute arbitrary Lua inside the mod\'s environment (cm, core, common, CampaignUI, find_uicomponent, UIComponent all reachable) and return whatever the chunk returns. Use only when no dedicated tool fits — a dedicated tool carries the guards this does not. Not sure of the API? wh3_cm_search finds the function name and signature first. Anything you can call, you can crash the game with: in particular NEVER call cm:win_next_autoresolve_battle without a pending battle (instant CTD) — use wh3_autoresolve_battle, which guards it.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Lua source. Use "return <expr>" to get a value back; tables are returned as JSON, other types as strings.',
          },
          timeout_ms: {
            type: 'number',
            description: 'Timeout in milliseconds (default 30000)',
            default: 30000,
          },
        },
        required: ['code'],
      },
    },
    {
      name: 'wh3_fight_battle',
      description: 'Fight a pending battle ON THE BATTLE MAP (the manual-battle counterpart to wh3_autoresolve_battle) — needed to test battle-side mod content. Requires the pre-battle panel (order an attack first with wh3_attack). Clicks Attack; the battle context loads (script reload, ~30-60s gap). With auto=true (default) the mod then drives the whole battle by itself — end deployment, attack-move the army at the given speed, end at victory, dismiss the results — and this call BLOCKS until the campaign is back, returning the battle outcome and the handled post-battle panel. With auto=false it returns as soon as the battle context answers (phase Deployment) and you drive it with wh3_start_battle / wh3_battle_order / wh3_set_battle_speed / wh3_end_battle. NOTE: a LOSS is possible — the outcome text reports it either way.',
      inputSchema: {
        type: 'object',
        properties: {
          auto: { type: 'boolean', description: 'Drive the battle automatically (default true)' },
          speed: { type: 'number', description: 'Battle speed for the auto run (default 10 = fast-forward)' },
          max_ticks: { type: 'number', description: 'Auto-run gives up after this many poll ticks ~1s each (default 900)' },
          captives: { type: 'string', enum: ['kill', 'enslave', 'release'], description: 'Captive choice on the post-battle panel after a win (default kill)' },
          max_wait_s: { type: 'number', description: 'Server-side deadline in seconds for the whole round trip (default 600)' },
        },
      },
    },
    {
      name: 'wh3_start_battle',
      description: 'BATTLE context: end the Deployment phase (bm:end_current_battle_phase) — the battle starts. Only valid in Deployment.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wh3_set_battle_speed',
      description: 'BATTLE context: set the battle speed (bm:modify_battle_speed). 1 = normal, 10 = fast-forward (the testing superpower), 0.5 = slow.',
      inputSchema: {
        type: 'object',
        properties: { speed: { type: 'number', description: 'Unary proportion of normal speed' } },
        required: ['speed'],
      },
    },
    {
      name: 'wh3_battle_order',
      description: 'BATTLE context, Deployed phase only: issue a v1 order through a throwaway unitcontroller. order "attack" (default) = attack-move onto the first enemy unit still alive (or onto target_index); "attack_unit" = direct attack on target_index; "halt". unit_indices narrows to a subset of the player army (1-based, from wh3_get_battle_units); default is the whole army.',
      inputSchema: {
        type: 'object',
        properties: {
          order: { type: 'string', enum: ['attack', 'attack_unit', 'halt'], description: 'Order kind (default attack)' },
          unit_indices: { type: 'array', items: { type: 'number' }, description: '1-based player unit indices (default: all units)' },
          target_index: { type: 'number', description: '1-based enemy unit index to target' },
        },
      },
    },
    {
      name: 'wh3_get_battle_units',
      description: 'BATTLE context: per-unit list for both sides — index, unit type key, men alive — plus totals and the current phase. Indices feed wh3_battle_order.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wh3_end_battle',
      description: 'BATTLE context: finish the battle. Two steps (call until ended=true): in VictoryCountdown it calls bm:end_battle() (phase moves to Complete and the results popup opens); with the results popup open it clicks its End Battle button, which returns to campaign — then handle the post_battle blocker (wh3_dismiss_battle_results).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wh3_auto_fight',
      description: 'BATTLE context: arm the auto-fight machine mid-battle (wh3_fight_battle with auto=true does this from campaign instead). Acks immediately; the poll loop then drives the battle (deployment -> attack-move -> victory -> results dismissed) and the context flips back to campaign when done — poll wh3_get_situation.',
      inputSchema: {
        type: 'object',
        properties: {
          speed: { type: 'number', description: 'Battle speed for the run (default 10)' },
          max_ticks: { type: 'number', description: 'Give up after this many poll ticks ~1s each (default 900)' },
        },
      },
    },
    {
      name: 'wh3_dismiss_battle_results',
      description: 'CAMPAIGN context, after a manual battle: dismiss the post-battle results panel (captive choice included), reusing the proven autoresolve dismissal machine. Returns human_victory and the result title.',
      inputSchema: {
        type: 'object',
        properties: {
          captives: { type: 'string', enum: ['kill', 'enslave', 'release'], description: 'Captive choice after a win (default kill)' },
        },
      },
    },
    {
      name: 'wh3_send_command',
      description: 'Send a raw command to the WH3 MCP mod and return the result.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Command name. Situational awareness: get_situation (prefer this over a screenshot), get_screen, get_hud, get_status. State: ping, get_faction_info, get_treasury, get_regions, get_characters, get_saved_value, set_saved_value, apply_effect_bundle. Events: trigger_dilemma, trigger_dilemma_with_targets, trigger_incident, read_event, answer_dilemma, dismiss_event. Battles: attack (target_settlement for settlements), autoresolve_battle, retreat_battle, occupy_choice, answer_move_options. Battle map: fight_battle, start_battle, set_battle_speed, battle_order, get_battle_units, end_battle, auto_fight, dismiss_battle_results. Diplomacy: open_diplomacy, force_diplomacy, get_diplomacy. Campaign start/load: start_campaign, load_campaign, continue_campaign, new_game, select_campaign, list_races, list_lords, select_race, select_lord, select_playthrough, select_save, confirm_load. Campaign control: open_menu, resume (alias close_menu), confirm_dialog, cancel_dialog, quit_to_menu, exit_to_windows, end_turn, save_game, quick_save. Soak: soak_turns, soak_status, soak_abort. Levers: build_building, transfer_region, start_research, level_character, grant_skill, cco_query. Panels: open_panel, close_panel. Camera: get_camera, set_camera, pan_camera, zoom_to. Armies: get_armies, move_army, teleport_army, select_army. Debug: eval, cm_search, take_screenshot, click_ui, list_ui, inspect_ui, dump_children, log_clicks, probe_text, probe_cm',
          },
          params: {
            type: 'object',
            description: 'Command parameters as key-value pairs',
          },
          timeout_ms: {
            type: 'number',
            description: 'Timeout in milliseconds (default 60000)',
            default: 60000,
          },
        },
        required: ['command'],
      },
    },
  ],
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'wh3_start': {
      const result = await startWh3();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'wh3_stop': {
      const result = await stopWh3();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'wh3_status': {
      const result = getWh3Status();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'wh3_begin_test_session': {
      const result = await sessionEvidence.begin({
        label: args?.label,
        extraFiles: Array.isArray(args?.extra_files) ? args.extra_files : [],
      });
      if (result.status === 'ok' && args?.capture_start_screenshot === true && isWh3Running()) {
        const capture = await screenshotArtifacts.capture({ filename: 'session-start.tga' });
        if (capture.status === 'ok') sessionEvidence.recordArtifact(capture.result);
        result.result.start_screenshot = capture.status === 'ok'
          ? { capture_id: capture.result.capture_id, artifact: capture.result.artifact }
          : { status: 'error', error: capture.error };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'wh3_end_test_session': {
      let capture = null;
      if (args?.capture_end_screenshot === true && isWh3Running()) {
        capture = await screenshotArtifacts.capture({ filename: 'session-end.tga' });
        if (capture.status === 'ok') sessionEvidence.recordArtifact(capture.result);
      }
      const result = await sessionEvidence.end();
      if (result.status === 'ok' && capture) {
        result.result.end_screenshot = capture.status === 'ok'
          ? { capture_id: capture.result.capture_id, artifact: capture.result.artifact }
          : { status: 'error', error: capture.error };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'wh3_export_evidence': {
      const result = await sessionEvidence.exportEvidence({ includeActive: args?.include_active !== false });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'wh3_ping': {
      const result = await sendCommand('ping', {}, 10000);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'wh3_wait_for_mod': {
      const timeout = (args?.timeout_seconds ?? 120) * 1000;
      const start = Date.now();
      let lastError = null;

      while (Date.now() - start < timeout) {
          const result = await sendCommand('ping', {}, 5000);
        if (result.status === 'ok') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'ok', waited_ms: Date.now() - start }, null, 2) }],
          };
        }
        lastError = result;
        // Wait 2 seconds before retrying
        await new Promise(r => setTimeout(r, 2000));
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          status: 'timeout',
          waited_ms: Date.now() - start,
          last_error: lastError,
        }, null, 2) }],
      };
    }

    case 'wh3_start_campaign': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      // Try UI click first, fall back to frontend API
      const result = await sendCommand('start_campaign', {
        campaign_key: args?.campaign_key ?? 'wh3_main_combi',
        faction_key: args?.faction_key ?? 'mixer_cth_shenzoo',
        party_key: args?.party_key ?? 'wh3_main_cth_shenzoo',
      }, 120000);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'wh3_screenshot': {
      const result = await screenshotArtifacts.capture({
        filename: args?.filename ?? 'wh3_mcp_screenshot.tga',
        timeout_ms: args?.timeout_ms,
      });
      if (result.status !== 'ok') {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      sessionEvidence.recordArtifact(result.result);
      const { _png, ...metadata } = result.result;
      const content = [{ type: 'text', text: JSON.stringify({ status: 'ok', result: metadata }, null, 2) }];
      if (metadata.artifact.inline && Buffer.isBuffer(_png)) {
        content.push({ type: 'image', data: _png.toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    }

    case 'wh3_load_campaign': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const loadResult = await sendCommand('load_campaign', {
        filename: args.filename,
      }, 60000);
      return { content: [{ type: 'text', text: JSON.stringify(loadResult, null, 2) }] };
    }

    case 'wh3_continue_campaign': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const contResult = await sendCommand('continue_campaign', {}, 60000);
      return { content: [{ type: 'text', text: JSON.stringify(contResult, null, 2) }] };
    }

    case 'wh3_click_ui': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const clickResult = await sendCommand('click_ui', {
        path: args.path,
        child_index: args.child_index,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(clickResult, null, 2) }] };
    }

    case 'wh3_list_ui': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const listResult = await sendCommand('list_ui', {
        path: args?.path,
        max_depth: args?.max_depth,
        visible_only: args?.visible_only,
        return_tree: args?.return_tree,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(listResult, null, 2) }] };
    }

    case 'wh3_inspect_ui': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: { code: 'GAME_EXITED', message: 'WH3 not running' } }, null, 2) }] };
      }
      let inspectArgs;
      try {
        inspectArgs = normalizeUiInspectionArgs(args);
      } catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'error',
          error: { code: error?.code ?? 'INVALID_REQUEST', message: error?.message ?? String(error), details: error?.details },
        }, null, 2) }] };
      }
      const inspectResult = await sendCommand('inspect_ui', inspectArgs, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(inspectResult, null, 2) }] };
    }

    case 'wh3_list_races': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const racesResult = await sendCommand('list_races', {}, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(racesResult, null, 2) }] };
    }

    case 'wh3_list_lords': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const lordsResult = await sendCommand('list_lords', {}, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(lordsResult, null, 2) }] };
    }

    case 'wh3_select_race': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const selectRaceResult = await sendCommand('select_race', {
        culture_key: args?.culture_key,
        index: args?.index,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(selectRaceResult, null, 2) }] };
    }

    case 'wh3_select_lord': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const selectLordResult = await sendCommand('select_lord', {
        faction_key: args?.faction_key,
        index: args?.index,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(selectLordResult, null, 2) }] };
    }

    case 'wh3_new_game': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const newGameResult = await sendCommand('new_game', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(newGameResult, null, 2) }] };
    }

    case 'wh3_select_campaign': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const selCampResult = await sendCommand('select_campaign', {
        campaign_type: args.campaign_type,
      }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(selCampResult, null, 2) }] };
    }

    case 'wh3_get_screen': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const screenResult = await sendCommand('get_screen', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(screenResult, null, 2) }] };
    }

    case 'wh3_list_playthroughs': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const ptResult = await sendCommand('get_screen', {}, 10000);
      // Extract just the playthrough data from get_screen
      if (ptResult.status === 'ok' && ptResult.result?.screen === 'load_game') {
        ptResult.result = ptResult.result.details.playthroughs || [];
      }
      return { content: [{ type: 'text', text: JSON.stringify(ptResult, null, 2) }] };
    }

    case 'wh3_list_saves': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const svResult = await sendCommand('get_screen', {}, 10000);
      // Extract just the save data from get_screen
      if (svResult.status === 'ok' && svResult.result?.screen === 'load_game') {
        svResult.result = svResult.result.details.saves || [];
      }
      return { content: [{ type: 'text', text: JSON.stringify(svResult, null, 2) }] };
    }

    case 'wh3_select_playthrough': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const ptResult = await sendCommand('select_playthrough', { index: args.index }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(ptResult, null, 2) }] };
    }

    case 'wh3_select_save': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const saveResult = await sendCommand('select_save', {
        index: args?.index,
        name: args?.name,
      }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(saveResult, null, 2) }] };
    }

    case 'wh3_confirm_load': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const loadResult = await sendCommand('confirm_load', {}, 120000);
      return { content: [{ type: 'text', text: JSON.stringify(loadResult, null, 2) }] };
    }

    case 'wh3_dismiss_advisor': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      // Try the advice_text_panel close button first, fall back to button_accept
      let advResult = await sendCommand('click_ui', { path: ['advice_interface', 'text_parent', 'advice_text_panel', 'maximised_button_docker', 'button_close'] }, 10000);
      if (advResult.status === 'error') {
        advResult = await sendCommand('click_ui', { path: ['advice_interface', 'button_set', 'accept_holder', 'button_accept'] }, 10000);
      }
      return { content: [{ type: 'text', text: JSON.stringify(advResult, null, 2) }] };
    }

    case 'wh3_accept_mission': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      // Try mission_review path, fall back to generic button_accept
      let missResult = await sendCommand('click_ui', { path: ['mission_review', 'quest_details', 'quest_list_details', 'footer', 'button_accept'] }, 10000);
      if (missResult.status === 'error') {
        missResult = await sendCommand('click_ui', { path: ['button_accept'] }, 10000);
      }
      return { content: [{ type: 'text', text: JSON.stringify(missResult, null, 2) }] };
    }

    case 'wh3_close_shenzoo_advisor': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const shenResult = await sendCommand('click_ui', { path: ['passing_advisor_menu', 'passing_dargon_exit_button'] }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(shenResult, null, 2) }] };
    }

    case 'wh3_open_menu': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const menuResult = await sendCommand('open_menu', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(menuResult, null, 2) }] };
    }

    case 'wh3_resume': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const resumeResult = await sendCommand('resume', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(resumeResult, null, 2) }] };
    }

    case 'wh3_confirm_dialog': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const confirmResult = await sendCommand('confirm_dialog', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(confirmResult, null, 2) }] };
    }

    case 'wh3_cancel_dialog': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const cancelResult = await sendCommand('cancel_dialog', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(cancelResult, null, 2) }] };
    }

    case 'wh3_quit_to_menu': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      // The mod defers this: it clicks quit, confirms the dialog, then writes
      // the result from the next script instance after the context reload.
      const quitResult = await sendCommand('quit_to_menu', {}, 120000);
      return { content: [{ type: 'text', text: JSON.stringify(quitResult, null, 2) }] };
    }

    case 'wh3_exit_windows': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      // The mod writes its result BEFORE clicking confirm, because the process
      // dies on the click. If that result never lands, the process vanishing is
      // itself proof the exit worked.
      const exitResult = await sendCommand('exit_to_windows', {}, 20000);
      if (exitResult.status === 'ok') {
        return { content: [{ type: 'text', text: JSON.stringify(exitResult, null, 2) }] };
      }
      const waitStart = Date.now();
      while (Date.now() - waitStart < 15000) {
        await new Promise(r => setTimeout(r, 1000));
        if (!isWh3Running()) {
              return {
            content: [{ type: 'text', text: JSON.stringify({
              status: 'ok',
              result: { exiting: true, confirmed_by: 'process_exited' },
              mod_result: exitResult,
            }, null, 2) }],
          };
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({
          status: 'error',
          error: 'no result from the mod and WH3 is still running after 15s',
          mod_result: exitResult,
        }, null, 2) }],
      };
    }

    case 'wh3_end_turn': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const endTurnResult = await sendCommand('end_turn', {
        method: args?.method ?? 'api',
        force: args?.force ?? false,
      }, 30000);
      return { content: [{ type: 'text', text: JSON.stringify(endTurnResult, null, 2) }] };
    }

    case 'wh3_get_hud': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const hudResult = await sendCommand('get_hud', {}, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(hudResult, null, 2) }] };
    }

    case 'wh3_open_panel': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const openPanelResult = await sendCommand('open_panel', { panel: args.panel }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(openPanelResult, null, 2) }] };
    }

    case 'wh3_close_panel': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const closePanelResult = await sendCommand('close_panel', { panel: args?.panel }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(closePanelResult, null, 2) }] };
    }

    case 'wh3_get_camera': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const camResult = await sendCommand('get_camera', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(camResult, null, 2) }] };
    }

    case 'wh3_set_camera': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const setCamResult = await sendCommand('set_camera', {
        x: args?.x, y: args?.y, d: args?.d, b: args?.b, h: args?.h,
      }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(setCamResult, null, 2) }] };
    }

    case 'wh3_pan_camera': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const panResult = await sendCommand('pan_camera', {
        x: args?.x, y: args?.y, d: args?.d, b: args?.b, h: args?.h,
        time: args?.time ?? 2,
      }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(panResult, null, 2) }] };
    }

    case 'wh3_zoom_to': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const zoomResult = await sendCommand('zoom_to', {
        cqi: args?.cqi,
        region: args?.region,
        time: args?.time ?? 2,
      }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(zoomResult, null, 2) }] };
    }

    case 'wh3_get_armies': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const armiesResult = await sendCommand('get_armies', { faction: args?.faction }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(armiesResult, null, 2) }] };
    }

    case 'wh3_move_army': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const moveResult = await sendCommand('move_army', {
        cqi: args.cqi, x: args.x, y: args.y, queued: args?.queued ?? false,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(moveResult, null, 2) }] };
    }

    case 'wh3_teleport_army': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const teleResult = await sendCommand('teleport_army', {
        cqi: args.cqi, x: args.x, y: args.y,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(teleResult, null, 2) }] };
    }

    case 'wh3_select_army': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const selectArmyResult = await sendCommand('select_army', {
        cqi: args?.cqi, name: args?.name,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(selectArmyResult, null, 2) }] };
    }

    case 'wh3_save_game': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const saveResult = await sendCommand('save_game', {
        filename: args?.filename ?? 'wh3_mcp_autosave',
        overwrite: args?.overwrite ?? true,
      }, 30000);
      return { content: [{ type: 'text', text: JSON.stringify(saveResult, null, 2) }] };
    }

    case 'wh3_quick_save': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const quickSaveResult = await sendCommand('quick_save', {}, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(quickSaveResult, null, 2) }] };
    }

    case 'wh3_get_situation': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const situationResult = await sendCommand('get_situation', {}, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(situationResult, null, 2) }] };
    }

    case 'wh3_wait_for': {
      let waitResult;
      try {
        waitResult = await waitForConditions(args, {
          sendCommand,
          getIdentity: () => ({
            running: isWh3Running(),
            session_id: commandTransport?.sessionId ?? null,
            run_id: processManager.getStatus().run_id ?? null,
          }),
          signal: extra?.signal,
        });
      } catch (error) {
        waitResult = {
          status: 'error',
          error: {
            code: error?.code ?? 'INVALID_REQUEST',
            message: error?.message ?? String(error),
            details: error?.details,
          },
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(waitResult, null, 2) }] };
    }

    case 'wh3_read_event': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const eventResult = await sendCommand('read_event', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(eventResult, null, 2) }] };
    }

    case 'wh3_answer_dilemma': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const answerResult = await sendCommand('answer_dilemma', { choice: args.choice }, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(answerResult, null, 2) }] };
    }

    case 'wh3_dismiss_event': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const dismissResult = await sendCommand('dismiss_event', {}, 10000);
      return { content: [{ type: 'text', text: JSON.stringify(dismissResult, null, 2) }] };
    }

    case 'wh3_trigger_dilemma': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const dilemmaResult = await sendCommand('trigger_dilemma', {
        dilemma_key: args.dilemma_key,
        faction: args?.faction,
        fire_immediately: args?.fire_immediately ?? true,
        whitelist: args?.whitelist ?? true,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(dilemmaResult, null, 2) }] };
    }

    case 'wh3_trigger_incident': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const incidentResult = await sendCommand('trigger_incident', {
        incident_key: args.incident_key,
        faction: args?.faction,
        fire_immediately: args?.fire_immediately ?? true,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(incidentResult, null, 2) }] };
    }

    case 'wh3_attack': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const attackResult = await sendCommand('attack', {
        attacker_cqi: args.attacker_cqi,
        target_cqi: args?.target_cqi,
        target_settlement: args?.target_settlement,
        lay_siege: args?.lay_siege ?? false,
        replenish: args?.replenish ?? false,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(attackResult, null, 2) }] };
    }

    case 'wh3_occupy_choice': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const occupyResult = await sendCommand('occupy_choice', { choice: args?.choice }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(occupyResult, null, 2) }] };
    }

    case 'wh3_answer_move_options': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      // Deferred in the mod when a war confirmation follows the click.
      const moveOptsResult = await sendCommand('answer_move_options', {
        option: args.option,
        confirm_war: args?.confirm_war,
      }, 30000);
      return { content: [{ type: 'text', text: JSON.stringify(moveOptsResult, null, 2) }] };
    }

    case 'wh3_autoresolve_battle': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      // Deferred in the mod: it clicks autoresolve, waits for the results
      // panel, clears it, then writes the result. Allow for all three stages.
      const autoResult = await sendCommand('autoresolve_battle', {
        win: args?.win ?? true,
        captives: args?.captives ?? 'kill',
      }, 60000);
      return { content: [{ type: 'text', text: JSON.stringify(autoResult, null, 2) }] };
    }

    case 'wh3_retreat_battle': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const retreatResult = await sendCommand('retreat_battle', {}, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(retreatResult, null, 2) }] };
    }

    case 'wh3_open_diplomacy': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      // Deferred: the mod waits for diplomacy_dropdown, then clicks the row.
      const diploResult = await sendCommand('open_diplomacy', { faction: args?.faction }, 30000);
      return { content: [{ type: 'text', text: JSON.stringify(diploResult, null, 2) }] };
    }

    case 'wh3_force_diplomacy': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const forceResult = await sendCommand('force_diplomacy', {
        action: args.action,
        faction_a: args?.faction_a,
        faction_b: args.faction_b,
        invite_a_allies: args?.invite_a_allies ?? false,
        invite_b_allies: args?.invite_b_allies ?? false,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(forceResult, null, 2) }] };
    }

    case 'wh3_get_diplomacy': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const getDiploResult = await sendCommand('get_diplomacy', { faction: args?.faction }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(getDiploResult, null, 2) }] };
    }

    case 'wh3_soak_turns': {
      if (!commandTransport) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: { code: 'NOT_READY', message: 'WH3 install path is unavailable' } }, null, 2) }] };
      }
      let normalized;
      try { normalized = normalizeSoakArgs(args ?? {}); }
      catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: { code: error.code ?? 'INVALID_SOAK_ARGUMENTS', message: error.message } }, null, 2) }] };
      }
      try {
        const result = await commandTransport.withExclusiveLease(async () => runSoak(normalized, {
          sendCommand,
          isRunning: isWh3Running,
          onProgress: (report) => { lastSoakReport = report; },
        }), { allowCommands: ['soak_status', 'soak_abort'] });
        lastSoakReport = result;
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const result = { status: 'error', error: { code: 'SOAK_LEASE_FAILED', message: error?.message ?? String(error) } };
        lastSoakReport = result;
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    }

    case 'wh3_soak_status': {
      if (!isWh3Running()) {
        const cached = lastSoakReport ?? { status: 'error', error: { code: 'PROCESS_EXITED', message: 'WH3 is not running and no cached soak report is available' } };
        return { content: [{ type: 'text', text: JSON.stringify({ ...cached, report_source: lastSoakReport ? 'server_cached' : 'none' }, null, 2) }] };
      }
      const soakStatus = await sendCommand('soak_status', {}, 20000);
      if (soakStatus?.status === 'ok') lastSoakReport = soakStatus;
      return { content: [{ type: 'text', text: JSON.stringify(soakStatus, null, 2) }] };
    }

    case 'wh3_soak_abort': {
      if (!isWh3Running()) {
        const result = lastSoakReport ?? { status: 'error', error: { code: 'PROCESS_EXITED', message: 'WH3 is not running' } };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      const soakAbort = await sendCommand('soak_abort', {}, 20000);
      return { content: [{ type: 'text', text: JSON.stringify(soakAbort, null, 2) }] };
    }

    case 'wh3_fight_battle': {
      if (!commandTransport) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: { code: 'NOT_READY', message: 'WH3 install path is unavailable' } }, null, 2) }] };
      }
      return await commandTransport.withExclusiveLease(async () => {
        if (!isWh3Running()) {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
        }
        const auto = args?.auto !== false;
        commandTransport.beginManagedTransition('fight_battle', auto ? 'campaign_after_battle' : 'battle');
        const ack = await sendCommand('fight_battle', {
          auto,
          speed: args?.speed,
          max_ticks: args?.max_ticks,
        }, 20000);
        if (ack?.status !== 'ok') {
          commandTransport.failManagedTransition({ outcome: ack?.error?.details?.outcome ?? 'not_completed', details: ack?.error ?? ack });
          return { content: [{ type: 'text', text: JSON.stringify(ack, null, 2) }] };
        }
        // The battle context loads with a script reload (poll gap: commands go
        // unanswered until the new instance's poll loop is up). The exclusive
        // lease blocks unrelated commands while this transition is active.
        const deadline = Date.now() + (args?.max_wait_s ?? 600) * 1000;
        let sawBattle = false;
        let last = ack;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10000));
          if (!isWh3Running()) {
            commandTransport.markGameExited({ phase: 'fight_battle' });
            return { content: [{ type: 'text', text: JSON.stringify({
              status: 'error', error: 'WH3 process died mid-battle (CTD?) — run wh3_check_errors', last_status: last,
            }, null, 2) }] };
          }
          const sit = await sendCommand('get_situation', {}, 20000);
          if (sit?.status !== 'ok' || !sit.result) continue; // context reload poll gap
          last = sit;
          const ctx = sit.result.context;
          if (ctx === 'battle') {
            sawBattle = true;
            if (!auto) {
              commandTransport.completeManagedTransition({ context: 'battle' });
              return { content: [{ type: 'text', text: JSON.stringify(sit, null, 2) }] };
            }
          } else if (ctx === 'campaign' && sawBattle) {
            const dis = await sendCommand('dismiss_battle_results', { captives: args?.captives }, 60000);
            commandTransport.completeManagedTransition({ context: 'campaign' });
            return { content: [{ type: 'text', text: JSON.stringify({
              status: 'ok', result: {
                battle_fought: true,
                post_battle: dis?.status === 'ok' ? dis.result : dis,
                situation: sit.result,
              },
            }, null, 2) }] };
          }
        }
        commandTransport.failManagedTransition({ outcome: 'unknown', details: { reason: 'battle_round_trip_timeout' } });
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'timeout',
          error: 'battle round trip did not finish before max_wait_s — the game keeps running; poll wh3_get_situation',
          last_status: last,
        }, null, 2) }] };
      });
    }

    case 'wh3_start_battle': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const sbResult = await sendCommand('start_battle', {}, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(sbResult, null, 2) }] };
    }

    case 'wh3_set_battle_speed': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const spdResult = await sendCommand('set_battle_speed', { speed: args?.speed }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(spdResult, null, 2) }] };
    }

    case 'wh3_battle_order': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const ordResult = await sendCommand('battle_order', {
        order: args?.order,
        unit_indices: args?.unit_indices,
        target_index: args?.target_index,
      }, 20000);
      return { content: [{ type: 'text', text: JSON.stringify(ordResult, null, 2) }] };
    }

    case 'wh3_get_battle_units': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const buResult = await sendCommand('get_battle_units', {}, 20000);
      return { content: [{ type: 'text', text: JSON.stringify(buResult, null, 2) }] };
    }

    case 'wh3_end_battle': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const ebResult = await sendCommand('end_battle', {}, 20000);
      return { content: [{ type: 'text', text: JSON.stringify(ebResult, null, 2) }] };
    }

    case 'wh3_auto_fight': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const afResult = await sendCommand('auto_fight', {
        speed: args?.speed,
        max_ticks: args?.max_ticks,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(afResult, null, 2) }] };
    }

    case 'wh3_dismiss_battle_results': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const dbrResult = await sendCommand('dismiss_battle_results', { captives: args?.captives }, 60000);
      return { content: [{ type: 'text', text: JSON.stringify(dbrResult, null, 2) }] };
    }

    case 'wh3_check_errors': {
      // Disk-only: works with the game hung, crashed, or closed. Traversal and
      // absolute paths are rejected rather than silently rewritten.
      const result = diagnostics.check({
        extraFiles: Array.isArray(args?.extra_files) ? args.extra_files.slice(0, 10) : [],
        since: args?.since ?? null,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'wh3_build_building': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const buildResult = await sendCommand('build_building', { region: args.region, building: args.building }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(buildResult, null, 2) }] };
    }

    case 'wh3_transfer_region': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const transferResult = await sendCommand('transfer_region', { region: args.region, faction: args?.faction }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(transferResult, null, 2) }] };
    }

    case 'wh3_start_research': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const researchResult = await sendCommand('start_research', { tech_key: args.tech_key }, 30000);
      return { content: [{ type: 'text', text: JSON.stringify(researchResult, null, 2) }] };
    }

    case 'wh3_level_character': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const levelResult = await sendCommand('level_character', { cqi: args.cqi, levels: args?.levels }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(levelResult, null, 2) }] };
    }

    case 'wh3_grant_skill': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const skillResult = await sendCommand('grant_skill', { cqi: args.cqi, skill_key: args.skill_key }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(skillResult, null, 2) }] };
    }

    case 'wh3_cco_query': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const ccoResult = await sendCommand('cco_query', {
        expression: args.expression,
        object_id: args?.object_id,
        type: args?.type,
        data: args?.data,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(ccoResult, null, 2) }] };
    }

    case 'wh3_cm_search': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      deployDocsCorpus(); // self-heal: the corpus may have been rebuilt or deleted since startup
      const searchResult = await sendCommand('cm_search', {
        query: args.query,
        context: args?.context,
        limit: args?.limit,
      }, 20000);
      return { content: [{ type: 'text', text: JSON.stringify(searchResult, null, 2) }] };
    }

    case 'wh3_trigger_dilemma_targeted': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const tdtResult = await sendCommand('trigger_dilemma_with_targets', {
        dilemma_key: args.dilemma_key,
        faction_cqi: args?.faction_cqi,
        target_faction_cqi: args?.target_faction_cqi,
        secondary_faction_cqi: args?.secondary_faction_cqi,
        character_cqi: args?.character_cqi,
        military_force_cqi: args?.military_force_cqi,
        region_cqi: args?.region_cqi,
        settlement_cqi: args?.settlement_cqi,
      }, 15000);
      return { content: [{ type: 'text', text: JSON.stringify(tdtResult, null, 2) }] };
    }

    case 'wh3_eval': {
      if (!isWh3Running()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'WH3 not running' }, null, 2) }] };
      }
      const evalResult = await sendCommand('eval', { code: args.code }, args?.timeout_ms ?? 30000);
      return { content: [{ type: 'text', text: JSON.stringify(evalResult, null, 2) }] };
    }

    case 'wh3_send_command': {
      const cmd = args.command;
      const params = args.params ?? {};
      const timeout = args.timeout_ms ?? 60000;

      if (!isWh3Running()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            status: 'error',
            error: 'WH3 is not running. Call wh3_start first.',
          }, null, 2) }],
        };
      }

      const result = await sendCommand(cmd, params, timeout);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (WH3_INSTALL.ok) {
    console.error(`[wh3-mcp] WH3 path: ${WH3_PATH}`);
    console.error(`[wh3-mcp] WH3 executable: ${WH3_EXE}`);
    console.error(`[wh3-mcp] Command file: ${COMMAND_FILE}`);
    console.error(`[wh3-mcp] Result file: ${RESULT_FILE}`);
  } else {
    console.error(`[wh3-mcp] WH3 path unavailable: ${WH3_INSTALL.code} - ${WH3_INSTALL.error}`);
  }
  deployDocsCorpus();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[wh3-mcp] Fatal error:', err);
  process.exit(1);
});
