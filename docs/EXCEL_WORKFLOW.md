# The Excel workflow and how the system reproduces it

Requirement (13 Oct 2026): record transactions the way the MERIBA Excel workbook does, with the workbook as the
source of truth, and without substituting other formulas.

## How the workbook works

Established from the values of all 31 sheets (3,503 product lines, 434 rows under the product list).
**The formula text in the cells has not been read**: Excel had the workbook open, which blocks other programs from
reading it. Every calculated figure was instead recomputed and compared; see "Validation".

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
- the workbook's sums, unchanged. This screen does **not** use the weighted-average cost of the Products screen;
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

## Typing sales on the sheet (decided 13 Oct 2026)

The cashier types sales on today's sheet at any time during the day. Each line has an "Add to Sales" box: the
quantity typed is **added** to the day's Sales for that product, after the cashier says how it was paid. Behind the
sheet each entry is an ordinary sale (receipt number, payment method), the same record the New Sale screen makes, so
the two can be used side by side without counting anything twice and the cash count at closing still has something to
check against. Differences from Excel, on purpose:

- a quantity already saved is not typed over. A mistake is cancelled or refunded in Today's Sales, with a reason;
- the cashier's sheet shows today only, without Purchase price, Profit and T.Purchases (the server does not send them);
- a quantity larger than the stock left is refused.

## Not built, waiting for the owner's answers

1. **Typing Add Purchases directly on the sheet.** It is filled from deliveries entered on Receive Stock.
2. **The 13 empty Profit cells.** Shown as empty for the Excel days. For live days the sum is always applied.

## Deliberately left out

**The position block** (rows 120–131, the seven typed amounts and the sums built on them). The owner decided on
13 Oct 2026 that it is not to be implemented. The rows remain in the imported history as unlabelled rows, unchanged.
