# send-cmd.ps1 - standalone protocol-v2 command helper.
# DO NOT run while the WH3-MCP Node server or another controller is active.
# Usage: .\send-cmd.ps1 -Json '{"command":"ping","params":{}}' [-TimeoutSec 30]
param(
    [Parameter(Mandatory = $true)][string]$Json,
    [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
$Helper = Join-Path $PSScriptRoot 'send-command-v2.mjs'
$Temp = Join-Path $env:TEMP ("wh3_mcp_helper_" + [guid]::NewGuid().ToString('N') + '.json')
try {
    [System.IO.File]::WriteAllText($Temp, $Json, [System.Text.UTF8Encoding]::new($false))
    & node $Helper --json-file $Temp $TimeoutSec
    exit $LASTEXITCODE
} finally {
    Remove-Item $Temp -Force -ErrorAction SilentlyContinue
}
