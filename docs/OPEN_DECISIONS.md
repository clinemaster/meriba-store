# Business decisions

## Decided by the business owner (12 Oct 2026)

| # | Decision | Answer |
|---|---|---|
| D1 | Where the code lives | `C:\Projects\meriba-lsms`, outside OneDrive |
| D2 | Payment methods | Cash, Mobile Money, Bank Transfer. One sale may be split across methods |
| D3 | Selling units | One unit per product, as in the Excel sheets. Pack conversions stay switched off until a factor is verified |
| D4 | Cashiers per day | One cashier per day (the system still copes with more) |

## Defaults I applied that need your confirmation

These were not fully defined in the SRS. The system currently behaves as described; say if any should change.

| # | Topic | Current behaviour | Why it matters |
|---|---|---|---|
| Q1 | **Net sales** definition | Net sales = all sales recorded that day − sales cancelled that day. No discounts or taxes exist. | It is the figure added to the cumulative balance |
| Q2 | **Who can cancel (void) a sale** | Owner or Accountant only, with a reason, and only while that cashier's shift is still open | Cashier cannot cancel their own sales |
| Q3 | **Cancelling after the day is closed** | Not possible yet. Planned: a refund/return recorded on the *current* day, so closed days never change | Affects AT-SALES-05 |
| Q4 | **Who finalises the day** | The day closes automatically when the last open shift is closed. A cash shortage does not stop the day closing; it is flagged for Accountant/Owner review | Shop can always trade next morning |
| Q5 | **Starting again after closing** | Once today is closed, no new day can start until tomorrow | Needs the "reopen day" feature if you ever close by mistake |
| Q6 | **Cash float** | The cashier types the float when starting the day | Alternative: Owner sets a fixed float |
| Q7 | **Cash difference tolerance** | TZS 0: any difference needs a note and a review | Owner can set e.g. TZS 500 |
| Q8 | **Accountant limits** | Accountant can do everything except: manage users, change settings/payment methods, enter opening stock, go live, verify pack conversions | Master prompt asks for your approval |
| Q9 | **Approving own shift** | Nobody can approve a shift they ran themselves | If the Owner also sells, a second Owner/Accountant is needed |
| Q10 | **Opening cumulative sales balance** | Zero unless you type a figure at go-live. The Excel shows TZS 50,395,300 of sales across its 31 sheets, but with nine days missing I have not used it | Your call whether to start from 0 or an approved figure |
| Q11 | **Whole units only** | Quantities must be whole numbers | No half bottles |
| Q12 | **Discounts, taxes/VAT, credit sales, customer accounts** | None. Not built, not invented | SRS mentions them only as "configured"/"when enabled" |
| Q13 | **Receipt number format** | `MB-YYYYMMDD-0001`, restarting each day | Cosmetic |

## Questions about the Excel workbook (`MERIBA  STORE OCT  2026.xlsx`)

Found by reading all 31 sheets. Nothing has been imported.

| # | Finding | Question |
|---|---|---|
| X1 | The SRS expects sheets called *Product Mapping Review*, *Historical Daily Records*, *Raw Source Rows*. The workbook has only 31 daily sheets (31 Aug, then 10 Sep – 9 Oct 2026) | Is this the right workbook, or is there a prepared one? |
| X2 | 1–9 September are missing. Stock for 57 products changes across the gap with no record (e.g. Konyagi ndogo 459 → 350) | Do the missing sheets exist? |
| X3 | "Henken" appears twice (rows 4 and 5) with different prices (3,500 and 4,000) | Two different products (which sizes?) or a duplicate? |
| X4 | "MAGIC MOMENT kati" cost changed from 9,000 to **1,290** on 30 Sep (selling price 13,000) | Typing mistake? What is the right cost? |
| X5 | "mkwawa" has no price and no stock | Still sold? |
| X6 | Names changed on 9 Oct (e.g. "grants" → "grants without glass", "grants750mls" → "grants with glass") | Confirm the 9 Oct names are the correct ones |
| X7 | Units differ by product: some counted per bottle, some per crate, carton or 4-pack ("Box (4)" at 13,500) | Confirm, per product, what one "unit" is |
| X8 | Rows 117–131 hold unlabelled totals (e.g. 632,700; 697,900; 1,990,300; 83,105,700) | What are these figures (expenses? cash? bank?) |
| X9 | Go-live stock | The SRS forbids using the Excel closing stock as opening stock. A physical count is needed on the evening before go-live |
