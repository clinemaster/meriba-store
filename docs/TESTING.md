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

## Actual results — 12 Oct 2026 (third round)

| Suite | Result |
|---|---|
| Backend `pytest` | **143 passed**, 0 failed (about 2½ minutes) |
| Frontend `vitest` | **34 passed**, 0 failed |
| Frontend type check (`tsc --noEmit`) | no errors |
| Frontend production build (`next build`) | succeeded, 16 screens |
| End-to-end scripted run through the website | **44 of 44 checks passed**, including uploading the real workbook |
| Real October workbook through the importer | dry run and import both tested: 3,503 lines stored, five exceptions raised, live tables untouched, second import adds nothing |
| Backup → restore on a throwaway database (first round) | restored copy matched the original |

### Backend tests by file

| File | Covers |
|---|---|
| `test_permissions.py` | Anonymous refused everywhere; 26 back-office requests refused for a cashier sending them directly (including refunds, corrections, deliveries, expenses and every report); cashier never receives purchase cost; cashier cannot reach another cashier's sales or shift; Accountant limits; Owner user management and lock-out protection; weak passwords; sign-in errors, rate limit, CSRF |
| `test_sales.py` | AT-01 to AT-07, AT-09, AT-14; change calculation; payment validation messages; split switch; server-side price; no sale without a shift; receipt numbering; sales cannot be edited or deleted; void rules; ledger equals balance |
| `test_day_closing.py` | Go-live gate; AT-11/12/13 cash variance; tolerance; AT-SALES-01 to 04 carry-forward; skipped days; no double carry-forward; database refuses a wrong closing balance; cumulative sales separate from cash; voids reduce net sales; closed day locked; unclosed previous day; review and separation of duties; report reconciles to sales, payments and shifts |
| `test_inventory.py` | Opening stock is a count sheet: prepared by the Accountant, no stock until the Owner approves, movement reference recorded, rejection needs a note, corrections by a further sheet, every product on sale must be counted before go-live; a product cannot be on sale without a selling price; Owner must state and approve the opening balance with a cutover date; zero refused unless confirmed as a new baseline; Accountant can prepare the figure but cannot go live; adjustment with who/when/why; product rules and price-change audit; search |
| `test_backoffice.py` | AT-10 return; refund after day closure lands on the current day and the closed day is byte-for-byte unchanged; cash refund lowers expected cash; over-refund, damaged items, retry, refund vs void; a cancelled sale is deducted exactly once; AT-SALES-05 Owner correction with later days recalculated; AT-STK-01 to 04 receiving and carry-forward; expenses never touch cumulative sales, drawer cash tracked; six reports reconcile to each other and to the records; CSV export; report access |
| `test_history.py` | Dry run saves nothing; import is Owner-only and needs backup and preview confirmation; source file, worksheet, row and original text kept; empty cells stay empty; **AT-16 / AT-STK-06** an import changes no live table; **AT-17** a repeat adds nothing; missing dates listed and never filled in, affected records incomplete until explained; two "Henken" lines kept apart, Owner-only decision with identity, price type, effective date and approver; cost anomaly flagged and never auto-corrected, original preserved after the decision, decision can be reopened; product without a price kept but cannot be activated or sold; unlabelled rows preserved, proposals not applied, reasons enforced, never transactions; not reconciled until all decided and the Owner accepts, and withdrawn when something changes; supplementary workbook adds only new lines, closes the gap, flags a conflicting copy without overwriting; non-date sheet reported; lines that do not add up or cannot be read; Excel closing figure is only a reference on the count sheet; exception report; and the real workbook when present |
| `test_concurrency.py` | AT-08 two tills cannot oversell; AT-07 same request four times at once saves one sale; twelve simultaneous sales get unique receipts and exact stock; a sale racing a closing is either counted or refused |
| `test_api_docs.py` | OpenAPI schema and Swagger page; public health check |

### End-to-end run (35 checks)

Owner signs in → adds a product and a cashier → go-live refused until stock is approved → enters and approves opening
stock 48 → zero opening balance refused until confirmed as a new baseline → goes live. Cashier signs in → refused the
user list → starts the day with a 100,000 float → sells 5 (22,500, change 2,500) → same request again returns the same
sale → stock 43. Owner receives 12, refunds 1 in cash, records a 1,000 expense from the drawer → stock 56. Cashier
closes: expected cash 117,000, balanced; day net sales 18,000. No sale after closing. Reports match the closing; the
stock report shows received 12, sold 5, returned 1, closing 56, ledger check 0; CSV downloads. Owner corrects the
closed day by −500: closing becomes 17,500 with the original 18,000 kept. Audit trail holds every key event.

### Defects found by testing and fixed

0. (Third round) The first end-to-end run reported one failure. It was my check script still looking for an audit event name that this round renamed; the system was correct. The script was fixed and the whole run repeated on a fresh database: 44 of 44.
1. A negative selling price sent to the API caused a server error instead of a clear message. Now refused with a validation message.
2. Through the website address every API call was redirected in a loop, because the forwarding rule dropped the final `/`. Fixed in `frontend/next.config.mjs`. Only the end-to-end run could catch this.
3. The payment-methods report crashed (a naming clash in the database query). Fixed; now covered by two tests.

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
| Refunds, voids, reversals, corrections follow the approved rules | ✅ |
| Concurrent sales cannot corrupt stock | ✅ |
| Historical imports validated, repeatable, safe to retry | ✅ |
| Reports reconcile with underlying records | ✅ |
| Closing records locked except through an authorised correction | ✅ |
| Errors understandable, nothing sensitive exposed | ✅ |

## Not tested yet

- Nobody has clicked through the screens in a real browser, and no real cashier has tried them (AT-UX-01). The
  Refund, Receive Stock, Expenses, Reports, Setup, correction, count-sheet and Excel History screens are covered only
  by the type check, the build, and tests of the API beneath them. Only the New Sale screen has its own screen-level tests.
- The real workbook has only been imported into throwaway test databases. It has not been imported into the real
  database; that is the Owner's step.
- Refunding in cash when two cashiers have drawers open at once: the API supports choosing the drawer; the screen does not yet offer the choice.
- Printing on an actual receipt printer.
- Tablet and phone layouts on real devices; screen-reader use.
- Speed with a full product list and a busy day (the 2-second target in the SRS).
- Deployment steps on the shop's computer.
