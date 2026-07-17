#requires -Version 5.1
<#
.SYNOPSIS
    Build and run the new-livesync sync server — the one obvious way to run it.

.DESCRIPTION
    Builds the server crate (server/), copies the freshly-built binary to a single,
    stable location — ./bin/new-livesync-server.exe — and launches it. You never need
    to hunt through server/target/{debug,release,critique,llvm-cov-target}/ again:
    the current server is always ./bin/new-livesync-server.exe, and ./run.ps1 keeps
    it up to date.

    Builds RELEASE by default (matches what Docker ships). Use -Dev for fast
    iteration (debug) builds. Docker (server/Dockerfile) still builds release independently;
    this script does not touch it.

    Local-dev environment defaults are applied only when you haven't already set them:
      BIND_ADDR = 127.0.0.1:8080   (localhost, not 0.0.0.0 — safer than exposing on the LAN)
      DATA_ROOT = ./.dev-data      (kept out of the repo; gitignored)
      ALLOW_WEAK_ADMIN = 1         (ONLY if SYNC_PASSWORD is unset — lets the default admin/admin
                                    dev credentials boot; prints a loud warning)

.PARAMETER Dev
    Build the fast debug profile instead of release.

.PARAMETER BuildOnly
    Build and copy to ./bin, but do not run the server.

.PARAMETER Clean
    Remove ./bin and server/target/{debug,release} before building.

.EXAMPLE
    ./run.ps1
    Build release, copy to ./bin, and run with local-dev defaults.

.EXAMPLE
    ./run.ps1 -Dev -- --some-server-flag value
    Build debug and run, forwarding everything after `--` to the server.
#>
[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$BuildOnly,
    [switch]$Clean,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ServerArgs
)

$ErrorActionPreference = 'Stop'

# Absolute paths off the script's own location — never depends on the caller's cwd.
$Root      = $PSScriptRoot
$ServerDir = Join-Path $Root 'server'
$Manifest  = Join-Path $ServerDir 'Cargo.toml'
$BinDir    = Join-Path $Root 'bin'
$ExeName   = 'new-livesync-server.exe'
$BinPath   = Join-Path $BinDir $ExeName

$Profile   = if ($Dev) { 'debug' } else { 'release' }
$BuiltExe  = Join-Path $ServerDir "target/$Profile/$ExeName"

function Write-Banner($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

if ($Clean) {
    Write-Banner 'Cleaning ./bin and server/target/{debug,release}'
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $BinDir
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $ServerDir 'target/debug')
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $ServerDir 'target/release')
}

# --- Build -----------------------------------------------------------------
Write-Banner "Building server ($Profile)"
$cargoArgs = @('build', '--manifest-path', $Manifest)
if (-not $Dev) { $cargoArgs += '--release' }
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)" }

if (-not (Test-Path $BuiltExe)) {
    throw "Build reported success but $BuiltExe is missing."
}

# --- Publish to the one obvious location -----------------------------------
if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }
Copy-Item -Force $BuiltExe $BinPath
Write-Banner "Current server: $BinPath"

if ($BuildOnly) {
    Write-Host "Build-only: not running. Launch it with: `"$BinPath`"" -ForegroundColor DarkGray
    return
}

# --- Local-dev env defaults (only fill what the caller left unset) ----------
if (-not $env:BIND_ADDR) { $env:BIND_ADDR = '127.0.0.1:8080' }
if (-not $env:DATA_ROOT) { $env:DATA_ROOT = (Join-Path $Root '.dev-data') }

if (-not $env:SYNC_PASSWORD) {
    $env:ALLOW_WEAK_ADMIN = '1'
    Write-Host ''
    Write-Host '  WARNING: SYNC_PASSWORD is unset — booting with default dev credentials (admin/admin)' -ForegroundColor Yellow
    Write-Host '           via ALLOW_WEAK_ADMIN=1. Set SYNC_PASSWORD to a real secret for anything but' -ForegroundColor Yellow
    Write-Host '           a trusted local box.' -ForegroundColor Yellow
    Write-Host ''
}

Write-Banner "Running  (BIND_ADDR=$($env:BIND_ADDR)  DATA_ROOT=$($env:DATA_ROOT))"
if ($ServerArgs) {
    & $BinPath @ServerArgs
} else {
    & $BinPath
}
exit $LASTEXITCODE
