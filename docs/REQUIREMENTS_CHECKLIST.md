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
| §3.14 names worksheets that the supplied workbook does not contain | Recorded as question X1 in [OPEN_DECISIONS.md](OPEN_DECISIONS.md); nothing imported |
| "Expenses" is required by the master prompt and the role table but has no functional requirements in the SRS | Will be built as a simple dated expense record (Phase 7); it will not feed the cumulative sales balance |

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
| FR-PROD-01 Product fields | 🟡 | Name, code, barcode, category, brand, size, unit, price, cost, active. Supplier link comes with purchasing |
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
| FR-POS-12 Completed sales preserved | 🟡 | Void ✅. Returns/refunds ⬜ |

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
| FR-STK-01..04, 08, 09 | 🟡 | Sale, void, opening, adjustment movements ✅. Purchase receipts and returns ⬜ |
| FR-STK-05 Snapshots separate from movements | ➖ | No snapshot import yet |
| FR-STK-06 Conversions to base units | ✅ | AT-06 |
| FR-STK-07 Stock views refresh | ✅ | |
| FR-STK-10 Daily per-product balance record | ⬜ | Ledger has every movement with business date; the daily summary table/report is Phase 6b |
| FR-STK-11 Opening stock from an authorised count | ✅ | Owner only, before go-live, once per product |
| FR-STK-12/13 Carry-forward: stock and money, kept separate | 🟡 | Money ✅ (AT-SALES-01..04). Stock carries forward naturally as a running balance; per-day report ⬜ |
| FR-STK-14 Finalise / reopen a day | 🟡 | Finalise + lock ✅. Reopen with recalculation ⬜ |
| FR-STK-15 No duplicate posting | ✅ | Database constraint + tests |
| FR-STK-16 Reports | 🟡 | Cumulative sales balance history ✅. Per-product inventory report ⬜ |

### 3.7 Purchasing and receiving — ⬜ (Phase 7)
### 3.8 Low stock and reordering — 🟡
Status (In stock / Low / Out) shown on products and the sale screen ✅ (AT-03). Reorder suggestions, alerts list, draft orders ⬜.

### 3.9 Stock counts and adjustments
| ID | Status | Notes |
|---|---|---|
| FR-ADJ-01, 03, 04, 05 | ✅ | Count → adjustment movement with reason, user and history |
| FR-ADJ-02 Approval thresholds | ⬜ | Today: Owner/Accountant may adjust; no second approval |

### 3.10 Returns, voids, refunds
Void (cancel a sale the same shift) ✅ with reason, stock restored once, audit. Returns/refunds for earlier days ⬜ (Q3).

### 3.11 Shifts and reconciliation
| ID | Status | Notes |
|---|---|---|
| FR-REC-01..03 Open with float; link sales; closing count | ✅ | |
| FR-REC-04 Expected cash formula | 🟡 | Float + cash sales ✅ (AT-11..13). Cash refunds, cash in/out ⬜ |
| FR-REC-05/06 Non-cash kept out of cash, checked separately | ✅ | AT-14 |
| FR-REC-07/08 Variance, tolerance, statuses | ✅ | |
| FR-REC-09/10 Not approved until payments checked; review with notes | ✅ | |
| FR-REC-11 Approved closings protected | 🟡 | Locked ✅. Correction workflow ⬜ |
| FR-REC-12 Separation of duties | ✅ | Cannot approve your own shift |
| FR-REC-13 Reports | 🟡 | Shift list on screen; filters and export ⬜ |

### 3.12 Reports — 🟡
On screen today: day's sales list, shift list, cumulative balance history, latest stock movements. ⬜ Sales by product/cashier/date range, payment summary, stock on hand report, low stock, valuation, fast/slow movers, CSV/Excel export.

### 3.13 Audit — 🟡
Recording ✅ (FR-AUD-01..04) and API ✅. Audit history screen ⬜.

### 3.14 Excel import — ⬜ (Phase 8, blocked on X1–X9)
Workbook has been inspected read-only; findings are in [OPEN_DECISIONS.md](OPEN_DECISIONS.md).

## Cumulative monetary sales balance (SRS clarification, master prompt §7)
| Requirement | Status |
|---|---|
| Closing = opening + net sales (enforced by a database rule as well as code) | ✅ |
| Next day opens with the last finalised closing balance | ✅ |
| Days with no trading are skipped, not zeroed | ✅ |
| A closing balance cannot be carried forward twice | ✅ |
| Kept separate from cash, float, variance and stock | ✅ |
| Finalised days locked against edits | ✅ |
| Authorised correction of a finalised day with recalculation (AT-SALES-05) | ⬜ |

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
| AT-10 Return | ⬜ | |
| AT-11..14 | ✅ | `test_day_closing.py`, `test_sales.py` |
| AT-15 Credit sale | ⏸ | |
| AT-16, AT-17 Import | ⬜ | |
| AT-18 Permissions | ✅ | `test_permissions.py` |
| AT-STK-01..03 (100 + 20 − 45 = 75 …) | ⬜ | Needs stock receiving |
| AT-STK-04 | 🟡 | Sale side ✅; receipt side ⬜ |
| AT-STK-05, AT-STK-06 | ⬜ | |
| AT-SALES-01..04 | ✅ | |
| AT-SALES-05 | ⬜ | |
| AT-UX-01 | 🟡 | Needs a trial with a real first-time user |
| AT-UX-02..07 | ✅ | |

## Phase status (master prompt §16)
| Phase | Status |
|---|---|
| 1 Requirements and architecture | ✅ |
| 2 Project foundation | ✅ |
| 3 Authentication and roles | ✅ |
| 4 Products and inventory core | 🟡 receiving, daily stock report outstanding |
| 5 Cashier sales workflow | ✅ |
| 6 Daily closing and cumulative balance | 🟡 reopen/correction outstanding |
| 7 Accountant and Owner functions | 🟡 users ✅; purchases, expenses, reports, settings screen, audit screen ⬜ |
| 8 Historical data migration | ⬜ |
| 9 UI refinement and testing | ⬜ |
| 10 Deployment preparation | 🟡 documented; not yet rehearsed on the shop computer |
