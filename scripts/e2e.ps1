<#
Runs the browser tests against a throwaway database, then removes it.

It is completely separate from the real shop system, so it is safe to run while the shop system is running:
  - its own database        (meriba_lsms_e2e, created and removed here; the real one is never touched)
  - its own ports           (website 3100, backend 8100; the shop system uses 3000 and 8000)
  - its own website build   (frontend\.next-e2e)

Usage (from the project root):
    powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
    powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1 -Workbook "C:\path\to\MERIBA STORE.xlsx"

Needs: the backend environment and backend\.env set up, `npm install` done in frontend,
and `npx playwright install chromium` run once.
#>
param(
    [string]$Workbook = "",
    [string]$PgBin = "C:\Program Files\PostgreSQL\17\bin",
    [string]$Database = "meriba_lsms_e2e",
    [int]$WebPort = 3100,
    [int]$ApiPort = 8100,
    [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$python = Join-Path $backend ".venv\Scripts\python.exe"

function Get-EnvValue([string]$name) {
    $line = Get-Content (Join-Path $backend ".env") | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
    return ($line -replace "^$name=", "")
}
function Invoke-Psql([string]$sql) {
    $env:PGPASSWORD = Get-EnvValue "DB_PASSWORD"
    $env:PGOPTIONS = "-c client_min_messages=warning"  # keep harmless notices off the error stream
    & "$PgBin\psql.exe" -h (Get-EnvValue "DB_HOST") -U (Get-EnvValue "DB_USER") -d postgres -w -q -c $sql
    $env:PGPASSWORD = $null; $env:PGOPTIONS = $null
}
function Test-Port([int]$port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}
function Stop-Port([int]$port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false -ErrorAction SilentlyContinue }
}

if ($Database -eq (Get-EnvValue "DB_NAME")) { throw "Refusing to run: -Database is the real database." }
if ($WebPort -in 3000, 8000 -or $ApiPort -in 3000, 8000) { throw "Refusing to run on the shop system's own ports (3000 and 8000)." }
foreach ($port in $WebPort, $ApiPort) {
    if (Test-Port $port) { throw "Port $port is in use (perhaps an earlier test run is still going). Choose others with -WebPort / -ApiPort." }
}

$startedServers = $false
$exit = 1
try {
    Write-Host "1/5 Creating throwaway database $Database"
    Invoke-Psql "DROP DATABASE IF EXISTS $Database"
    Invoke-Psql "CREATE DATABASE $Database"
    $env:DB_NAME = $Database
    $env:FRONTEND_ORIGINS = "http://localhost:$WebPort"   # the test website's address, for sign-in protection
    $env:E2E_OWNER = "e2e_owner"
    $env:E2E_OWNER_PASSWORD = "E2e-" + [guid]::NewGuid().ToString("N").Substring(0, 16)
    Push-Location $backend
    & $python manage.py migrate | Out-Null
    & $python manage.py shell -c "import os; from accounts.models import User; u=User(username=os.environ['E2E_OWNER'], role='OWNER', full_name='Test Owner'); u.set_password(os.environ['E2E_OWNER_PASSWORD']); u.save()" | Out-Null
    # A small made-up workbook carrying every kind of exception, for the Excel History tests.
    # (The same one the backend tests use. Excel files are never stored in Git.)
    $fixtures = Join-Path $frontend "e2e\.fixtures"
    New-Item -ItemType Directory -Force $fixtures | Out-Null
    $env:E2E_HISTORY_FIXTURE = Join-Path $fixtures "history-test-workbook.xlsx"
    & $python manage.py shell -c "import os; from tests.test_history import primary; open(os.environ['E2E_HISTORY_FIXTURE'], 'wb').write(primary())" | Out-Null
    if (-not (Test-Path $env:E2E_HISTORY_FIXTURE)) { throw "The history test workbook could not be generated." }
    Pop-Location

    Write-Host "2/5 Building the test copy of the website"
    $env:NEXT_DIST_DIR = ".next-e2e"                       # never the folder the running shop system uses
    $env:BACKEND_URL = "http://127.0.0.1:$ApiPort"
    Push-Location $frontend
    if (-not $SkipBuild -or -not (Test-Path (Join-Path $frontend ".next-e2e\BUILD_ID"))) {
        & npx next build | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "The website did not build." }
    }
    Pop-Location

    Write-Host "3/5 Starting the test backend (port $ApiPort) and test website (port $WebPort)"
    $startedServers = $true
    Start-Process -WindowStyle Hidden -WorkingDirectory $backend -FilePath (Join-Path $backend ".venv\Scripts\waitress-serve.exe") -ArgumentList "--listen=127.0.0.1:$ApiPort", "config.wsgi:application" | Out-Null
    Start-Process -WindowStyle Hidden -WorkingDirectory $frontend -FilePath "cmd.exe" -ArgumentList "/c", "npx next start -p $WebPort" | Out-Null
    $ready = $false
    foreach ($i in 1..40) {
        try {
            if ((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$ApiPort/api/v1/health/" -TimeoutSec 3).StatusCode -eq 200 -and
                (Invoke-WebRequest -UseBasicParsing "http://localhost:$WebPort/login" -TimeoutSec 3).StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 1500 }
    }
    if (-not $ready) { throw "The test servers did not start." }

    Write-Host "4/5 Running the browser tests"
    $env:E2E_BASE_URL = "http://localhost:$WebPort"
    if ($Workbook) { $env:MERIBA_WORKBOOK = $Workbook }
    Push-Location $frontend
    & npx playwright test
    $exit = $LASTEXITCODE
    Pop-Location
}
finally {
    Write-Host "5/5 Cleaning up"
    Set-Location $root
    # Only the two test ports are ever stopped; the shop system's ports are refused above.
    if ($startedServers) { Stop-Port $WebPort; Stop-Port $ApiPort; Start-Sleep -Seconds 2 }
    foreach ($name in "DB_NAME", "FRONTEND_ORIGINS", "E2E_OWNER_PASSWORD", "NEXT_DIST_DIR", "BACKEND_URL", "E2E_BASE_URL") { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    try { Invoke-Psql "DROP DATABASE IF EXISTS $Database" } catch { Write-Warning "Could not remove $Database. Remove it by hand." }
}
if ($exit -eq 0) { Write-Host "Browser tests passed." } else { Write-Host "Browser tests FAILED. Screenshots are in frontend\e2e-results." }
exit $exit
