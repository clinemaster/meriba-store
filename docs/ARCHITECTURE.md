# Architecture

## The picture

```
 Browser (cashier / accountant / owner)
        │  one address only, e.g. http://localhost:3000
        ▼
 Next.js website  ──  /api/*  passed on  ──►  Django REST API  ──►  PostgreSQL
 (screens only,                               (all rules, all                (the records)
  no business rules)                           permission checks)
```

- **The website holds no business rules.** It shows screens and sends requests. Prices, totals, stock checks
  and permissions are always decided by the backend.
- **The browser talks to one address.** Next.js forwards `/api/*` to Django. That keeps the sign-in cookie
  first-party and HttpOnly (JavaScript cannot read it) and avoids cross-site requests.
- **PostgreSQL is the last line of defence.** Key rules are database constraints, so even a programming
  mistake cannot store a negative stock balance or a closing balance that does not add up.

## Folders

```
backend/
  config/      settings, URL list, WSGI entry point
  core/        branch, shop settings, audit log, error messages, request logging, setup/go-live
  accounts/    users, roles, sign-in, user management, permission classes
  catalog/     categories, products, extra selling units
  inventory/   stock balances, the stock ledger, opening stock, adjustments
  trading/     business days, cashier shifts, cash count, cumulative sales balance
  sales/       payment methods, sales, sale lines, payments, void, refunds
  finance/     suppliers, deliveries (receiving stock), expenses
  reports/     the eleven reports and CSV export
  tests/       automated tests (run against real PostgreSQL)
frontend/
  src/app/         one folder per screen (login, sale, sales, day/start, day/close, closing, products, stock, receive, expenses, reports, users, setup)
  src/components/  shared pieces (page frame + menu, buttons, messages, receipt)
  src/lib/         API helper, money maths, sign-in state, menu rules, types
docs/
```

Each backend app has `models.py` (tables), `services.py` (the rules) and `views.py` (the API). Views stay thin:
they check permission and input, then call a service.

## Key design decisions

| Decision | Why |
|---|---|
| **Session cookie sign-in, not tokens in the browser** | HttpOnly cookies cannot be stolen by a script; Django's CSRF protection covers forms. Simple and well-proven |
| **Deny by default** | An endpoint with no explicit permission is closed to everyone. A forgotten check fails safe |
| **One service owns stock** (`inventory.services.post_movement`) | FR-STK-02. It locks the product's balance row, refuses to go below zero, writes the ledger line and updates the balance in one transaction |
| **Sale = one database transaction** | Sale, lines, payments, stock movements and audit record all commit or none do (BR-01) |
| **Request key on every sale and stock count** | The screen creates a random key per sale. The database allows each key once, so a double-click or retry returns the first sale instead of making a second (BR-02) |
| **Locking order: business day → products in id order** | Two tills selling at once take turns instead of deadlocking; receipt numbers stay sequential; a sale and a closing can never overlap |
| **Append-only ledgers** | Stock movements, sale lines and audit records cannot be edited or deleted through the application. Corrections are new records |
| **Cumulative sales balance stored per business day** | `closing = opening + net sales` is checked by the database. Each day points to the day it carried forward from, one-to-one, so a balance cannot be carried twice |
| **Money is `Decimal`, never floating point** | Backend uses `Decimal(…, 2)`; the website does its sums in whole cents |
| **Business date, not clock date** | A sale belongs to the open business day, even after midnight. The date is taken in the shop's time zone when the day is opened |
| **Go-live gate** | No day can be started until the Owner has completed setup and confirmed the opening figures |

## Rounding policy

All money is stored with 2 decimal places and rounded half-up. Line total = quantity × unit price, rounded.
Sale total = sum of line totals. In practice TZS prices are whole shillings, so no rounding occurs.

## Security summary

- Passwords: Django PBKDF2-SHA256 hashing; minimum 8 characters; common and numeric-only passwords refused.
- Sign-in endpoint: CSRF-protected and rate-limited (10 attempts per minute per address). Same error for
  unknown user and wrong password.
- Sessions last 12 hours. Changing your password keeps you signed in but invalidates other sessions.
- Production adds: HTTPS-only cookies, HSTS, SSL redirect (see DEPLOYMENT.md).
- Headers: `X-Frame-Options: DENY`, `nosniff`, same-origin referrer.
- Cashier responses never contain purchase cost; cashiers can only reach their own sales and shifts (other
  records answer "not found").
- Errors shown to users never include stack traces. Details go to `backend/logs/app.log` with a request id.

## Logging

`backend/logs/app.log` (rotating, 5 × 5 MB) and the console. Each line has time, level, request id and user.
Business events are in the audit log table, not the log file.

## API

Versioned under `/api/v1/`. OpenAPI schema at `/api/v1/schema/`, Swagger page at `/api/v1/docs/`
(Owner/Accountant only; the Swagger page loads its script from the internet).

| Area | Endpoints |
|---|---|
| Sign-in | `auth/csrf`, `auth/login`, `auth/logout`, `auth/me`, `auth/change-password` |
| Users (Owner) | `users/`, `users/{id}/`, `users/{id}/reset-password/` |
| Setup | `settings/`, `setup/status/`, `setup/go-live/` |
| Products | `categories/`, `products/`, `products/{id}/units/`, `…/units/{id}/verify/` |
| Stock | `stock/opening/`, `stock/opening/confirm/`, `stock/adjustments/`, `stock/movements/` |
| Day | `day/current/`, `day/start/`, `days/`, `shifts/`, `shifts/{id}/`, `shifts/{id}/close/`, `shifts/{id}/review/` |
| Sales | `payment-methods/`, `sales/`, `sales/{id}/`, `sales/{id}/void/` |
| Refunds and corrections | `sales/{id}/refund/`, `refunds/`, `days/{id}/corrections/` |
| Purchasing and expenses | `suppliers/`, `stock/receipts/`, `expenses/`, `expenses/{id}/void/`, `expenses/categories/` |
| Reports | `reports/`, `reports/{name}/` (add `?download=csv` for a file) |
| Setup | `setup/opening-balance/` (prepare), `setup/go-live/` (Owner approval) |
| Other | `audit-log/`, `health/` |

## Permission matrix (as built)

| Action | Cashier | Accountant | Owner |
|---|---|---|---|
| Start day, sell, close own shift, see own sales | ✔ | ✔ | ✔ |
| See product cost, other people's sales, stock movements, audit log | ✘ | ✔ | ✔ |
| Add/edit products and prices, stock adjustments, receive deliveries | ✘ | ✔ | ✔ |
| Cancel a sale, refund, close someone else's shift, review a shift (not own) | ✘ | ✔ | ✔ |
| Expenses, all reports and exports | ✘ | ✔ | ✔ |
| Prepare the opening stock count and the opening balance figure | ✘ | ✔ | ✔ |
| **Approve** opening stock, **approve** the opening balance, go live | ✘ | ✘ | ✔ |
| Correct a closed day | ✘ | ✘ | ✔ |
| Users, settings, payment methods, verify pack sizes | ✘ | ✘ | ✔ |
