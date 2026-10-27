<#
Creates a verified PostgreSQL custom-format backup of the configured MERIBA database.
Reads non-secret connection settings from backend\.env and gets the password from pgpass.conf.
#>
[CmdletBinding()]
param(
    [string]$BackupDirectory = "C:\MeribaBackups",
    [string]$PgBin = "",
    [ValidateRange(1, 3650)]
    [int]$RetentionCount = 30,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$envFile = Join-Path $backend ".env"
$lockStream = $null
$partialFile = $null
$logFile = Join-Path $BackupDirectory "backup.log"
$errorLog = Join-Path $BackupDirectory "backup_errors.log"

function Get-EnvSetting([string]$Name, [string]$Default = "") {
    $match = Get-Content -LiteralPath $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -First 1
    if (-not $match) { return $Default }
    $value = ($match -split "=", 2)[1].Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
}

function Add-BackupLog([string]$Path, [string]$Message) {
    Add-Content -LiteralPath $Path -Value "$(Get-Date -Format s) $Message" -Encoding UTF8
}

try {
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw "Backend configuration not found: $envFile" }

    $database = Get-EnvSetting "DB_NAME"
    $user = Get-EnvSetting "DB_USER"
    $hostName = Get-EnvSetting "DB_HOST" "localhost"
    $port = Get-EnvSetting "DB_PORT" "5432"
    if (-not $database -or -not $user) { throw "DB_NAME and DB_USER must be set in backend\.env." }
    if ($database -notmatch "^[A-Za-z0-9_]+$") { throw "DB_NAME contains characters that are not supported by this backup script." }
    if ($port -notmatch "^\d+$") { throw "DB_PORT in backend\.env must be a port number." }

    if (-not $PgBin) {
        $onPath = Get-Command pg_dump.exe -ErrorAction SilentlyContinue
        if ($onPath) {
            $PgBin = Split-Path -Parent $onPath.Source
        } else {
            $installRoot = Join-Path $env:ProgramFiles "PostgreSQL"
            $installations = @(Get-ChildItem -LiteralPath $installRoot -Directory -ErrorAction SilentlyContinue |
                Sort-Object { try { [version]$_.Name } catch { [version]"0.0" } } -Descending)
            foreach ($installation in $installations) {
                $candidate = Join-Path $installation.FullName "bin"
                if ((Test-Path (Join-Path $candidate "pg_dump.exe")) -and (Test-Path (Join-Path $candidate "pg_restore.exe"))) {
                    $PgBin = $candidate
                    break
                }
            }
        }
    }
    $pgDump = Join-Path $PgBin "pg_dump.exe"
    $pgRestore = Join-Path $PgBin "pg_restore.exe"
    if (-not (Test-Path -LiteralPath $pgDump -PathType Leaf) -or -not (Test-Path -LiteralPath $pgRestore -PathType Leaf)) {
        throw "pg_dump.exe and pg_restore.exe were not found. Supply -PgBin with the PostgreSQL bin folder."
    }

    $passFile = $env:PGPASSFILE
    if (-not $passFile) { $passFile = Join-Path $env:APPDATA "postgresql\pgpass.conf" }
    if (-not (Test-Path -LiteralPath $passFile -PathType Leaf)) {
        throw "PostgreSQL password file not found. Create %APPDATA%\postgresql\pgpass.conf as described in docs\BACKUP_AND_RESTORE.md."
    }

    New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
    if ($ValidateOnly) {
        Write-Host "Backup prerequisites found. Database authentication was not tested. Database: $database; PostgreSQL tools: $PgBin; destination: $BackupDirectory."
        exit 0
    }

    $lockPath = Join-Path $BackupDirectory ".backup.lock"
    try {
        $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch {
        throw "Another backup may already be running; could not acquire the backup lock."
    }

    $env:PGHOST = $hostName
    $env:PGPORT = $port
    $env:PGUSER = $user
    $env:PGDATABASE = $database
    $env:PGPASSFILE = $passFile

    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupFile = Join-Path $BackupDirectory "meriba_lsms_$stamp.dump"
    $partialFile = "$backupFile.partial"
    Add-BackupLog $logFile "Starting backup for database $database."

    & $pgDump -w -Fc -f $partialFile
    if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath $partialFile -PathType Leaf) -or (Get-Item -LiteralPath $partialFile).Length -eq 0) {
        throw "pg_dump did not create a non-empty backup file."
    }

    $validationOutput = @(& $pgRestore --list $partialFile 2>&1)
    if ($LASTEXITCODE -ne 0) {
        if ($validationOutput.Count -gt 0) { Write-Host ($validationOutput -join [Environment]::NewLine) }
        throw "The backup archive failed pg_restore validation."
    }

    Move-Item -LiteralPath $partialFile -Destination $backupFile
    $partialFile = $null

    $oldBackups = @(Get-ChildItem -LiteralPath $BackupDirectory -File -Filter "meriba_lsms_*.dump" |
        Where-Object { $_.Name -match "^meriba_lsms_\d{8}_\d{6}\.dump$" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $RetentionCount)
    foreach ($oldBackup in $oldBackups) {
        Remove-Item -LiteralPath $oldBackup.FullName -Force
    }

    Add-BackupLog $logFile "Backup verified: $backupFile ($((Get-Item -LiteralPath $backupFile).Length) bytes). Retained newest $RetentionCount backup(s)."
    Write-Host "Backup completed and verified: $backupFile"
} catch {
    $message = $_.Exception.Message
    if ($partialFile -and (Test-Path -LiteralPath $partialFile)) {
        Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
    }
    try {
        New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
        Add-BackupLog $errorLog "BACKUP FAILED: $message"
    } catch {
        Write-Warning "Could not write the backup error log."
    }
    Write-Error $message
    exit 1
} finally {
    if ($lockStream) { $lockStream.Dispose() }
}
