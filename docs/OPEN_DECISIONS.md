# Business decisions

## Decided by the business owner (12 Oct 2026)

| # | Decision | Answer | Built? |
|---|---|---|---|
| D1 | Where the code lives | `C:\Projects\meriba-lsms`, outside OneDrive | ✅ |
| D2 | Payment methods | Cash, Mobile Money, Bank Transfer. One sale may be split across methods | ✅ |
| D3 | Selling units | One unit per product, as in the Excel sheets. Pack conversions stay off until a factor is verified | ✅ |
| D4 | Cashiers per day | One cashier per day (the system still copes with more) | ✅ |
| D5 | **Net sales** | Net sales = completed sales − qualifying cancellations. A cancellation is never deducted twice. Cancelled sales stay in the audit trail. Taxes, discounts and credit sales stay disabled until their rules are approved; the design leaves room for them | ✅ |
| D6 | **Refund after day closure** | Recorded on the current open business day, linked to the original sale. A closed day is never silently changed. A restricted adjustment process exists for formal corrections, keeping the original figures, reason, authorising user and audit history | ✅ |
| D7 | **Opening cumulative sales balance** | Not taken from the Excel total. Configurable; the Owner must enter and approve the verified balance as of the cutover date before the first live day. Zero only if confirmed as a genuinely new baseline. Historical Excel data stays separate until reconciled | ✅ |
| D8 | **Accountant permissions** | Broad operational and financial access (sales, refunds, purchases, expenses, reconciliation, reports). Owner only: user management, critical settings, opening-stock approval, initial balance approval, go-live. The Accountant may prepare opening-stock counts and the balance reconciliation for the Owner to review. Sensitive adjustments are authorised and audited | ✅ |

How D5 works in the system:

```
net sales = gross sales      every sale recorded that day, at full value
          − discounts        always 0 today (feature disabled)
          − cancelled sales  sales of that day cancelled before the cashier's shift closed
          − refunds          money given back that day, for sales of any day
          + corrections      Owner-authorised formal corrections to that closed day
```

A cancelled sale is counted in gross once and taken off once. It cannot also be refunded.

## Defaults I applied that still need your confirmation

| # | Topic | Current behaviour |
|---|---|---|
| Q1 | **Who can cancel (void) a sale** | Owner or Accountant, with a reason, while that cashier's shift is still open. After that, a refund is used |
| Q2 | **Who can refund** | Owner or Accountant. The cashier cannot. Refund value is always the original price × quantity returned |
| Q3 | **Formal correction of a closed day** | Owner only (not the Accountant). The Accountant can see corrections but not make them |
| Q4 | **Stock adjustments by the Accountant** | Take effect immediately, with a reason and an audit record. There is no second approval step by the Owner. Say if you want adjustments above a certain size to wait for Owner approval |
| Q5 | **Who finalises the day** | The day closes automatically when the last open shift is closed. A cash shortage does not block closing; it is flagged for review |
| Q6 | **Starting again after closing** | Once today is closed, no new day can start until tomorrow. There is no "reopen day" |
| Q7 | **Cash float** | The cashier types the float when starting the day |
| Q8 | **Cash difference tolerance** | TZS 0: any difference needs a note and a review |
| Q9 | **Approving own shift** | Nobody can approve a shift they ran themselves |
| Q10 | **Expenses paid from the drawer** | Recorded by Owner/Accountant against the open cashier's drawer; lowers that drawer's expected cash. Never affects cumulative sales |
| Q11 | **Updating purchase cost on delivery** | Only when "also update purchase cost" is ticked on the delivery |
| Q12 | **Whole units only** | Quantities must be whole numbers |
| Q13 | **Receipt number format** | `MB-YYYYMMDD-0001`, restarting each day |

## What you must provide before go-live

1. **A physical stock count** of every product, taken on the evening before the first live day.
2. **The verified opening cumulative sales balance** and its cutover date — or your explicit confirmation that tracking starts fresh from zero.
3. **Answers to the Excel questions below**, at least X3–X7, so the product list can be set up correctly.

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
| X9 | The sheets total TZS 50,395,300 in sales, but with nine days missing | Per D7 this is not used as the opening balance |
