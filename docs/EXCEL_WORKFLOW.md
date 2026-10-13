# The Excel workflow and how the system reproduces it

Requirement (13 Oct 2026): record transactions the way the MERIBA Excel workbook does, with the workbook as the
source of truth, and without substituting other formulas.

## How the workbook works

First established from the values of all 31 sheets (3,503 product lines), then **confirmed on 13 Oct 2026 by reading
the formulas themselves** from a separate copy of the workbook. The original file was not opened for writing or changed.

### The formulas in the cells

| Column | Formula in the cell (row 4 as the example) | Found in |
|---|---|---|
| C Opening stock (headed "2") | none: a typed number, copied by hand from the previous sheet | all lines |
| D Add Purchases | none: typed | 117 lines have a figure |
| E Total stock | `=C4+D4` | every line |
| F Sales | none: typed | 868 lines have a figure |
| G Closing stock | `=E4-F4` | every line |
| H Purchase price, I Sales price | none: typed | |
| J Total Sales | `=F4*I4` | every line |
| K Profit | `=(I4-H4)*F4` | 3,232 lines; **the cell is empty on the other 271** |
| L Stock | `=G4*I4` | every line |
| M T.Purchases | `=D4*H4` | all but 39 lines, where the cell is empty |
| Totals | `=SUM(K4:K116)`, `=SUM(L4:L116)`, `=SUM(J4:J117)`, `=SUM(M4:M118)` | every sheet |

Other things the formulas show:

- **No sheet refers to another sheet**, and the workbook has no links to other files and no named ranges. Opening
  stock is not a formula: each day's opening figures were typed (or pasted) from the previous day's closing figures.
  That is why a gap in the dates breaks the chain silently. The system carries the figure forward itself.
- **The 271 empty Profit cells have no formula at all.** On 258 of them nothing was sold, so nothing is missing.
  On 13 there were sales: these are the cells flagged for the Owner (see "The 13 empty Profit cells").
- **The sheet for 9 October has two extra columns** (the pack, such as "Box (24)", and a description, such as
  "200mls") after Details. Every formula is the same, moved two columns to the right.
- The seven typed amounts under the product list and the sums built on them are as described below.

One worksheet per day, named `DD.MM.YYYY`. One row per product. The person types three things:

| Typed by the person | How often in the 31 sheets |
|---|---|
| **Add Purchases** (quantity bought) | 68 lines, on 11 of the 31 days |
| **Sales** (quantity sold that day) | 890 lines |
| **Purchase price** / **Sales price**, when one changes | 3 and 5 changes in the whole period |

Everything else follows:

| Column | Sum | Holds on |
|---|---|---|
| Opening stock (headed "2" in the workbook) | the previous sheet's Closing stock | every line, except across the missing 1–9 September |
| Total stock | Opening + Add Purchases | 3,503 of 3,503 |
| Closing stock | Total stock − Sales | 3,503 of 3,503 |
| Total Sales | Sales × Sales price | 3,503 of 3,503 |
| Profit | Sales × (Sales price − Purchase price) | 3,490; the other 13 cells are **empty** |
| Stock | Closing stock × **Sales price** (a money value, not a quantity) | 3,503 of 3,503 |
| T.Purchases | Add Purchases × Purchase price | 3,503 of 3,503 |

Rows under the product list (row numbers from the October sheets):

| Row | Content | Status |
|---|---|---|
| 117 | Total of Profit; total of Stock | confirmed on all 31 days |
| 118 | Total of Total Sales | confirmed on all 31 days |
| 119 | Total of T.Purchases | confirmed |
| 120, 121, 122 | Three typed amounts: 632,700; 697,900; 1,990,300 | **unlabelled; identical on every sheet** |
| 123 | Stock total + rows 120 + 121 + 122 | true on 31 of 31 days |
| 125, 126 | Two typed amounts: 2,678,500; 3,487,100 | **unlabelled; identical on every sheet** |
| 127 | row 125 + row 126 | true on 31 of 31 days |
| 128 | row 123 − row 127 | true on 31 of 31 days |
| 129, 130 | Two typed amounts: 3,214,800; 1,387,300 | **unlabelled; identical on every sheet** |
| 130 (second figure) | row 129 + row 130 | true on 31 of 31 days |
| 131 | row 128 + row 130 (second figure) | true on 31 of 31 days |

So the bottom block is a position statement: stock value, plus three amounts, less two amounts, plus two amounts.
What the seven typed amounts are is not written anywhere in the workbook.

## Validation

`trading.sheet.compare_with_workbook()` applies the sums above to the typed inputs of every imported line and compares
each result with what the workbook shows. Run on 13 Oct 2026 against the imported October workbook:

| Check | Result |
|---|---|
| Lines | 3,503 |
| Calculated figures compared | 21,018 |
| Figures where the workbook shows a **different** number | **0** |
| Figures where the workbook cell is **empty** but the sum gives a value | 13, all in Profit: "Hajos wine dum" on 11 days, "gb k" once, "gb ndg" once. Together 94,000 of profit that the workbook's totals leave out |
| Opening stock not equal to the previous sheet's closing | 57 lines, all on 10 September (the sheet after the missing 1–9 September) |

The same check is available in the application at `/api/v1/daily-sheet/compare-with-workbook/` (Owner and Accountant),
so it can be repeated after any further import.

## What is built

**Daily Sheet** screen (Owner and Accountant), one sheet per day with Previous / Next:

- the workbook's column headings in the workbook's order: S/N, Details, Opening stock, Add Purchases, Total stock,
  Sales, Closing stock, Purchase price, Sales price, Total Sales, Profit, Stock, T.Purchases; a TOTAL row;
- the workbook's sums, unchanged;
- **Excel days** (31 Aug – 9 Oct): shown exactly as written. A cell that differs from the workbook's own sum
  (the 13 empty Profit cells) is marked ⚠ and left as it is;
- **live days**: filled in automatically. Add Purchases comes from deliveries recorded, Sales from sales recorded,
  and the opening stock is the previous closing stock;
- **closed days**: the sheet is saved as it stood at closing, like a saved worksheet, so a later price change does
  not alter it;
- download as CSV with the same headings.

Two things the workbook has no column for are shown rather than hidden: an **Other** column when a return, count
correction or breakage also moved stock that day, and a "taken" figure when the money actually taken differs from
Sales × Sales price.

## Sales are entered on the Daily Sheet only (decided 13 Oct 2026)

The Daily Sheet is the primary and only sales-entry screen. The separate New Sale screen has been removed; its old
address opens the Daily Sheet. The cashier types sales on today's sheet at any time during the day:

1. each line has an "Add to Sales" box. The quantity typed is **added** to the day's Sales for that product;
2. a window asks how it was paid: cash (with the change to give), mobile money, bank, or more than one of them. If
   the product has a verified package (a crate of 12), it can be sold as a package at the package's own price;
3. the sale is saved in the database as a transaction with a receipt number, which can be printed;
4. the sheet works out Total stock, Closing stock, Total Sales, Profit and Stock with the workbook's formulas.

What is kept from before: stock checks (a quantity larger than the stock left is refused), one save per entry even
on a double click or a lost connection, Today's Sales, cancelling and refunding with a reason, cash reconciliation at
closing, and the audit history.

Differences from Excel, on purpose:

- a quantity already saved is not typed over. A mistake is cancelled or refunded in Today's Sales, with a reason;
- one entry is one product. A customer buying three products is three entries and three receipts;
- the cashier's sheet shows today only, without Purchase price, Profit and T.Purchases (the server does not send them).

## Profit (decided 13 Oct 2026)

Profit = Sales × (Sales price − Purchase price), with the purchase price recorded for that business day, exactly as
`=(I4-H4)*F4`. Weighted-average costing is not used in any figure and must not be introduced without the owner's
explicit approval.

- When a sale is saved, the product's purchase price at that moment is stored on the sale line.
- When a day is closed, its sheet is stored with that day's purchase and sales prices.
- So changing a product's price later changes neither the profit of past sales nor past sheets.
- The Products screen and the profit report use the same rule. The weighted average of deliveries is still shown in a
  product's Details, marked "for information only".

## The 13 empty Profit cells (decided 13 Oct 2026)

Kept empty. Nothing is filled in automatically, and the workbook's totals are shown as the workbook has them.

- On the Daily Sheet for an Excel day the cell is marked ⚠ (empty).
- The Daily Sheet screen lists all 13 under "Empty Profit cells in the Excel workbook", for the Owner's review, with
  what the workbook's formula would give shown beside each one as information.
- Only the Owner can approve a figure. The approval records the figure, the reason, the Owner's name and the date, and
  is written to the audit history. The historical record keeps its empty cell; the approved figure is shown beside it.
  An approval cannot be replaced afterwards.
- New transactions always have their profit calculated.

## Not built

1. **Typing Add Purchases directly on the sheet.** It is filled from deliveries entered on Receive Stock.

## Deliberately left out

**The position block** (rows 120–131, the seven typed amounts and the sums built on them). The owner decided on
13 Oct 2026 that it is not to be implemented. The rows remain in the imported history as unlabelled rows, unchanged.
