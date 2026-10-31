# Payment methods, providers and reconciliation

Added 30 Oct 2026. Payment categories (Cash, Mobile Money, Bank, …) and their providers (M-PESA, Mixx by Yas,
Airtel Money, NMB, CRDB, NBC, …) are configured by the Owner on **Settings → Payment methods**, with no code change.
Every payment records its category and, where the category needs one, its provider. The **Payments** page, the
**Payment analysis** reports, Close Day and Daily Closing all use one set of definitions (`backend/sales/reconciliation.py`).

## How it fits the existing system

Nothing was rebuilt. The existing tables were extended:

| Brief's name | Table in this system | What changed |
|---|---|---|
| PaymentCategory | `sales.PaymentMethod` | `description`, `icon`, `requires_provider`, `created_at`, `updated_at`. `code` stays the permanent identifier |
| PaymentProvider | `sales.PaymentProvider` (new) | category, code, name, normalised name key, description, order, on/off, timestamps |
| SalePayment | `sales.Payment` | `provider` (blank on old payments), `provider_name` (name as it was when paid), `recorded_by`, `created_at` (payment date), `updated_at` |
| — | `sales.Refund` | `provider`, `provider_name` |
| Closing snapshot | `trading.BusinessDay.payment_snapshot`, `trading.ShiftPaymentTotal.provider_breakdown` | frozen at closing, never rewritten |

Rules held by the database or the server:

- Money is `NUMERIC(16,2)` everywhere; no floating point.
- A category or provider used by any payment, refund, expense or closing is never deleted (`PROTECT` foreign keys, and the API answers 409). Unused ones can be deleted; it is audited.
- Provider names are unique within a category, ignoring case, spaces and punctuation (`M-PESA` = `m pesa`).
- Cash cannot require a provider (check constraint). A provider cannot be moved to another category.
- At least one category, and at least one provider of an active category that requires providers, stays switched on.
- Renaming or switching off a provider never changes old receipts (they print `provider_name`) and old payments stay in every total.

## Selling

The sale window on the Daily Sheet loads the switched-on categories and their switched-on providers each time it opens,
so an Owner's change reaches the till without reinstalling anything. Cash needs no provider. Mobile Money and Bank show
their providers and cannot be saved without one. **More than one method** lets the cashier add payment lines
(e.g. Cash 20,000 + M-PESA 20,000 + NMB 10,000). The server checks everything again: active category and provider,
provider belongs to the category, the same category + provider not twice, no negative amounts, the total covered
(only cash can be over-paid; change is taken once from cash). An under-paid sale is refused, never saved as completed.
Repeated clicks or retries carry the same request key and save one sale only.

## Definitions (one place: `sales/reconciliation.py`)

Dates are business days. A sale's payments belong to the sale's business day; a refund belongs to the day it is paid.

| Figure | Formula |
|---|---|
| Gross sales | every sale of the period at full value |
| Cancellations | sales of the period later cancelled (their payments become *Reversed* and leave the collections) |
| Refunds | refunds paid in the period, for sales of any day |
| Corrections | the Owner's audited corrections to closed days |
| **Net sales** | gross − discounts − cancellations − refunds + corrections (decision D5, as Daily Closing) |
| **Payments collected** | payments of the period's sales that were not cancelled |
| Category total | sum of its provider lines (including *Provider not recorded*) |
| **Net collections** | payments collected − refunds paid |
| **Outstanding receivables** | completed sales − payments on them. Credit sales are not enabled (FR-PAY-05), so this is 0 |
| Expected collections | net sales − corrections − outstanding receivables |
| **Reconciliation difference** | net collections − expected collections; 0 when consistent |

A sale counts once in "Sales" however many methods paid for it; each payment line counts once in its category and provider.

## Screens

| Where | Who | What |
|---|---|---|
| Money & Reports → **Payments** (`/payments`) | Owner, Accountant | Net sales, collected, Cash, Mobile Money, Bank, outstanding credit, refunds, reconciliation difference; every category with its providers; trend by day/week/month (chart and table). Filters: period, cashier, branch |
| Selling → **My Payments** (same page) | Cashier | The same, for their own payments only (enforced by the server) |
| **Payment transactions** (`/payments/transactions`) | everyone (cashier: own) | Opened from any card. Search, sort, pages, date/category/provider/cashier/branch/status filters, column choice, Excel and CSV downloads of every matching row. The total shown equals the card it came from. Owner/Accountant: *Record provider…* for old payments and *Correct provider…* while the shift is open |
| Settings → **Payment methods** (`/settings/payment-methods`) | Owner changes; Accountant reads | Add/edit/switch on/off/delete-if-unused categories and providers, icons, drag-and-drop or ↑↓ order, search, change history |
| **Close Day** | cashier | Totals per category and per provider; *I have checked the payment breakdown* must be ticked (the server refuses a close without it) |
| **Daily Closing** | Owner, Accountant | The open day's reconciliation and provider breakdown; provider lines in each shift review |
| **Reports → Payment analysis** | Owner, Accountant | Daily / weekly / monthly payment reconciliation, payments by category and provider, payments by cashier. Excel, CSV, and Print / Save as PDF on every report |

## API (all under `/api/v1/`)

| Endpoint | Methods | Permission |
|---|---|---|
| `payment-methods/` | GET; POST, PATCH, DELETE (unused only) | GET everyone (cashier: active only); changes Owner |
| `payment-methods/reorder/`, `payment-providers/reorder/` | POST `{"ids": [...]}` | Owner |
| `payment-methods/history/` | GET | Owner, Accountant |
| `payment-providers/` | GET (`?category=&search=&active=`); POST, PATCH, DELETE (unused only) | as above |
| `payment-summary/` | GET `?date_from&date_to&cashier&branch&group=day\|week\|month` | signed in; cashier sees own |
| `payment-transactions/` | GET `?kind=payment\|refund&category&provider(=none)&cashier&branch&status&search&ordering&page&page_size&download=csv\|xlsx` | signed in; cashier sees own |
| `payments/<id>/provider/` | POST `{"provider", "reason"}` | Owner, Accountant |
| `sales/` (POST) | each payment may carry `"provider"` | unchanged |
| `sales/<id>/refund/` | may carry `"provider"` | unchanged |
| `shifts/<id>/close/` | now needs `"payments_reviewed": true` | unchanged |
| `reports/` | each report has a `section`; `?download=xlsx` added | unchanged |

## Audit

Recorded in the append-only audit log: category and provider created, changed, switched on/off, reordered, deleted
(`payment_method.*`, `payment_provider.*`); each sale's payment lines (`sale.completed`); payments reversed by a
cancellation (`sale.voided`); refunds with their provider (`sale.refunded`); provider corrections with the old and new
provider and the reason (`payment.corrected`); shift closing with the reviewed breakdown (`shift.closed`); day closing
with collections and difference (`day.closed`); exports (`report.exported`). The migration writes `payment_provider.migrated`.

## Existing data (migrations `sales 0006`, `sales 0007`, `trading 0005`)

All additive: new tables and columns only; nothing is dropped, renamed or overwritten.

`sales 0007` sets the icons, marks Mobile Money and Bank as requiring a provider, adds the six default providers (skipping
any already there), and fills `created_at` and `recorded_by` of old payments from their sale. It **does not guess providers**:
old Mobile Money and Bank payments stay *Provider not recorded*, are counted in their category, and are listed for review.
It compares payment totals by category and status before and after and stops if anything differs.

Checked on a copy of the shop database on 30 Oct 2026: 33 sales, TZS 5,351,000, unchanged by the migration; 13 old
payments (11 Mobile Money, 2 Bank Transfer) flagged *Provider not recorded*. The existing name "Bank Transfer" was kept;
the Owner can rename it to "Bank" on the new screen.

## Deploying

1. Back up the database (see BACKUP_AND_RESTORE.md).
2. Before migrating: `.\.venv\Scripts\python manage.py payment_migration_report --save before.json` (read-only).
3. `.\.venv\Scripts\python manage.py migrate`
4. After: `.\.venv\Scripts\python manage.py payment_migration_report --compare before.json` must say *Identical*.
   It also lists the payments waiting for a provider.
5. Build and restart the website (`npm run build`), then the backend service, as in DEPLOYMENT.md.
6. Owner: Settings → Payment methods; check names, providers and order. Accountant: Payments → open each
   *Provider not recorded* line and record the provider from the statements, with the reason.

Close Day now needs the payment check box ticked, so deploy the backend and the website together.

## Rolling back

The new columns and tables are only added, so the previous version of the code runs against the migrated database
(it ignores them). To roll back: restore the previous code and restart. Do not reverse the migrations on a database that
has taken payments with providers: reversing would drop the provider of those payments. If a full reversal is ever
needed, restore the backup taken in step 1 instead.

## Not done, and why

- **Credit sales** (FR-PAY-05) stay off until the Owner approves their rules (decision D5 / Q12). The reports already
  show outstanding receivables and would include credit if it were enabled.
- **PDF** uses the browser's *Print / Save as PDF* with the existing print layout; no PDF library was added.
- **Server-side caching** of the payment configuration was not added: it is a few rows, read when the sale window opens,
  and a cache would risk a cashier seeing a switched-off provider.
- Payments are dated by the sale's business day. With no credit sales a payment and its sale happen together; if credit
  is enabled, later collections will need their own business day.
