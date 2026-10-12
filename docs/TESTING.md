# Testing

## Strategy

| Layer | Tool | What it proves |
|---|---|---|
| Backend rules and permissions | pytest + pytest-django against **real PostgreSQL** | Money, stock, closing and role rules, through the same HTTP API the website uses |
| Simultaneous requests | pytest with real threads and separate database connections | No overselling, no duplicate sale, no clash between a sale and a closing |
| Website logic | Vitest | Money maths in whole cents; which role sees which menu and page |
| Website critical screen | Vitest + Testing Library | New Sale: totals, stock limit, change, double-click, retry after a lost connection |
| Whole system, in a real browser | Playwright driving Chromium through the real screens, against a throwaway database | A person can actually do the job: the screens, buttons, forms and messages work together with the backend |

Tests use their own database (`test_meriba_lsms`), created automatically. They never touch real data.

## How to run

```powershell
cd C:\Projects\meriba-lsms\backend;  .\.venv\Scripts\python -m pytest
cd C:\Projects\meriba-lsms\frontend; npm test; npm run typecheck; npm run build

# Browser tests: creates a throwaway database, starts test copies of both programs, runs the tests, removes everything again.
# Safe to run while the shop system is running: it uses its own ports (3100, 8100), database and build folder.
# First time only: npx playwright install chromium
cd C:\Projects\meriba-lsms; powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
# Add  -Workbook "C:\full\path\to\the workbook.xlsx"  to include the test that previews the real Excel file.
```

## Actual results — 12 Oct 2026 (sixth round)

| Suite | Result |
|---|---|
| Backend `pytest` | **147 passed**, 0 failed (about 4½ minutes) |
| Frontend `vitest` | **37 passed**, 0 failed |
| Frontend type check (`tsc --noEmit`) | no errors |
| Frontend production build (`next build`) | succeeded, 19 screens |
| **Browser tests (Playwright, Chromium)** | **12 passed**, 0 failed (about 40 seconds), on four consecutive runs. Backend and unit suites were last run in the fifth round; this round changed only screens and tests |
| Earlier scripted run through the website address (no browser) | 44 of 44 checks in the third round. Superseded by the browser tests |
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
| `test_history.py` | Dry run saves nothing; import is Owner-only and needs backup and preview confirmation; source file, worksheet, row and original text kept; empty cells stay empty; **AT-16 / AT-STK-06** an import changes no live table; **AT-17** a repeat adds nothing; missing dates listed and never filled in, affected records incomplete until explained; two "Henken" lines kept apart, Owner-only decision with identity, price type, effective date and approver; cost anomaly flagged and never auto-corrected, original preserved after the decision, decision can be reopened; product without a price kept but cannot be activated or sold; unlabelled rows preserved, proposals not applied, reasons enforced, never transactions; not reconciled until all decided and the Owner accepts, and withdrawn when something changes; supplementary workbook adds only new lines, closes the gap, flags a conflicting copy without overwriting; non-date sheet reported; lines that do not add up or cannot be read; Excel closing figure is only a reference on the count sheet; exception report; and the real workbook when present. **Confirmed policy:** a same-name question cannot be closed without name, package size, price, price type and effective date for each line; a price anomaly cannot be closed without the price type and applicable amount, even when confirmed correct; a missing price cannot be approved without name and unit or size; unlabelled rows show reviewer and full decision history; the exception report downloads from the dry run with nothing saved; go-live is blocked by open price questions but not by the rest of the review, and going live leaves the history not reconciled; the four statuses are distinct |
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

### Browser tests (`frontend/e2e/`)

Two files run in order and share one throwaway database.

**`01-trading-day.spec.ts`** — one trading day through the real screens:

1. A wrong password is refused in plain words; a visitor who is not signed in is sent to the sign-in page.
2. **Owner sets up and goes live:** adds two products (typing key by key), is refused a product on sale without a
   price, adds a cashier, fills the physical count sheet, approves it, and goes live. The go-live button stays
   disabled until TZS 0 is confirmed as a new baseline.
3. **Cashier:** is made to choose their own password; sees only Home, New Sale, Today's Sales, Close Day; typing the
   address of the Users page shows "not available"; starts the day with a float; makes a cash sale with change and a
   sale split between cash and mobile money (blocked while money is still owed); sees stock go down; makes a third
   sale; can open a receipt but has no cancel or refund buttons.
4. **Owner during the day:** receives a delivery; opens a till of their own so two drawers are open; refunds one item
   in cash and is made to choose which drawer; cancels the third sale (refused without a reason); closes their own
   till; records an expense paid from the cashier's drawer; adjusts stock for a broken crate (refused without a
   reason); changes a product's price; adds a user (weak password refused) and switches the account off.
   Stock shows 48 − 3 + 1 cancelled + 24 + 1 returned = 71.
5. **Cashier closes:** expected cash 109,500 (float + cash sales − refund − expense); a shortage blocks closing until
   a note is written; closes balanced; closing cumulative sales 40,500; no sale possible afterwards.
6. **Owner afterwards:** cannot approve the shift until the mobile money total is ticked, then approves; reads the
   daily sales and stock reports and downloads one; finds the events in the audit history; changes a setting; opens
   Help; records a formal correction of the closed day and sees the new closing balance, 40,000.
7. **Excel preview:** uploads the real workbook, sees 3,503 lines, the missing September dates and Henken; the import
   button stays disabled; after reloading, nothing has been stored.

**`02-excel-history.spec.ts`** — the whole historical review, on a small made-up workbook carrying every exception:

8. **Import:** checks the file, downloads the preview as an exception report, is held back until both boxes are
   ticked, imports 24 lines; the screen says NOT RECONCILED and shows 4 exceptions, 6 mappings, 8 unlabelled rows.
9. **Exceptions:** the same-name question is refused on a note alone, then without effective dates, and accepted only
   with name, size, price, type and date for both lines; an explanation with evidence is added to the missing dates,
   which are then accepted as incomplete; the price anomaly is refused as "correct" until the price type and amount
   are confirmed; the missing price is closed as not sold; decided items stay on record with a Reopen button.
10. **Product mapping:** approval is refused until the unit is stated; two names are linked to existing products;
    mkwawa is created without a price and shows "not on sale"; the rest are kept as history only, which needs a note.
11. **Unlabelled rows:** original values shown per sheet; one row number classified, one excluded (refused without a
    reason); reviewer and decision history shown.
12. **Acceptance:** the Owner accepts with a note and the screen changes to "Accepted as reconciled"; lines accepted
    without explanation still show as Incomplete; live stock is unchanged and mkwawa is switched off with no price.

### Defects found by testing and fixed

000. **Sixth round (extending the browser tests):**
     - **In Excel History, a line just decided stayed on the list for a moment after its window closed**, so it could be
       picked a second time. With two lines both called "Henken" this led to the same one being decided twice and the
       other left behind. The list is now refreshed before the window closes. (Found as an intermittent test failure.)
     - Two faults in the tests themselves, not the system: signing in for every test tripped the system's own limit of
       ten sign-in attempts a minute on fast runs, which the system correctly refused; and the script needed the shop
       system's ports, so it could not run while you were using the system. Tests now reuse one sign-in, and the
       script uses its own ports, database and build folder.

00. **Found by the browser tests (fifth round), all fixed:**
    - **The receipt window on the Sales screen could not be closed**, and **the "Correct…" button and status column were missing from the balance history**. Both came from a faulty automated edit I made in an earlier round; the type check and the other tests did not notice. Both are now exercised by the browser tests.
    - **In every pop-up window, the cursor jumped out of the box after each key typed** when the form belonged to the screen behind it (products, users, closing review, corrections). Tests that fill a box in one go did not show it; the browser test now types key by key.
    - **When the Owner ran the browser tests (12 Oct), test 6 failed at the Reports step.** The fault was in the test, not the system: it checked "the table" straight after pressing Reports, while the Daily Closing screen (which has two tables) was still on display for an instant. It had passed on my runs only by timing. The test now waits for each screen's heading before checking it and names the row it means. Run three times in a row afterwards: 7 of 7 each time.
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

- **No real cashier has tried the system** (AT-UX-01). The browser tests show the screens work; they cannot show
  whether a first-time user finds them clear.
- Still **not** exercised in a browser: anything as the **Accountant** (the browser tests sign in only as Owner and
  Cashier; the Accountant's limits are covered by API tests); rejecting a count sheet; reopening a decision; a
  supplementary workbook; switching a payment method off; printing. Treat these as unproven on screen.
- The real workbook has only been imported into throwaway test databases. It has not been imported into the real
  database; that is the Owner's step.
- Refunding in cash when two cashiers have drawers open at once: the API supports choosing the drawer; the screen does not yet offer the choice.
- Printing on an actual receipt printer.
- Tablet and phone layouts on real devices; screen-reader use.
- Speed with a full product list and a busy day (the 2-second target in the SRS).
- Deployment steps on the shop's computer.
