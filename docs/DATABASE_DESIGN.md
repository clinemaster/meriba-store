# Database design

PostgreSQL 17. Tables are created and changed only through Django migrations (`backend/*/migrations/`).
Money columns are `numeric(16,2)`; quantities are `numeric(14,3)`.

## Tables

```
core_branch 1───1 core_businesssettings
     │
     ├──< trading_businessday >──(previous_day, one-to-one)── trading_businessday
     │         │
     │         └──< trading_cashiershift >── accounts_user (cashier)
     │                    │        └──< trading_shiftpaymenttotal >── sales_paymentmethod
     │                    │
     ├──< sales_sale >────┘
     │        ├──< sales_saleitem >── catalog_product
     │        └──< sales_payment  >── sales_paymentmethod
     │
     ├──< inventory_stockbalance >── catalog_product        (one row per product per branch)
     ├──< inventory_inventorymovement >── catalog_product   (the ledger)
     └──< inventory_stockadjustment ──< inventory_stockadjustmentline >── catalog_product

catalog_category ──< catalog_product ──< catalog_productunit
core_auditlog  (who, what, when, why, before, after)
```

| Table | Holds |
|---|---|
| `accounts_user` | One row per person: username, hashed password, role (OWNER / ACCOUNTANT / CASHIER), active flag |
| `core_branch` | MERIBA Main Branch (more can be added later) |
| `core_businesssettings` | Receipt text, split-payment switch, cash tolerance, opening cumulative sales, go-live time |
| `core_auditlog` | Append-only record of sensitive actions |
| `catalog_category`, `catalog_product` | Product list: code, name, size, unit, barcode, selling price, cost, low-stock level |
| `catalog_productunit` | Optional extra selling unit (e.g. Carton = 12 bottles), usable only once verified |
| `inventory_stockbalance` | Current quantity per product |
| `inventory_inventorymovement` | Every stock change: type, quantity, balance before/after, business date, source, user, reason |
| `inventory_stockadjustment(+line)` | Opening stock counts and later count corrections |
| `trading_businessday` | One trading day: opening cumulative sales, gross, voids, net, closing cumulative sales, status |
| `trading_cashiershift` | A cashier's shift: float, sales total, expected cash, counted cash, variance, review |
| `trading_shiftpaymenttotal` | Per shift and payment method: recorded amount and whether it was verified |
| `sales_paymentmethod` | Cash, Mobile Money, Bank Transfer (+ any the Owner adds) |
| `sales_sale` | Receipt number, cashier, day, shift, totals, change, status, void details |
| `sales_saleitem` | Product, name/price **as they were at the time**, quantity, line total |
| `sales_payment` | Method, amount kept, amount handed over, reference, status |
| `sales_refund`, `sales_refunditem` | Money given back: original sale and line, quantity, amount, whether restocked, the business day it was recorded on, the drawer it came from |
| `trading_daycorrection` | Owner-authorised correction of a closed day: amount, reason, authoriser, net sales and closing balance before and after |
| `finance_supplier` | Suppliers |
| `finance_goodsreceipt`, `finance_goodsreceiptline` | A delivery: optional supplier and invoice number, products, quantities, optional cost |
| `finance_expense` | Expense: date, category, description, amount, payment method, drawer it was paid from (if any), status |
| `inventory_openingcount`, `inventory_openingcountline` | Physical count sheet before go-live: count date, who counted, product, unit, counted quantity, Excel reference figure (comparison only), review status, reviewer, approved quantity, the stock movement it produced |
| `history_importbatch` | One committed import of one workbook file (name, fingerprint, who, summary) |
| `history_sourceproduct` | Product Mapping Review: each product name as written, its recorded price history per price type, flags, proposal, the Owner's decision and the live product it maps to |
| `history_historicalrecord` | Historical Daily Records: file, worksheet, row, date, original cell text, figures read, validation status, import status, incomplete mark |
| `history_unclassifiedrow` | Unlabelled rows kept as written, with proposal, decision and reason |
| `history_reviewitem`, `history_reviewnote` | Exceptions with their evidence and decision; explanations added by reviewers (never edited) |
| `history_approvedprice` | Owner-approved price for a source product: price type, amount, effective date, approver |
| `history_historyacceptance` | The Owner's explicit acceptance of the history as reconciled |

## Business rules enforced by the database itself

| Rule | Constraint |
|---|---|
| Stock can never be negative | `stock_balance_not_negative` |
| One balance row per product and branch | `stock_balance_one_per_product_branch` |
| A source event moves a product only once | `movement_once_per_source` (type + source + product unique) |
| Ledger arithmetic: after = before + change | `movement_balances_add_up` |
| A sale request can only be saved once | `sales_sale.request_key` unique |
| Receipt numbers are unique | `sales_sale.receipt_number` unique |
| Sale total = subtotal − discount; total > 0 | `sale_total_formula`, `sale_amounts_valid` |
| Change = handed over − total, never negative | `sale_change_formula` |
| A cancelled sale must have a time and a reason | `sale_void_needs_reason` |
| Line base quantity = quantity × unit factor | `sale_item_base_quantity_formula` |
| One business day per date; only one open day | `business_day_one_per_date`, `business_day_one_open_per_branch` |
| **Net sales = gross − discounts − voids − refunds + corrections** | `business_day_net_sales_with_adjustments` |
| A refund has a positive total and a reason; a line is refunded once per refund | `refund_total_positive`, `refund_needs_reason`, `refund_item_once_per_line` |
| A day correction is never zero and always has a reason | `day_correction_not_zero`, `day_correction_needs_reason` |
| A delivery, refund, expense or correction request is saved once | `request_key` unique on each |
| A historical line, source product, unlabelled row or exception is stored once | `source_key` / `key` unique on each |
| Only one count sheet can be waiting for review; a decided sheet names its reviewer | `opening_count_one_pending`, `opening_count_review_recorded` |
| An excluded unlabelled row has a reason; a decided exception has a note and a resolution | `unclassified_exclusion_needs_reason`, `review_decision_needs_note` |
| **Closing cumulative sales = opening + net sales** (closed days); empty while open | `business_day_closing_balance_formula` |
| **A closing balance is carried forward at most once** | `previous_day` is one-to-one |
| One shift per cashier per day; one open shift per cashier | `shift_one_per_cashier_per_day`, `shift_one_open_per_cashier` |
| Cash variance = counted − expected | `shift_variance_formula` |
| Barcodes unique when present; prices, costs, floats not negative | several check constraints |
| Nothing referenced can be deleted | every foreign key is `PROTECT` |

## How the two balances work (they are separate on purpose)

**Cumulative monetary sales balance** — table `trading_businessday`

```
closing_cumulative_sales = opening_cumulative_sales + net_sales
next day's opening        = last CLOSED day's closing     (or the go-live figure for the very first day)
```

| Day | Opening | Net sales | Closing |
|---|---|---|---|
| 1 | 0 | 300,000 | 300,000 |
| 2 | 300,000 | 200,000 | 500,000 |
| 3 | 500,000 | 150,000 | 650,000 |

It never includes cash float, cash counted, shortages, expenses or bank deposits.

**Physical stock** — tables `inventory_stockbalance` and `inventory_inventorymovement`

```
balance after = balance before + movement quantity      (sales are negative, receipts positive)
```

Stock is never worked out from money figures, and money is never worked out from stock.

**Cash** — table `trading_cashiershift`

```
expected cash = opening float + cash kept from sales − cash refunds − cash paid out for expenses
cash variance = counted cash − expected cash              (negative = short, positive = over)
```

## Indexes

Besides primary and unique keys: sales by (day, cashier) and by time; movements by (product, business date)
and by business date; audit log by time, action and (entity type, entity id); products by (active, name).

## Not yet in the schema

Purchase orders, cash put into a drawer mid-shift, a stored daily per-product stock summary (it is a report
instead). They arrive with their phases as new migrations.

## Historical data is walled off from the live system

No table in the `history` module has a foreign key into sales, payments, stock movements or balances, and no code
reads those tables to create live records. The only links out are: a source product may point to the live product
the Owner mapped it to, and a count sheet may show the last historical closing figure beside a physical count for
comparison. Purchase price and sales price are separate columns in historical records, and approved prices carry an
explicit price type.

## Refunds and corrections never rewrite history

- A **refund** adds rows; it changes nothing on the original sale or its day. It lowers net sales of the day it is recorded on.
- A **correction** changes a closed day's `adjustments`, `net_sales` and `closing_cumulative_sales`, and the opening
  and closing balances of later days. The gross, void and refund figures stay as closed, and `trading_daycorrection`
  keeps the before and after values, so the original closing result can always be read back.
