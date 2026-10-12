<#
Runs the browser tests against a throwaway database, then removes it.
Nothing here touches the real database (meriba_lsms).

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
function Stop-Port([int]$port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false -ErrorAction SilentlyContinue }
}

if ($Database -eq (Get-EnvValue "DB_NAME")) { throw "Refusing to run: -Database is the real database." }
foreach ($port in 3000, 8000) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $port is in use. Stop the running shop system first, then run this again."
    }
}

$servers = @()
$exit = 1
try {
    Write-Host "1/5 Creating throwaway database $Database"
    Invoke-Psql "DROP DATABASE IF EXISTS $Database"
    Invoke-Psql "CREATE DATABASE $Database"
    $env:DB_NAME = $Database
    $env:E2E_OWNER = "e2e_owner"
    $env:E2E_OWNER_PASSWORD = "E2e-" + [guid]::NewGuid().ToString("N").Substring(0, 16)
    Push-Location $backend
    & $python manage.py migrate | Out-Null
    & $python manage.py shell -c "import os; from accounts.models import User; u=User(username=os.environ['E2E_OWNER'], role='OWNER', full_name='Test Owner'); u.set_password(os.environ['E2E_OWNER_PASSWORD']); u.save()" | Out-Null
    Pop-Location

    Write-Host "2/5 Building the website"
    Push-Location $frontend
    if (-not $SkipBuild) { & npx next build | Out-Null }
    if ($LASTEXITCODE -ne 0) { throw "The website did not build." }
    Pop-Location

    Write-Host "3/5 Starting the backend and the website"
    $servers += Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory $backend -FilePath (Join-Path $backend ".venv\Scripts\waitress-serve.exe") -ArgumentList "--listen=127.0.0.1:8000", "config.wsgi:application"
    $servers += Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory $frontend -FilePath "cmd.exe" -ArgumentList "/c", "npx next start -p 3000"
    $ready = $false
    foreach ($i in 1..40) {
        try {
            if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/v1/health/ -TimeoutSec 3).StatusCode -eq 200 -and
                (Invoke-WebRequest -UseBasicParsing http://localhost:3000/login -TimeoutSec 3).StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 1500 }
    }
    if (-not $ready) { throw "The servers did not start." }

    Write-Host "4/5 Running the browser tests"
    if ($Workbook) { $env:MERIBA_WORKBOOK = $Workbook }
    Push-Location $frontend
    & npx playwright test
    $exit = $LASTEXITCODE
    Pop-Location
}
finally {
    Write-Host "5/5 Cleaning up"
    Set-Location $root
    foreach ($s in $servers) { Stop-Process -Id $s.Id -Force -Confirm:$false -ErrorAction SilentlyContinue }
    Stop-Port 3000; Stop-Port 8000
    Start-Sleep -Seconds 2
    $env:DB_NAME = $null; $env:E2E_OWNER_PASSWORD = $null
    try { Invoke-Psql "DROP DATABASE IF EXISTS $Database" } catch { Write-Warning "Could not remove $Database. Remove it by hand." }
}
if ($exit -eq 0) { Write-Host "Browser tests passed." } else { Write-Host "Browser tests FAILED. Screenshots are in frontend\e2e-results." }
exit $exit
