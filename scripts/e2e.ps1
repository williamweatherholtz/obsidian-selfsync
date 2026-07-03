<#
.SYNOPSIS
  End-to-end harness for the self-hosted Obsidian sync system (Windows / PowerShell).
  Builds the server + plugin, runs the automated suites, stages two ready-to-open
  Obsidian test vaults (plugin pre-installed + pre-configured to auto-connect), and
  by default starts the server.

.EXAMPLE
  ./scripts/e2e.ps1                 # build + test + stage + start server
  ./scripts/e2e.ps1 -Clean          # also reset server data + vault notes to empty
  ./scripts/e2e.ps1 -NoServe        # set everything up but don't start the server
  ./scripts/e2e.ps1 -SkipTests      # skip the automated suites (build + stage only)

  Requires: cargo, node/npm on PATH. Safe to re-run.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$Clean,
  [switch]$NoServe,
  [switch]$SkipTests
)

$root   = Split-Path -Parent $PSScriptRoot
$e2e    = Join-Path $root '.e2e'
$server = Join-Path $root 'server'
$client = Join-Path $root 'client'

function Step($m) { Write-Host "`n== $m ==" -ForegroundColor Cyan }
function Fail($m) { Write-Host "FAILED: $m" -ForegroundColor Red; exit 1 }
function Write-Utf8NoBom($path, $content) { [System.IO.File]::WriteAllText($path, $content) }

# --- Build server ---
Step 'Build server'
Push-Location $server
cargo build
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'cargo build' }
Pop-Location

# --- Build plugin (install deps on first run) ---
Step 'Build plugin'
Push-Location $client
if (-not (Test-Path (Join-Path $client 'node_modules'))) {
  npm install
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'npm install' }
}
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'npm run build' }
Pop-Location

# --- Automated tests (gate: must be green before manual E2E) ---
if (-not $SkipTests) {
  Step 'Automated tests (fail here = do NOT proceed to manual E2E)'
  Push-Location $server
  cargo test
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'cargo test' }
  Pop-Location
  Push-Location $client
  npx vitest run
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'vitest' }
  Pop-Location
}

# --- Stage the E2E workspace ---
Step 'Stage E2E workspace at .e2e\'
New-Item -ItemType Directory -Force -Path $e2e | Out-Null
Write-Utf8NoBom (Join-Path $e2e '.gitignore') "*`n"   # keep scratch out of git
if ($Clean) {
  Write-Host '-Clean: wiping server data + vault notes'
  foreach ($d in 'data','vaultA','vaultB') {
    Remove-Item -Recurse -Force (Join-Path $e2e $d) -ErrorAction SilentlyContinue
  }
}
New-Item -ItemType Directory -Force -Path (Join-Path $e2e 'data') | Out-Null

function Stage-Vault($name) {
  $pdir = Join-Path $e2e "$name\.obsidian\plugins\new-livesync"
  New-Item -ItemType Directory -Force -Path $pdir | Out-Null
  Copy-Item (Join-Path $client 'main.js')      $pdir -Force -ErrorAction Stop
  Copy-Item (Join-Path $client 'manifest.json') $pdir -Force -ErrorAction Stop
  # Pre-seed plugin settings so it auto-connects on open (no manual config).
  Write-Utf8NoBom (Join-Path $pdir 'data.json') '{"serverUrl":"http://localhost:8080","username":"admin","password":"admin"}'
  # Mark the plugin enabled for this vault.
  Write-Utf8NoBom (Join-Path $e2e "$name\.obsidian\community-plugins.json") '["new-livesync"]'
  Write-Host "  staged $name  ->  $(Join-Path $e2e $name)"
}
Stage-Vault 'vaultA'
Stage-Vault 'vaultB'

$dataDir = Join-Path $e2e 'data'

Step 'READY - manual Obsidian verification'
Write-Host 'Open BOTH of these in Obsidian ("Open folder as vault", two windows):'
Write-Host "  $(Join-Path $e2e 'vaultA')"
Write-Host "  $(Join-Path $e2e 'vaultB')"
Write-Host '  If prompted: turn OFF Restricted Mode and confirm "New LiveSync" is enabled.'
Write-Host '  It auto-connects (Server URL + admin/admin are pre-seeded).'
Write-Host "Server's live vault files (bind mount) will be at:  $dataDir\vault"
Write-Host 'Scenario checklist: docs\design\e2e-process.md'

if ($NoServe) {
  Write-Host "`nStart the server yourself in this window with:" -ForegroundColor Yellow
  Write-Host "  Set-Location `"$server`""
  Write-Host "  `$env:DATA_ROOT='$dataDir'; `$env:SYNC_USER='admin'; `$env:SYNC_PASSWORD='admin'; cargo run"
} else {
  Step 'Starting server (Ctrl+C to stop) - now open the two vaults in Obsidian'
  $env:DATA_ROOT    = $dataDir
  $env:SYNC_USER    = 'admin'
  $env:SYNC_PASSWORD = 'admin'
  Push-Location $server
  cargo run
  Pop-Location
}
