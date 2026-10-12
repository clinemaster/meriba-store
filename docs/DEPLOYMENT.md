# Deployment and maintenance

**Status:** these steps match the application as built, and the server commands (`waitress-serve`,
`next build`, `next start`) were run successfully on the development computer. A full installation on the
shop's own computer has **not** been rehearsed yet. Do that, and a backup/restore drill, before going live.

Two ways to run the shop system:

- **A. One shop computer (or shop network)** — recommended to start. Works without internet.
- **B. A server with a domain name and HTTPS** — if it must be reached from outside the shop.

## What must be installed

| Software | Version used |
|---|---|
| PostgreSQL | 17 |
| Python | 3.12 |
| Node.js | 26 (current LTS line) |
| Git | any recent |

## A. Shop computer (Windows)

### 1. Database (once)

Open **SQL Shell (psql)** as the `postgres` user and run, choosing your own strong password:

```sql
CREATE ROLE meriba_lsms LOGIN PASSWORD 'choose-a-long-password';
CREATE DATABASE meriba_lsms OWNER meriba_lsms ENCODING 'UTF8';
```

### 2. Get the code and configure it (once)

```powershell
cd C:\Projects
git clone <where-the-repository-is-kept> meriba-lsms
cd meriba-lsms\backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
notepad .env
```

In `.env` set:

| Setting | Value |
|---|---|
| `DJANGO_ENV` | `production` |
| `DJANGO_DEBUG` | `false` |
| `DJANGO_SECRET_KEY` | a new long random value: `python -c "import secrets; print(secrets.token_urlsafe(64))"` |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1` plus the computer's name or address if other devices will connect |
| `FRONTEND_ORIGINS` | the address people type, e.g. `http://localhost:3000` or `http://192.168.1.10:3000` |
| `DB_PASSWORD` | the password chosen in step 1 |
| `DJANGO_SSL_REDIRECT` | `false` **only** when running without HTTPS inside the shop (see the note below) |

> **Note on running without HTTPS.** In production mode, sign-in cookies are marked "HTTPS only". On a plain
> `http://` shop network the browser will not send them and nobody can sign in. Until HTTPS is set up
> (option B, or a local certificate), run with `DJANGO_ENV=development` and `DJANGO_DEBUG=false`. This keeps
> every permission and data rule but drops the HTTPS-only cookie flags. Only do this on a trusted network.

### 3. Prepare the database and the first Owner (once)

```powershell
.\.venv\Scripts\python manage.py migrate
.\.venv\Scripts\python manage.py collectstatic --noinput
.\.venv\Scripts\python manage.py create_owner <username> --full-name "Owner Name"
```

### 4. Build the website (once, and after every update)

```powershell
cd C:\Projects\meriba-lsms\frontend
npm ci
npm run build
```

### 5. Start it

Two programs must be running:

```powershell
# Backend
cd C:\Projects\meriba-lsms\backend
.\.venv\Scripts\waitress-serve --listen=127.0.0.1:8000 config.wsgi:application

# Website (second window)
cd C:\Projects\meriba-lsms\frontend
npm run start
```

Open `http://localhost:3000`.

To let a tablet on the shop Wi-Fi use it, start the website with `npx next start -H 0.0.0.0 -p 3000`, allow
port 3000 in Windows Firewall for the private network, and add the computer's address to
`DJANGO_ALLOWED_HOSTS` and `FRONTEND_ORIGINS`. Keep port 8000 closed to other devices.

### 6. Start automatically with Windows

Create two tasks in **Task Scheduler** ("At startup", "Run whether user is logged on or not"), one per
command in step 5, each with "Start in" set to its folder. (A service wrapper such as NSSM also works.)
PostgreSQL already starts by itself.

## B. Server with a domain and HTTPS

Same steps 1–4 on the server (Linux commands differ only in paths), then:

1. Run the backend on `127.0.0.1:8000` and the website on `127.0.0.1:3000` as services
   (systemd on Linux) so they restart automatically.
2. Put a web server in front (Caddy or Nginx) that listens on ports 80/443 for your domain and passes
   everything to `127.0.0.1:3000`. It must send the header `X-Forwarded-Proto: https`.
   Caddy obtains and renews the HTTPS certificate by itself:
   ```
   shop.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. Point the domain's DNS "A" record at the server's address.
4. In `.env`: `DJANGO_ENV=production`, `DJANGO_ALLOWED_HOSTS=shop.example.com`,
   `FRONTEND_ORIGINS=https://shop.example.com`. Leave `DJANGO_SSL_REDIRECT` unset (on).
5. Only ports 80 and 443 should be open to the internet. Never expose 5432 (PostgreSQL), 8000 or 3000.

## Updating to a new version

```powershell
# 1. Take a backup first (see BACKUP_AND_RESTORE.md). Do this when no day is open.
# 2. Stop both programs, then:
cd C:\Projects\meriba-lsms;           git pull
cd backend;   .\.venv\Scripts\pip install -r requirements.txt
              .\.venv\Scripts\python manage.py migrate
              .\.venv\Scripts\python manage.py collectstatic --noinput
cd ..\frontend; npm ci; npm run build
# 3. Start both programs again and sign in to check.
```

## Checking it is healthy

- `http://127.0.0.1:8000/api/v1/health/` should show `{"status": "ok"}`.
- Backend log: `backend\logs\app.log`. Every line has a request id; the same id is in the
  `X-Request-ID` header of the response.

## Common problems

| What you see | Likely cause | What to do |
|---|---|---|
| "We could not reach the shop system" | Backend not running, or network down | Start the backend; open the health address above |
| Sign-in page keeps coming back after a correct password | Production mode over plain `http://` | See the HTTPS note in step 2 |
| "You do not have permission" right after signing in on a new address | Address missing from `FRONTEND_ORIGINS` | Add it to `.env`, restart the backend |
| A blank "Bad Request (400)" page | Address missing from `DJANGO_ALLOWED_HOSTS` | Add it, restart the backend |
| Backend stops at start with "Missing required setting" | `.env` missing or incomplete | Compare with `.env.example` |
| "password authentication failed" in the log | Wrong `DB_PASSWORD` | Correct it in `.env` |
| "The day of … has not been closed yet" | Yesterday was left open | Accountant/Owner: Daily Closing → *Close it for them* |
| "This computer's date is earlier than the last closed day" | Windows clock is wrong | Fix the date and time |
| Too many sign-in attempts | 10 tries per minute limit | Wait one minute |

## Security checklist before going live

- [ ] `DJANGO_DEBUG=false` and a fresh `DJANGO_SECRET_KEY`
- [ ] Strong database password; PostgreSQL not reachable from outside the computer
- [ ] Every person has their own account; no shared logins
- [ ] Automatic daily backup running and a restore tried once
- [ ] Windows user account on the shop computer has a password and auto-locks
- [ ] HTTPS in place if anyone connects from outside the shop
