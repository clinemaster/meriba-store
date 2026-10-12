# Backup and restore

Everything the shop records — sales, stock, closings, users, audit trail — is in the PostgreSQL database
`meriba_lsms`. Back up that database and you can rebuild the system on any computer.
(The program code is in Git; it does not need a separate backup.)

**Tested 12 Oct 2026:** a database containing a sale, stock movements, a closed day and audit records was
backed up with `pg_dump`, restored into a new empty database with `pg_restore`, and compared.
Sales, movements, closing balance, stock quantity and audit count were identical. This was on a small test
database on the development computer; repeat the drill on the shop computer before going live.

## What a good routine looks like

- A backup **every night** after the day is closed.
- A copy **off the computer** (USB disk kept elsewhere, or a cloud folder). A backup on the same disk does
  not protect against theft, fire or a failed disk.
- Keep at least 30 daily copies.
- A **restore drill** every few months. A backup that has never been restored is only a hope.
- Always take a backup **before** updating the software or importing data.

Backups contain all business records and password hashes. Store them as carefully as cash.

## Take a backup by hand

```powershell
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
New-Item -ItemType Directory -Force C:\MeribaBackups | Out-Null
& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -h localhost -U meriba_lsms -Fc `
    -f "C:\MeribaBackups\meriba_lsms_$stamp.dump" meriba_lsms
```

It asks for the database password (the `DB_PASSWORD` value in `backend\.env`).
The backup is safe to take while the shop is open; it captures one consistent moment.

Check the file exists and is not tiny. Then copy it off the computer.

## Automatic nightly backup

1. Save the password so the task can run unattended. Create the file
   `%APPDATA%\postgresql\pgpass.conf` containing one line (your real password at the end):
   ```
   localhost:5432:meriba_lsms:meriba_lsms:your-database-password
   ```
2. Save this as `C:\MeribaBackups\backup.ps1`:
   ```powershell
   $dir = "C:\MeribaBackups"
   $stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
   $file = Join-Path $dir "meriba_lsms_$stamp.dump"
   & "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -h localhost -U meriba_lsms -w -Fc -f $file meriba_lsms
   if ($LASTEXITCODE -ne 0 -or -not (Test-Path $file) -or (Get-Item $file).Length -lt 10000) {
       Add-Content (Join-Path $dir "backup_errors.log") "$(Get-Date -Format s) BACKUP FAILED"
       exit 1
   }
   # keep the newest 30 backups
   Get-ChildItem $dir -Filter "meriba_lsms_*.dump" | Sort-Object LastWriteTime -Descending |
       Select-Object -Skip 30 | Remove-Item -Confirm:$false
   ```
3. In **Task Scheduler**, create a daily task (for example 23:30) running
   `powershell.exe -ExecutionPolicy Bypass -File C:\MeribaBackups\backup.ps1`.
4. The next morning, check a new file is there. Check `backup_errors.log` now and then.
5. Arrange the off-computer copy (for example sync `C:\MeribaBackups` to a cloud folder, or copy to a USB
   disk weekly).

## Restore

### Safe drill (does not touch the live data) — do this first

```powershell
$bin = "C:\Program Files\PostgreSQL\17\bin"
& "$bin\psql.exe" -h localhost -U meriba_lsms -d postgres -c "CREATE DATABASE meriba_restore_check"
& "$bin\pg_restore.exe" -h localhost -U meriba_lsms --no-owner -d meriba_restore_check "C:\MeribaBackups\<file>.dump"
& "$bin\psql.exe" -h localhost -U meriba_lsms -d meriba_restore_check -c `
  "select (select count(*) from sales_sale) as sales, (select max(date) from trading_businessday) as last_day, (select closing_cumulative_sales from trading_businessday where status='CLOSED' order by date desc limit 1) as last_closing"
```

Compare the figures with what you expect (the last closed day and its closing balance on the Daily Closing
screen). When satisfied, remove the check copy:

```powershell
& "$bin\psql.exe" -h localhost -U meriba_lsms -d postgres -c "DROP DATABASE meriba_restore_check"
```

### Real recovery (the live database is lost or damaged)

> This replaces the live data with the backup. **Anything recorded after the backup was taken will be gone.**
> Only the Owner should decide to do this. If the damaged database still opens, back it up first under a
> different file name.

1. Stop the backend and the website so nobody is using the system.
2. If the old database still exists, keep it by renaming it, rather than deleting it:
   ```powershell
   & "$bin\psql.exe" -h localhost -U postgres -c "ALTER DATABASE meriba_lsms RENAME TO meriba_lsms_damaged"
   ```
3. Create an empty database and restore into it:
   ```powershell
   & "$bin\psql.exe" -h localhost -U postgres -c "CREATE DATABASE meriba_lsms OWNER meriba_lsms ENCODING 'UTF8'"
   & "$bin\pg_restore.exe" -h localhost -U meriba_lsms --no-owner -d meriba_lsms "C:\MeribaBackups\<file>.dump"
   ```
4. Bring the tables up to the current software version: `.\.venv\Scripts\python manage.py migrate`
5. Start the backend and website. Sign in and check the last closed day, its closing cumulative sales
   balance, and the stock of a few products.
6. Re-enter, from paper receipts or notes, any sales made after the backup. Record why in the shift's closing note.
7. Remove `meriba_lsms_damaged` only once you are sure it is no longer needed.

### On a brand-new computer

Follow DEPLOYMENT.md steps 1–2 (install, create the role and database, configure `.env`), then restore
steps 3–5 above instead of creating the first Owner.

## What is not backed up by this procedure

- `backend\.env` (passwords and the secret key). Keep a copy in a safe place, separate from the backups.
- The original Excel workbook and the SRS document.
