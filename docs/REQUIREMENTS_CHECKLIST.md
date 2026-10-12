# Requirements checklist

Source: `MERIBA_Liquor_Store_Management_System_SRS_v2.3.docx` plus the Claude Code master prompt.
Last updated: 12 Oct 2026.

**Key:** ✅ built and covered by a passing automated test · 🟡 partly built · ⬜ not started · ⏸ waiting for a business decision · ➖ not applicable

## Conflicts found in the SRS and how they were resolved

| Conflict | Resolution |
|---|---|
| File is named v2.3; cover says v2.0; revision note says v2.2 | Treated as one document; the later "Clarification" and "Usability and Role-Based Access" sections win where they differ from earlier ones |
| §1.1, §5, §10 say "inspect and reuse an existing project"; the master prompt says build new | Greenfield, as the master prompt instructs. The existing `meriba` PostgreSQL database on this computer was **not touched**; this project uses a new database `meriba_lsms` |
| §2 lists five roles (Owner, Manager, Cashier, Stock Controller, Auditor); the later section and master prompt define three | Three roles. Manager and Stock Controller duties fall to Accountant/Owner. A read-only Auditor role is not built |
| §3.14 names worksheets (*Product Mapping Review*, *Historical Daily Records*) that the supplied workbook does not contain | Owner decision H1: the importer reads the daily sheets and generates both outputs itself. See [HISTORICAL_IMPORT.md](HISTORICAL_IMPORT.md) |
| "Expenses" is required by the master prompt and the role table but has no functional requirements in the SRS | Built as a dated expense record. It never feeds the cumulative sales balance; cash paid from a drawer lowers that drawer's expected cash |

## Functional requirements

### 3.1 Authentication and security
| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-SEC-01 | Sign in before protected features | ✅ | Every endpoint is closed by default |
| FR-SEC-02 | Server-side permission checks | ✅ | `tests/test_permissions.py` |
| FR-SEC-03 | Password storage, sessions, sign out, disabling accounts | ✅ | PBKDF2 hashing, HttpOnly session cookie, CSRF, login rate limit |
| FR-SEC-04 | Audit trail of sensitive actions | ✅ | Append-only `AuditLog` |
| FR-SEC-05 | No secrets in logs or screens | ✅ | Errors are plain-language; secrets only in `.env` |
| — | Self-service "forgot password" | ⬜ | Today the Owner sets a new password; the user must change it at next sign-in |

### 3.2 Branch and configuration
| ID | Status | Notes |
|---|---|---|
| FR-BR-01 Main branch, editable | ✅ | Created automatically as "MERIBA Main Branch" (code MB) |
| FR-BR-02 Scope data by branch | ✅ | Stock, sales, days carry a branch |
| FR-BR-03 More branches later | 🟡 | Data model ready; screens assume one branch |
| FR-BR-04 Currency, receipt text, timezone, tolerance | 🟡 | Stored and used. A Settings screen for the Owner is not built yet (API exists) |

### 3.3 Products and units
| ID | Status | Notes |
|---|---|---|
| FR-PROD-01 Product fields | 🟡 | Name, code, barcode, category, brand, size, unit, price, cost, active. Suppliers are linked to deliveries, not to products |
| FR-PROD-02 Search | ✅ | Name, code, barcode, category, size |
| FR-PROD-03 No merging of similar names | ✅ | Nothing is merged automatically |
| FR-PROD-04/05 Verified pack conversions; block unverified | ✅ | API only; no screen yet (decision D3: not used at go-live) |
| FR-PROD-06 Deactivate, never delete | ✅ | |

### 3.4 Point of sale
| ID | Status | Notes |
|---|---|---|
| FR-POS-01..04 Sale screen, search, stock shown, edit cart | ✅ | |
| FR-POS-05 Totals | 🟡 | Line totals and total ✅. Discounts and taxes ⏸ (Q12) |
| FR-POS-06 Pricing and overrides | 🟡 | Price always comes from the server; no overrides exist. Per-branch price table deferred until a second branch |
| FR-POS-07 No overselling | ✅ | |
| FR-POS-08 Receipt numbers, print, reprint | ✅ | Browser printing, 72 mm layout. Not yet tried on a real receipt printer |
| FR-POS-09 What a sale stores | ✅ | |
| FR-POS-10 Sale + stock commit together | ✅ | AT-09 |
| FR-POS-11 Duplicates and concurrent sales | ✅ | AT-07, AT-08 with real simultaneous requests |
| FR-POS-12 Completed sales preserved | ✅ | Void and refund workflows; nothing is deleted |

### 3.5 Payments
| ID | Status | Notes |
|---|---|---|
| FR-PAY-01 Cash, mobile money, bank, owner-configured | ✅ | Screen to add/switch methods not built (API exists) |
| FR-PAY-02 Split payment | ✅ | Can be switched off |
| FR-PAY-03/04 Due, paid, outstanding; paid only when covered | ✅ | Under-payment is refused |
| FR-PAY-05 Credit sales | ⏸ | Not built (Q12) |
| FR-PAY-06/07 Reference is not proof; payment states | ✅ | Recorded → Verified (at review) → Reversed (on void) |

### 3.6 Stock ledger
| ID | Status | Notes |
|---|---|---|
| FR-STK-01..04, 08, 09 | ✅ | Sale, void, opening, adjustment, delivery and return movements |
| FR-STK-05 Snapshots separate from movements | ✅ | Historical records live in their own tables; tests prove an import changes no live table |
| FR-STK-06 Conversions to base units | ✅ | AT-06 |
| FR-STK-07 Stock views refresh | ✅ | |
| FR-STK-10 Daily per-product balance record | 🟡 | Provided as a report worked out from the ledger for any dates (opening, received, sold, returned, adjusted, closing). Not stored as a separate table; transfers do not exist (one branch) |
| FR-STK-11 Opening stock from an authorised count | ✅ | Physical count sheet (date, counted by, unit, quantity, Excel figure for comparison only); nothing is stock until the Owner approves; go-live blocked until every product on sale has an approved count (decision H7) |
| FR-STK-12/13 Carry-forward: stock and money, kept separate | ✅ | Money: AT-SALES-01..05. Stock: AT-STK-01..03 |
| FR-STK-14 Finalise / reopen a day | 🟡 | Finalise + lock ✅. Owner correction of a closed day with reason, audit and recalculation of later days ✅. Reopening a day to add sales is not offered (refunds and corrections cover it) |
| FR-STK-15 No duplicate posting | ✅ | Database constraint + tests |
| FR-STK-16 Reports | ✅ | "Stock movement by product" and "Daily sales and cumulative balance" reports |

### 3.7 Purchasing and receiving — 🟡
Receiving a delivery (FR-PUR-02, 03, 05) ✅: deliberate confirmed step, stock movement linked to the delivery, supplier/invoice/cost optional and never invented, safe to retry. Draft purchase orders (FR-PUR-01) and matching a delivery against an order (FR-PUR-04) ⬜.
### 3.8 Low stock and reordering — 🟡
Status (In stock / Low / Out) on products and the sale screen ✅ (AT-03). Low-stock report with suggested order quantity, never negative ✅ (FR-LOW-04, 07 except last movement date). Per-branch thresholds, notifications and draft purchase orders ⬜.

### 3.9 Stock counts and adjustments
| ID | Status | Notes |
|---|---|---|
| FR-ADJ-01, 03, 04, 05 | ✅ | Count → adjustment movement with reason, user and history |
| FR-ADJ-02 Approval thresholds | ⬜ | Today: Owner/Accountant may adjust; no second approval |

### 3.10 Returns, voids, refunds
Void ✅. Refunds/returns ✅ (FR-RET-01..05): linked to the original sale and line, reason, user, time; resalable items go back to stock, damaged ones do not; cannot be processed twice or exceed what was sold; recorded on the current open day (decision D6).

### 3.11 Shifts and reconciliation
| ID | Status | Notes |
|---|---|---|
| FR-REC-01..03 Open with float; link sales; closing count | ✅ | |
| FR-REC-04 Expected cash formula | 🟡 | Float + cash sales − cash refunds − cash paid out for expenses ✅. "Authorised cash received" (cash put into the drawer mid-shift) ⬜ |
| FR-REC-05/06 Non-cash kept out of cash, checked separately | ✅ | AT-14 |
| FR-REC-07/08 Variance, tolerance, statuses | ✅ | |
| FR-REC-09/10 Not approved until payments checked; review with notes | ✅ | |
| FR-REC-11 Approved closings protected | ✅ | Locked; day figures corrected only through the Owner's audited correction |
| FR-REC-12 Separation of duties | ✅ | Cannot approve your own shift |
| FR-REC-13 Reports | 🟡 | Closing report by date with CSV export ✅. Filters by cashier/status on the report ⬜ |

### 3.12 Reports — 🟡
Eleven reports, each with date filters where relevant and CSV export: daily sales and cumulative balance, sales by product, sales by cashier, payment methods, daily closing and cash reconciliation, stock on hand (with value at cost where a cost exists), low stock, stock movement by product, stock received, expenses, and a sales/purchases/expenses summary. All Owner/Accountant only. ⬜ Sales by category, fast/slow movers, a profit report (purchase costs are not yet reliable enough), filters by product/cashier within a report.

### 3.13 Audit — 🟡
Recording ✅ (FR-AUD-01..04) and API ✅. Audit history screen ⬜.

### 3.14 Excel import — ✅ built; the real import and its review are waiting for the Owner

| ID | Status | Notes |
|---|---|---|
| FR-IMP-01 Inspect all worksheets, document column mapping | ✅ | [HISTORICAL_IMPORT.md](HISTORICAL_IMPORT.md) |
| FR-IMP-02 Product Mapping Review and Historical Daily Records as structured sources | ✅ | Generated from the daily sheets (decision H1) |
| FR-IMP-03 Import into MERIBA Main Branch | ➖ | Historical records are reference data and are not attached to live branch stock; no branch is ever created from a sheet |
| FR-IMP-04 Dry run, preview, validation, errors, reconciliation totals | ✅ | |
| FR-IMP-05 Preserve worksheet, identifiers, dates, values | ✅ | File, worksheet, row and original cell text on every record |
| FR-IMP-06 Idempotent retries with stable source keys | ✅ | AT-17 |
| FR-IMP-07 Flag ambiguous names, units, conversions, missing fields, duplicates | ✅ | Flags on the mapping review; exceptions for the material ones |
| FR-IMP-08 Fabricate nothing | ✅ | No sales, receipts, suppliers, customers, payment methods, prices or opening stock are created by an import |
| FR-IMP-09 Never sum or replay snapshots as live movements | ✅ | AT-16, AT-STK-06 |
| FR-IMP-10 Backup before import; transactions | 🟡 | Import runs in one transaction. The Owner must confirm a backup was taken; the system cannot verify it |
| FR-IMP-11 No reset, delete or overwrite | ✅ | Stored records are never overwritten; a differing copy is flagged instead |
| FR-IMP-12 Verify imported counts against workbook totals | ✅ | Stored count checked against lines read; total sales reported from the file |
| Review workflow: statuses, permissions, explanations with evidence, approved prices by type, reopen, exception report, acceptance | ✅ | Owner policy H2–H8 |
| Mandatory confirmations: identity, package size, price type and effective date before a same-name or price question can be closed | ✅ | Confirmed policy, 12 Oct 2026 |
| Exception report available from the dry run, before committing | ✅ | |
| Unlabelled rows: reviewer and full decision history | ✅ | |
| Go-live blocked while a product identity or price question is open; not blocked by the rest of the review | ✅ | Interpretation I8 in OPEN_DECISIONS |
The October workbook has been run through a dry run (3,503 lines, five material exceptions) but **not imported into the real database**: that is the Owner's step. Per decision D7 the history is kept separate from the live opening balance.

## Cumulative monetary sales balance (SRS clarification, master prompt §7)
| Requirement | Status |
|---|---|
| Closing = opening + net sales (enforced by a database rule as well as code) | ✅ |
| Next day opens with the last finalised closing balance | ✅ |
| Days with no trading are skipped, not zeroed | ✅ |
| A closing balance cannot be carried forward twice | ✅ |
| Kept separate from cash, float, variance and stock | ✅ |
| Finalised days locked against edits | ✅ |
| Authorised correction of a finalised day with recalculation (AT-SALES-05) | ✅ |
| Opening balance must be entered and approved by the Owner with a cutover date; zero only as a confirmed new baseline (D7) | ✅ |
| Refunds recorded on the current day; closed days untouched (D6) | ✅ |

## Usability section
| Requirement | Status |
|---|---|
| Role home screens; only permitted menus | ✅ |
| Plain-language labels and errors; TZS formatting | ✅ |
| Confirm important actions (close day, cancel sale, price change, stock change, role change, go live) | ✅ |
| Duplicate-click protection; cart kept after an error | ✅ |
| Guided first-time setup | ✅ |
| Keyboard use, labels, visible focus, not colour-only | 🟡 Built in; not yet checked by a real cashier or with a screen reader |
| In-app help section | ⬜ |
| Tablet/phone layout | 🟡 Responsive layout built; only checked by build, not on a device |

## SRS acceptance tests
| Test | Status | Where |
|---|---|---|
| AT-01..09 | ✅ | `test_sales.py`, `test_concurrency.py` |
| AT-10 Return | ✅ | `test_backoffice.py` |
| AT-11..14 | ✅ | `test_day_closing.py`, `test_sales.py` |
| AT-15 Credit sale | ⏸ | |
| AT-16, AT-17 Import | ✅ | `test_history.py`, including the real workbook |
| AT-18 Permissions | ✅ | `test_permissions.py` |
| AT-STK-01..03 (100 + 20 − 45 = 75 …) | ✅ | `test_backoffice.py` |
| AT-STK-04 | ✅ | Sale and delivery retries |
| AT-STK-05 | 🟡 | Money side ✅ (correction audited, later days recalculated). Stock side: ledger check in the stock report ✅; no "finalised stock day" to correct |
| AT-STK-06 | ✅ | `test_history.py` |
| AT-SALES-01..04 | ✅ | |
| AT-SALES-05 | ✅ | `test_backoffice.py` |
| AT-UX-01 | 🟡 | Needs a trial with a real first-time user |
| AT-UX-02..07 | ✅ | |

## Phase status (master prompt §16)
| Phase | Status |
|---|---|
| 1 Requirements and architecture | ✅ |
| 2 Project foundation | ✅ |
| 3 Authentication and roles | ✅ |
| 4 Products and inventory core | ✅ |
| 5 Cashier sales workflow | ✅ |
| 6 Daily closing and cumulative balance | ✅ |
| 7 Accountant and Owner functions | 🟡 users, refunds, receiving, expenses, reports ✅; purchase orders, settings screen, payment-method screen, audit-history screen ⬜ (their APIs exist) |
| 8 Historical data migration | 🟡 importer and review screens ✅; the Owner's import and decisions outstanding |
| 9 UI refinement and testing | ⬜ |
| 10 Deployment preparation | 🟡 documented; not yet rehearsed on the shop computer |
