# build.ps1 - Package the WH3 MCP mod into a .pack file and optionally deploy it.
# Uses the RPFM MCP server (must be running on :45127).
# Run this after editing pack/script/_lib/mod/wh3_mcp.lua.
#
# WH3_INSTALL_DIR points to the folder containing Warhammer3.exe. The legacy
# WH3_INSTALL_PATH variable is accepted for compatibility. If neither is set,
# the standard Steam path is used for deployment only.

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSCommandPath
$LuaPath = Join-Path $ProjectRoot 'pack\script\_lib\mod\wh3_mcp.lua'
$ReadmePath = Join-Path $ProjectRoot 'pack\readme.txt'
$ManifestPath = Join-Path $ProjectRoot 'pack\manifest.json'
$VerifyPackagePath = Join-Path $ProjectRoot 'tools\verify-package.mjs'
$BuildPath = Join-Path $ProjectRoot 'wh3_mcp_server.pack'
$BaseUrl = 'http://127.0.0.1:45127/mcp'

$InstallDir = if ($env:WH3_INSTALL_DIR) {
    $env:WH3_INSTALL_DIR
} elseif ($env:WH3_INSTALL_PATH) {
    $env:WH3_INSTALL_PATH
} else {
    'C:\Program Files (x86)\Steam\steamapps\common\Total War WARHAMMER III'
}
$DeployPath = Join-Path (Join-Path $InstallDir 'data') 'wh3_mcp_server.pack'

foreach ($path in @($LuaPath, $ReadmePath, $ManifestPath, $VerifyPackagePath)) {
    if (-not (Test-Path $path)) { Write-Error "Required packaging input not found: $path"; exit 1 }
}

# Fail before RPFM work if protocol/hash/package-source metadata has drifted.
Write-Host '=== Verify package source ==='
& node $VerifyPackagePath
if ($LASTEXITCODE -ne 0) { Write-Error 'Packaging verification failed'; exit 1 }

# ---------------------------------------------------------------------------
# 1. RPFM session
# ---------------------------------------------------------------------------
Write-Host '=== RPFM: init session ==='
$initBody = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"wh3-mcp","version":"1.0"}}}'
$initBody | Out-File "$env:TEMP\mcp_init.json" -Encoding ascii
$headers = curl.exe -s -D - -X POST $BaseUrl -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "@$env:TEMP\mcp_init.json" 2>&1
$SessionId = ($headers -split "`n" | Where-Object { $_ -match 'mcp-session-id' } | ForEach-Object { ($_ -split ': ')[1].Trim() })
if (-not $SessionId) { Write-Error "RPFM session failed: $headers"; exit 1 }

function Rpc {
    param($Method, $ArgsJson)
    $body = @{ jsonrpc='2.0'; id=[int](Get-Random -Min 1000 -Max 9999); method='tools/call'; params=@{ name=$Method; arguments=$ArgsJson } } | ConvertTo-Json -Compress -Depth 5
    $path = "$env:TEMP\mcp_rpc_$([int](Get-Random -Min 1000 -Max 9999)).json"
    $body | Out-File $path -Encoding ascii
    $r = curl.exe -s -X POST $BaseUrl -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SessionId" -d "@$path" 2>&1
    Remove-Item $path -Force -ErrorAction SilentlyContinue
    return ($r -match '"isError":false')
}

function Add-PackFile {
    param([string]$SourcePath, [string]$DestinationPath, [int]$Id)
    $destinationJson = ConvertTo-Json -InputObject @(@{ File=$DestinationPath }) -Compress
    $body = @{
        jsonrpc='2.0'
        id=$Id
        method='tools/call'
        params=@{
            name='add_packed_files'
            arguments=@{
                pack_key=$PackKey
                source_paths=@($SourcePath)
                destination_paths=$destinationJson
            }
        }
    } | ConvertTo-Json -Compress -Depth 8
    $tempPath = "$env:TEMP\mcp_add_$Id.json"
    $body | Out-File $tempPath -Encoding ascii
    $response = curl.exe -s -X POST $BaseUrl -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SessionId" -d "@$tempPath" 2>&1
    Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
    if ($response -match '"isError":false') {
        Write-Host "Added: $DestinationPath"
    } else {
        Write-Error "Add file failed ($DestinationPath): $response"
        exit 1
    }
}

# ---------------------------------------------------------------------------
# 2. Set game
# ---------------------------------------------------------------------------
Write-Host '=== RPFM: set game ==='
Rpc 'set_game_selected' @{ game_name='warhammer_3'; rebuild_dependencies=$true } | Out-Null

# ---------------------------------------------------------------------------
# 3. Close stale packs, create new pack
# ---------------------------------------------------------------------------
Write-Host '=== RPFM: close + new pack ==='
Rpc 'close_all_packs' @{} | Out-Null
$npBody = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"new_pack","arguments":{}}}'
$npBody | Out-File "$env:TEMP\mcp_newpack.json" -Encoding ascii
$npResp = curl.exe -s -X POST $BaseUrl -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SessionId" -d "@$env:TEMP\mcp_newpack.json" 2>&1
if ($npResp -match '"String":"([^"]+)"') { $PackKey = $Matches[1] } elseif ($npResp -match 'new_pack\.pack') { $PackKey = 'new_pack.pack' } else { Write-Error "new_pack failed: $npResp"; exit 1 }
Write-Host "Pack key: $PackKey"

# ---------------------------------------------------------------------------
# 4. Add verified ship payload
# ---------------------------------------------------------------------------
Write-Host '=== RPFM: add verified payload ==='
Add-PackFile $LuaPath 'script/_lib/mod/wh3_mcp.lua' 3
Add-PackFile $ReadmePath 'readme.txt' 5
Add-PackFile $ManifestPath 'manifest.json' 6

# ---------------------------------------------------------------------------
# 5. Save to project folder (always writable)
# ---------------------------------------------------------------------------
Write-Host '=== RPFM: save pack ==='
$saveBody = @{
    jsonrpc='2.0'
    id=4
    method='tools/call'
    params=@{ name='save_pack_as'; arguments=@{ pack_key=$PackKey; path=$BuildPath } }
} | ConvertTo-Json -Compress -Depth 6
$saveBody | Out-File "$env:TEMP\mcp_save.json" -Encoding ascii
$r = curl.exe -s -X POST $BaseUrl -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SessionId" -d "@$env:TEMP\mcp_save.json" 2>&1
if ($r -match '"isError":false') {
    Write-Host "Pack saved to project: $BuildPath"
} else {
    Write-Error "Save failed: $r"; exit 1
}
$packHash = (Get-FileHash -Algorithm SHA256 $BuildPath).Hash.ToLowerInvariant()
$luaHash = (Get-FileHash -Algorithm SHA256 $LuaPath).Hash.ToLowerInvariant()
Write-Host "Built pack SHA256: $packHash"
Write-Host "Lua bridge SHA256: $luaHash (must match manifest.json)"

# ---------------------------------------------------------------------------
# 6. Deploy to WH3 data dir (retry if locked by running game)
# ---------------------------------------------------------------------------
Write-Host '=== Deploy to WH3 data ==='
if (-not (Test-Path (Join-Path $InstallDir 'Warhammer3.exe'))) {
    Write-Warning "WH3 install not found at '$InstallDir'. Pack was built but not deployed. Set WH3_INSTALL_DIR to deploy."
    exit 0
}

$maxRetries = 15
$retryDelay = 2
for ($i = 0; $i -lt $maxRetries; $i++) {
    try {
        Copy-Item -Path $BuildPath -Destination $DeployPath -Force -ErrorAction Stop
        $installedHash = (Get-FileHash -Algorithm SHA256 $DeployPath).Hash.ToLowerInvariant()
        if ($installedHash -ne $packHash) { throw "deployed pack hash mismatch: built=$packHash installed=$installedHash" }
        Write-Host "Deployed to: $DeployPath"
        Write-Host "Installed pack SHA256: $installedHash"
        Write-Host 'Build complete!'
        exit 0
    } catch {
        if ($i -lt $maxRetries - 1) {
            Write-Host "  (deploy failed/locked, retrying in ${retryDelay}s...)"
            Start-Sleep -Seconds $retryDelay
        } else {
            Write-Warning "Could not deploy. Pack built at: $BuildPath"
            Write-Warning "Copy manually after closing WH3: Copy-Item '$BuildPath' '$DeployPath' -Force"
            Write-Host 'Build complete (not deployed)!'
            exit 0
        }
    }
}
