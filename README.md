# MERIBA Liquor Store Management System

A point-of-sale, stock and daily-closing system for MERIBA Store. Built from the
requirements in `MERIBA_Liquor_Store_Management_System_SRS_v2.3.docx`.

**Status: in development. Not ready for production.** See
[docs/REQUIREMENTS_CHECKLIST.md](docs/REQUIREMENTS_CHECKLIST.md) for exactly what works today
and what is still to be built.

## What works today

- Individual sign-in for three roles: Owner, Accountant, Cashier. Rules are enforced on the server.
- Guided first-time setup: products, opening stock count, cashier account, then "go live".
- Cashier day: Start Day → New Sale → receipt → Today's Sales → Close Day with cash count.
- Stock goes down automatically with each sale, through a ledger that cannot be edited.
- Cash, mobile money and bank payments, including paying one sale with more than one method.
- Cumulative monetary sales balance: each day opens with the last closed day's closing balance.
- Back office: review cashier closings, cancel or refund a sale, receive deliveries, expenses, stock corrections, users, audit trail.
- Refunds are recorded on the current day; closed days change only through an Owner's audited correction.
- Eleven reports with CSV export.
- Opening stock from a physical count sheet that only the Owner can approve.
- Historical Excel import with dry run, exception review, product mapping review and an exception report. Historical data stays separate from live stock and is labelled not reconciled until the Owner accepts it.

## Parts

| Folder | What it is | Technology |
|---|---|---|
| `backend/` | The API and all business rules | Python 3.12, Django 5.2 LTS, Django REST Framework 3.16, PostgreSQL 17 |
| `frontend/` | The website people use | Next.js 15.5, React 19, TypeScript 5.9, Tailwind CSS 3.4 |
| `docs/` | Project documents | Markdown |

Exact versions are pinned in `backend/requirements.txt` and `frontend/package-lock.json`.

## Run it on this computer (development)

You need Python 3.12, Node.js, and PostgreSQL 17 running locally.

**1. Backend** (first PowerShell window)

```powershell
cd C:\Projects\meriba-lsms\backend
python -m venv .venv                       # first time only
.\.venv\Scripts\pip install -r requirements.txt   # first time only
copy .env.example .env                     # first time only, then edit the values
.\.venv\Scripts\python manage.py migrate
.\.venv\Scripts\python manage.py create_owner karoli --full-name "Your Name"   # first time only
.\.venv\Scripts\python manage.py runserver 127.0.0.1:8000
```

**2. Website** (second PowerShell window)

```powershell
cd C:\Projects\meriba-lsms\frontend
npm install        # first time only
npm run dev
```

**3.** Open <http://localhost:3000> and sign in with the Owner account. Follow **Setup**.

API documentation (Owner/Accountant, signed in): <http://localhost:3000/api/v1/docs/>

## Run the tests

```powershell
cd C:\Projects\meriba-lsms\backend;  .\.venv\Scripts\python -m pytest
cd C:\Projects\meriba-lsms\frontend; npm test; npm run typecheck
```

## Documents

- [Requirements checklist](docs/REQUIREMENTS_CHECKLIST.md) and [open business decisions](docs/OPEN_DECISIONS.md)
- [Architecture](docs/ARCHITECTURE.md) · [Database design](docs/DATABASE_DESIGN.md)
- [User guide](docs/USER_GUIDE.md) · [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md) · [Backup and restore](docs/BACKUP_AND_RESTORE.md)
- [Historical Excel import and review](docs/HISTORICAL_IMPORT.md)

## Rules for anyone changing this project

- Secrets live only in `backend/.env`, which Git ignores. Never commit passwords.
- The Excel workbook and the SRS are business data and are not stored in Git.
- Never edit stock balances, sales or closed days directly in the database.
- Every change to money or stock rules needs a test.
