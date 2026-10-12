# Testing

## Strategy

| Layer | Tool | What it proves |
|---|---|---|
| Backend rules and permissions | pytest + pytest-django against **real PostgreSQL** | Money, stock, closing and role rules, through the same HTTP API the website uses |
| Simultaneous requests | pytest with real threads and separate database connections | No overselling, no duplicate sale, no clash between a sale and a closing |
| Website logic | Vitest | Money maths in whole cents; which role sees which menu and page |
| Website critical screen | Vitest + Testing Library | New Sale: totals, stock limit, change, double-click, retry after a lost connection |
| Whole system | Scripted run through the website address (Next.js → Django → PostgreSQL) | The pieces work together: cookies, CSRF, proxying |

Tests use their own database (`test_meriba_lsms`), created automatically. They never touch real data.

## How to run

```powershell
cd C:\Projects\meriba-lsms\backend;  .\.venv\Scripts\python -m pytest
cd C:\Projects\meriba-lsms\frontend; npm test; npm run typecheck; npm run build
```

## Actual results — 12 Oct 2026

| Suite | Result |
|---|---|
| Backend `pytest` | **92 passed**, 0 failed (about 90 s) |
| Frontend `vitest` | **30 passed**, 0 failed |
| Frontend type check (`tsc --noEmit`) | no errors |
| Frontend production build (`next build`) | succeeded, 13 pages |
| End-to-end scripted run | 24 of 25 checks passed; the 25th was a mistake in the check script, not the system (see below) |
| Backup → restore on a throwaway database | restored copy matched the original |

### Backend tests by file

| File | Covers |
|---|---|
| `test_permissions.py` | Anonymous refused everywhere; 17 back-office requests refused for a cashier sending them directly; cashier never receives purchase cost; cashier cannot reach another cashier's sales or shift; Accountant limits; Owner user management and lock-out protection; weak passwords; sign-in errors, rate limit, CSRF |
| `test_sales.py` | AT-01 to AT-07, AT-09, AT-14; change calculation; payment validation messages; split switch; server-side price; no sale without a shift; receipt numbering; sales cannot be edited or deleted; void rules; ledger equals balance |
| `test_day_closing.py` | Go-live gate; AT-11/12/13 cash variance; tolerance; AT-SALES-01 to 04 carry-forward; skipped days; no double carry-forward; database refuses a wrong closing balance; cumulative sales separate from cash; voids reduce net sales; closed day locked; unclosed previous day; review and separation of duties; report reconciles to sales, payments and shifts |
| `test_inventory.py` | Opening stock once, before go-live, safe to retry; guided setup gate; adjustment with who/when/why; product rules and price-change audit; search |
| `test_concurrency.py` | AT-08 two tills cannot oversell; AT-07 same request four times at once saves one sale; twelve simultaneous sales get unique receipts and exact stock; a sale racing a closing is either counted or refused |
| `test_api_docs.py` | OpenAPI schema and Swagger page; public health check |

### Defects found by testing and fixed

1. A negative selling price sent to the API caused a server error instead of a clear message. Now refused with a validation message.
2. Through the website address every API call was redirected in a loop, because the forwarding rule dropped the final `/`. Fixed in `frontend/next.config.mjs`. Only the end-to-end run could catch this; the unit tests could not.

### The one failed end-to-end check

"API documentation page is served" failed because the check script asked for JSON from an HTML page.
The page itself works and is now covered by `test_api_docs.py`.

## Master prompt §15 minimum list

| Required test | Status |
|---|---|
| Each user can access only permitted features | ✅ |
| Cashier cannot bypass restrictions by direct API request | ✅ |
| Line totals and grand total | ✅ backend and website |
| Sale deducts the correct stock | ✅ |
| Repeated request: no duplicate sale or stock movement | ✅ sequential and simultaneous |
| Completed sale not silently editable or deletable | ✅ |
| Opening + net sales = closing cumulative balance | ✅ |
| Next day's opening = previous finalised closing | ✅ |
| Cash reconciliation separate from cumulative balance | ✅ |
| Refunds, voids, reversals, corrections | 🟡 voids ✅; refunds and day corrections not built |
| Concurrent sales cannot corrupt stock | ✅ |
| Historical imports validated, repeatable, safe to retry | ⬜ importer not built |
| Reports reconcile with underlying records | 🟡 day closing ✅; other reports not built |
| Closing records locked after finalisation | ✅ (authorised correction workflow not built) |
| Errors understandable, nothing sensitive exposed | ✅ |

## Not tested yet

- Nobody has used the screens in a real browser by hand, and no real cashier has tried them (AT-UX-01).
- Printing on an actual receipt printer.
- Tablet and phone layouts on real devices; screen-reader use.
- Speed with a full product list and a busy day (the 2-second target in the SRS).
- Deployment steps on the shop's computer.
