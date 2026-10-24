# screenshot.ps1 - host-side desktop PNG fallback for manual inspection.
# The MCP wh3_screenshot tool uses the in-game TGA capture + verified PNG
# artifact path instead. This helper remains useful when WH3 is foregrounded.
# Usage: .\screenshot.ps1 [-OutFile path] [-MaxWidth 1600] [-MaxBytes 67108864] [-Force]
# ASCII only (PS 5.1 reads BOM-less UTF-8 as CP1252).
param(
    [string]$OutFile = '',
    [int]$MaxWidth = 1600,
    [long]$MaxBytes = 67108864,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not $OutFile) {
    $id = [Guid]::NewGuid().ToString('N')
    $OutFile = Join-Path $env:TEMP "wh3_screen_$id.png"
}
$OutFile = [System.IO.Path]::GetFullPath($OutFile)
$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
if ((Test-Path $OutFile) -and -not $Force) {
    throw "Refusing to overwrite an existing screenshot without -Force: $OutFile"
}

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'Primary screen has invalid bounds.' }
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    } finally {
        $g.Dispose()
    }

    if ($MaxWidth -gt 0 -and $bmp.Width -gt $MaxWidth) {
        $scale = $MaxWidth / $bmp.Width
        $newH = [Math]::Max(1, [int]($bmp.Height * $scale))
        $small = New-Object System.Drawing.Bitmap $MaxWidth, $newH
        try {
            $g2 = [System.Drawing.Graphics]::FromImage($small)
            try {
                $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g2.DrawImage($bmp, 0, 0, $MaxWidth, $newH)
            } finally {
                $g2.Dispose()
            }
        } catch {
            $small.Dispose()
            throw
        }
        $bmp.Dispose()
        $bmp = $small
    }

    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    if ($bmp) { $bmp.Dispose() }
}

$item = Get-Item $OutFile
if ($item.Length -le 0) { throw "Screenshot was created but is empty: $OutFile" }
if ($MaxBytes -gt 0 -and $item.Length -gt $MaxBytes) {
    Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
    throw "Screenshot exceeded MaxBytes ($($item.Length) > $MaxBytes)."
}

# Preserve the historical stdout contract: print the created path only.
Write-Output $OutFile
