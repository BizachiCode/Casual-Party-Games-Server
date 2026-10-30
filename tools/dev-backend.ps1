# Local play-test backend for Windows without Docker.
# Starts a private MySQL 8.4 instance (data in Server/data/mysql, ignored by Git) and runs the party server.
# Usage (from the Unity project folder): powershell -ExecutionPolicy Bypass -File Server/tools/dev-backend.ps1 [-MySqlPort 3316] [-Port 2567]
param(
    [int]$MySqlPort = 3316,
    [int]$Port = 2567,
    [string]$MySqlHome = "C:\Program Files\MySQL\MySQL Server 8.4"
)
$ErrorActionPreference = "Stop"
$server = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $server "data\mysql"
$mysqld = Join-Path $MySqlHome "bin\mysqld.exe"
$mysql = Join-Path $MySqlHome "bin\mysql.exe"
if (-not (Test-Path $mysqld)) { throw "MySQL 8.4 not found at $MySqlHome. Install it or pass -MySqlHome." }

# Windows PowerShell splits "-h127.0.0.1" and treats native stderr as fatal, so use long quoted options.
function Invoke-MySql([string]$Sql) {
    $previous = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $mysql "--user=root" "--host=127.0.0.1" "--port=$MySqlPort" "--execute=$Sql" 2>$null | Out-Null
    $ok = $LASTEXITCODE -eq 0; $ErrorActionPreference = $previous; return $ok
}

if (-not (Test-Path (Join-Path $dataDir "mysql"))) {
    Write-Host "Initializing development database in $dataDir"
    New-Item -ItemType Directory -Force -Path (Split-Path $dataDir) | Out-Null
    & $mysqld --initialize-insecure "--basedir=$MySqlHome" "--datadir=$dataDir" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "mysqld --initialize-insecure failed." }
}

$listening = Get-NetTCPConnection -State Listen -LocalPort $MySqlPort -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Host "Starting MySQL on 127.0.0.1:$MySqlPort"
    Start-Process -FilePath $mysqld -WindowStyle Hidden -ArgumentList @(
        "--basedir=`"$MySqlHome`"", "--datadir=`"$dataDir`"", "--port=$MySqlPort",
        "--bind-address=127.0.0.1", "--mysqlx=OFF", "--console")
    for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; if (Invoke-MySql "SELECT 1") { break } }
}
if (-not (Invoke-MySql "CREATE DATABASE IF NOT EXISTS party CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;")) {
    throw "MySQL did not accept connections on port $MySqlPort."
}

if (-not (Test-Path (Join-Path $server "node_modules"))) { Push-Location $server; npm ci --no-audit --no-fund; Pop-Location }

# Development only: root without a password, reachable from this machine only.
$env:DATABASE_URL = "mysql://root@127.0.0.1:$MySqlPort/party"
$env:HOST = "127.0.0.1"
$env:PORT = "$Port"
$env:PARTY_REDIS_PREFIX = "party:dev"
Write-Host "Party server on ws://127.0.0.1:$Port  (Ctrl+C to stop; MySQL keeps running in the background)"
Push-Location $server
try { npm start } finally { Pop-Location }
