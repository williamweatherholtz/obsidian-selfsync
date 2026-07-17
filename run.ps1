#requires -Version 5.1
<#
.SYNOPSIS
    Run the new-livesync sync server the real way — via Docker Compose.

.DESCRIPTION
    Thin wrapper around deploy/docker-compose.noproxy.yml (the local-friendly compose
    variant: loopback ports, no domain/Caddy). This is how the server is meant to run for
    real, so dev and production share one runtime and one data location.

    Data lives in the Docker named volume `selfsync-data` (mounted at /data in the
    container) — a single, consistent, backup-able location. Inspect its real path with:
        docker volume inspect selfsync-data

    By default it runs the released image (ghcr.io/williamweatherholtz/obsidian-selfsync-server:latest).
    Use -Local to build the image from THIS repo's source (server/Dockerfile) and run that
    instead, so you can test uncommitted changes through the same compose path.

    Credentials come from deploy/.env. If that file is missing, one is generated with
    SYNC_USER=admin and a random strong SYNC_PASSWORD, printed once (a real password means
    the server boots without any weak-admin override). deploy/.env is gitignored.

.PARAMETER Local
    Build the server image from server/Dockerfile (this repo's source) and run that,
    instead of pulling the released image.

.PARAMETER Down
    Stop and remove the containers. The selfsync-data volume is KEPT (your data survives).

.PARAMETER Logs
    Follow the server logs (docker compose logs -f).

.PARAMETER Foreground
    Run attached in the foreground instead of detached (-d).

.EXAMPLE
    ./run.ps1
    Run the released image, detached. Data -> selfsync-data volume.

.EXAMPLE
    ./run.ps1 -Local
    Build the image from local source and run it through compose.

.EXAMPLE
    ./run.ps1 -Down
    Stop the stack (keeps the data volume).
#>
[CmdletBinding()]
param(
    [switch]$Local,
    [switch]$Down,
    [switch]$Logs,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

# Absolute paths off the script's own location — never depends on the caller's cwd.
$Root       = $PSScriptRoot
$DeployDir  = Join-Path $Root 'deploy'
$Compose    = Join-Path $DeployDir 'docker-compose.noproxy.yml'
$EnvFile    = Join-Path $DeployDir '.env'
$ServerDir  = Join-Path $Root 'server'
$ImageName  = 'ghcr.io/williamweatherholtz/obsidian-selfsync-server:latest'

function Write-Banner($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- Preflight: daemon reachable? ------------------------------------------
try { docker info --format '{{.ServerVersion}}' 1>$null 2>$null } catch {}
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Docker daemon is not reachable. Start Docker Desktop and retry.' -ForegroundColor Red
    exit 1
}

$composeArgs = @('compose', '-f', $Compose, '--env-file', $EnvFile)

# --- Sub-commands that don't need .env -------------------------------------
if ($Down) {
    Write-Banner 'Stopping stack (data volume kept)'
    & docker @composeArgs down
    exit $LASTEXITCODE
}
if ($Logs) {
    & docker @composeArgs logs -f
    exit $LASTEXITCODE
}

# --- Ensure credentials exist (deploy/.env, gitignored) --------------------
if (-not (Test-Path $EnvFile)) {
    $bytes = New-Object 'byte[]' 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pw = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''
    @(
        'SYNC_USER=admin'
        "SYNC_PASSWORD=$pw"
        'LOG_LEVEL=info'
    ) | Set-Content -Path $EnvFile -Encoding ASCII
    Write-Host ''
    Write-Host "  Generated deploy/.env  (SYNC_USER=admin)" -ForegroundColor Yellow
    Write-Host "  SYNC_PASSWORD=$pw" -ForegroundColor Yellow
    Write-Host "  Save this — you'll need it to sign in from Obsidian. Edit deploy/.env to change it." -ForegroundColor Yellow
    Write-Host ''
}

# --- Build local source image if requested ---------------------------------
if ($Local) {
    Write-Banner 'Building image from local source (server/Dockerfile)'
    & docker build -t $ImageName -f (Join-Path $ServerDir 'Dockerfile') $ServerDir
    if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }
} else {
    Write-Banner "Using released image ($ImageName)"
}

# --- Up --------------------------------------------------------------------
$upArgs = $composeArgs + @('up')
if (-not $Foreground) { $upArgs += '-d' }
Write-Banner 'Starting server (data -> selfsync-data volume)'
& docker @upArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $Foreground) {
    Write-Host ''
    Write-Host 'Server running (detached).' -ForegroundColor Green
    Write-Host '  sync/login : http://127.0.0.1:8080   admin : http://127.0.0.1:8091' -ForegroundColor Green
    Write-Host '  logs       : ./run.ps1 -Logs' -ForegroundColor DarkGray
    Write-Host '  stop       : ./run.ps1 -Down   (keeps data)' -ForegroundColor DarkGray
    Write-Host '  data volume: docker volume inspect selfsync-data   (BACK THIS UP)' -ForegroundColor DarkGray
}
