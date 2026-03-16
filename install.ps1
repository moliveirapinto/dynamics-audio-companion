# ============================================================
#  Dynamics Audio Companion - One-Click Installer
#  Supports: Bose, Jabra, Poly, Plantronics, AirPods, and other headsets
#  NO external dependencies required (no Node.js, no npm).
# ============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "   Dynamics Audio Companion - Installer" -ForegroundColor Cyan
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Verify native host files ──
Write-Host "  [1/4] Checking native host files..." -ForegroundColor Yellow
$nhDir = Join-Path $root "native-host"
$nodePath = Join-Path $nhDir "node.exe"
$hostScript = Join-Path $nhDir "host.js"
$runCmd = Join-Path $nhDir "run-host.cmd"
$wksPath = Join-Path $nhDir "WinKeyServer.exe"

# Download node.exe if missing (official signed binary from nodejs.org)
if (-not (Test-Path $nodePath)) {
    Write-Host "  Downloading official Node.js runtime (signed by OpenJS Foundation)..." -ForegroundColor Yellow
    $nodeVersion = 'v22.15.0'
    $nodeUrl = "https://nodejs.org/dist/$nodeVersion/win-x64/node.exe"
    try {
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodePath -UseBasicParsing
        Write-Host "  node.exe downloaded" -ForegroundColor Green
    } catch {
        Write-Host "  ERROR: Failed to download node.exe" -ForegroundColor Red
        Write-Host "  Check your internet connection and try again." -ForegroundColor Red
        Write-Host ""
        Read-Host "  Press Enter to exit"
        exit 1
    }
}

# Install node_modules if missing (needed for node-global-key-listener)
if ((Test-Path $hostScript) -and -not (Test-Path (Join-Path $nhDir 'node_modules'))) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        Write-Host "  Installing dependencies..." -ForegroundColor Yellow
        Push-Location $nhDir
        npm install --production 2>$null | Out-Null
        Pop-Location
    } else {
        Write-Host "  WARNING: node_modules folder is missing and npm is not available." -ForegroundColor Red
        Write-Host "  Bluetooth headset support (native host) may not work." -ForegroundColor Yellow
        Write-Host "  Download a pre-built release from:" -ForegroundColor White
        Write-Host "    https://github.com/moliveirapinto/dynamics-audio-companion/releases" -ForegroundColor Cyan
        Write-Host ""
        Read-Host "  Press Enter to continue anyway (or Ctrl+C to abort)"
    }
}

# Create run-host.cmd if missing
if (-not (Test-Path $runCmd)) {
    '@echo off' | Set-Content $runCmd
    '"%~dp0node.exe" "%~dp0host.js"' | Add-Content $runCmd
}

if (-not (Test-Path $hostScript)) {
    Write-Host "  ERROR: host.js not found!" -ForegroundColor Red
    Write-Host "  Make sure you extracted all files from the zip." -ForegroundColor Red
    Write-Host ""
    Read-Host "  Press Enter to exit"
    exit 1
}

Write-Host "  Native host files verified" -ForegroundColor Green

# ── Step 2: Load extension in Edge ──
Write-Host "  [2/4] Extension setup..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  You need to load the extension in Microsoft Edge:" -ForegroundColor White
Write-Host "    1. Open Edge and go to: edge://extensions/" -ForegroundColor Gray
Write-Host "    2. Enable 'Developer mode' (toggle in bottom-left)" -ForegroundColor Gray
Write-Host "    3. Click 'Load unpacked'" -ForegroundColor Gray
Write-Host "    4. Select this folder:" -ForegroundColor Gray
Write-Host "       $root" -ForegroundColor Cyan
Write-Host "    5. Copy the Extension ID shown under the extension name" -ForegroundColor Gray
Write-Host ""

$extId = Read-Host "  Paste the Extension ID here"
$extId = $extId.Trim()

if ($extId.Length -lt 10) {
    Write-Host "  ERROR: Invalid extension ID" -ForegroundColor Red
    exit 1
}

# ── Step 3: Register native messaging host ──
Write-Host "  [3/4] Registering native messaging host..." -ForegroundColor Yellow

# Native messaging manifest points to the cmd wrapper
$manifestPath = Join-Path $nhDir "com.bose.d365.headset.json"
$cmdPathEscaped = $runCmd.Replace('\', '\\')

$jsonContent = '{
  "name": "com.bose.d365.headset",
  "description": "Dynamics Audio Companion",
  "path": "' + $cmdPathEscaped + '",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://' + $extId + '/"
  ]
}'
$jsonContent | Set-Content $manifestPath -Encoding UTF8

# Register in browser registries
$regPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.bose.d365.headset"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestPath

$regPath2 = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.bose.d365.headset"
New-Item -Path $regPath2 -Force | Out-Null
Set-ItemProperty -Path $regPath2 -Name "(Default)" -Value $manifestPath

Write-Host "  Native host registered for Edge and Chrome" -ForegroundColor Green

# ── Step 4: Verify ──
Write-Host "  [4/4] Verifying installation..." -ForegroundColor Yellow

$checks = @()
$checks += @{ Name = "Extension folder";    OK = (Test-Path "$root\manifest.json") }
$checks += @{ Name = "node.exe";            OK = (Test-Path $nodePath) }
$checks += @{ Name = "host.js";             OK = (Test-Path $hostScript) }
$checks += @{ Name = "run-host.cmd";        OK = (Test-Path $runCmd) }
$checks += @{ Name = "Native manifest";     OK = (Test-Path $manifestPath) }
$checks += @{ Name = "Registry (Edge)";     OK = (Test-Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.bose.d365.headset") }

Write-Host ""
foreach ($c in $checks) {
    $icon = if ($c.OK) { "[OK]" } else { "[FAIL]" }
    $color = if ($c.OK) { "Green" } else { "Red" }
    Write-Host "    $icon $($c.Name)" -ForegroundColor $color
}

$allOk = ($checks | Where-Object { -not $_.OK }).Count -eq 0

Write-Host ""
if ($allOk) {
    Write-Host "  ================================================================" -ForegroundColor Green
    Write-Host "   INSTALLATION COMPLETE!" -ForegroundColor Green
    Write-Host "  ================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor White
    Write-Host "    1. Reload the extension in edge://extensions/" -ForegroundColor Gray
    Write-Host "    2. Open Dynamics 365 Contact Center" -ForegroundColor Gray
    Write-Host "    3. Click the Dynamics Audio Companion extension icon" -ForegroundColor Gray
    Write-Host "    4. Click 'Connect Headset'" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Extension ID: $extId" -ForegroundColor Cyan
    Write-Host "  Install path: $root" -ForegroundColor Cyan
} else {
    Write-Host "  ================================================================" -ForegroundColor Red
    Write-Host "   INSTALLATION HAD ERRORS - check the items above" -ForegroundColor Red
    Write-Host "  ================================================================" -ForegroundColor Red
}

Write-Host ""
Read-Host "  Press Enter to close"
