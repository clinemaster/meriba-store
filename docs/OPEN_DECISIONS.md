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

## Excel migration decisions — confirmed as implementation policy (12 Oct 2026)

The business owner confirmed these as **mandatory business rules**. All are built and covered by automated tests.
Details are in [HISTORICAL_IMPORT.md](HISTORICAL_IMPORT.md).

**Standing rule:** where a source record remains ambiguous, it is preserved and clarification is requested. No value
is invented and no original data is silently changed.

Mandatory controls confirmed with the policy, and where each lives:

| Control | In the system |
|---|---|
| Dry run and exception report **before** committing | Step 1 checks the file and saves nothing; the same preview downloads as an exception report (CSV) before any import |
| Original values preserved; audit trail of every approved correction | Original cell text is stored on every line and never updated. Approved prices and identities are separate records with approver and date; every decision, reopening and row decision is in the audit log |
| Imports repeatable without duplicates | Stable source keys; a repeat adds nothing |
| Historical snapshots separate from live inventory | Separate tables; tests prove an import changes no live table |
| Accountant reviews and prepares; Owner gives final opening-stock approval and activates go-live | Accountant: dry run, explanations, count sheets, opening-balance figure. Owner only: import, identity and price decisions, count approval, opening-balance approval, go-live |
| `Pending Review`, `Approved`, `Rejected`, `Imported` clearly distinguished | Shown by name on records, exceptions and mappings; unlabelled rows keep their decision history |
| Never described as fully reconciled while material exceptions remain | Every history screen and both reports say NOT RECONCILED until nothing is waiting and the Owner accepts |
| Development and testing continue during the review; production go-live is blocked until opening balance, physical stock, product prices and essential configuration are approved | Reviewing missing dates, mappings and unlabelled rows does not hold anything up. Go-live is refused until: products exist, every product on sale has a selling price, payment methods are set, every product on sale has an Owner-approved physical count, no product identity or price question is open, a cashier account exists, and the Owner states and approves the opening balance |

| # | Decision | How it works in the system |
|---|---|---|
| H1 | **Missing workbook sheets.** No other workbook is assumed. The importer reads the daily sheets and produces *Product Mapping Review* and *Historical Daily Records* itself. A later workbook can be imported as an additional source without duplicates | Both outputs are generated on import. Stable keys (date + line number + name) make a second workbook add only what is new; a differing copy of a stored line is not imported and is flagged |
| H2 | **Missing dates (1–9 Sep) and unexplained stock changes.** Nothing is fabricated or interpolated; changes are not assumed to be sales. Everything is preserved and flagged; reviewers can add verified explanations with evidence; affected figures stay incomplete until reviewed | One "Missing dates" exception lists the nine dates and the 57 products with closing-before and opening-after, each traced to sheet and row. Affected records are "Pending review" and "Incomplete". Explanations carry evidence and source references, author and time |
| H3 | **Henken at 3,500 and 4,000.** Both kept; no merge, overwrite or preferred price. The Owner **must** confirm the product identity, package size, price type and effective date before the mapping can be finalised | "Same name, different prices" exception, Owner only. It cannot be closed on a note alone: for each line the confirmed name, package size, approved price, price type and effective date are required. Mapping either line is refused while it is open |
| H4 | **MAGIC MOMENT cost 9,000 → 1,290.** Flagged, both values preserved, neither auto-corrected. The Owner **must** confirm the applicable price type and the correct interpretation before it is marked resolved | "Unusual price change" exception shows the workbook column ("Purchase price"), both values and their sheets. Every way of closing it, including "the recorded value is correct", requires the price type, the amount that applies and its effective date |
| H5 | **mkwawa has no price.** Record preserved, price marked unresolved, no price invented. The Owner **must** confirm the product, its unit or package size, and the applicable price. It cannot be sold until an approved selling price is configured | Shown as "Price unresolved" on the mapping review. Approving a price requires the confirmed name and unit or package size. Without an approved price the product is created switched off, and the system refuses to switch on or sell it |
| H6 | **Unlabelled rows 117–131.** Preserved as source data in "Pending review". Never imported as products, sales, payments, expenses or stock movements. The review interface shows source worksheet, row number, original values, classification, reviewer and decision history | "Unlabelled rows" tab shows all six. Every decision is kept as a history line with reviewer and time. Proposals are never applied automatically. No path exists by which such a row becomes a transaction |
| H7 | **Opening stock** comes from a verified physical count approved by the Owner, never from Excel closing figures. The workflow records product and unit, counted quantity, count date and responsible person, variance against a reference, reviewer and status, approved quantity and movement reference. Live inventory stays off until count and approval are complete | Count sheet on the Stock screen. Excel figure shown as reference only, with the difference. Nothing is stock until the Owner approves; go-live is blocked until every product on sale has an approved count |
| H8 | **Safeguards:** dry run; review dashboard; traceability to sheet and row; originals preserved with a record of approved corrections; idempotent imports; historical snapshots separate from live movements; explicit statuses and permissions; downloadable exception report; tests for every exception; no claim of reconciliation until everything is resolved or accepted | All present. The history is labelled NOT RECONCILED until nothing is waiting and the Owner accepts it; a later import or reopened decision withdraws that |

## What the importer found in the October workbook (dry run; nothing imported into the real database yet)

| Finding | Waiting for |
|---|---|
| No sheets for 1–9 September; stock of 57 products changes across the gap | An explanation with evidence, or acceptance as incomplete |
| "Henken" on lines 4 and 5 at 3,500 and 4,000 | Owner: which of the four cases |
| **New:** "black and whithe" also appears on two lines with different prices (renamed "kubwa" and "ndogo" on 9 Oct) | Owner: almost certainly two sizes, but it is your decision |
| "MAGIC MOMENT" purchase price 9,000 → 1,290 on 30 Sep | Owner: correct, a typing error, or a different price type |
| "mkwawa" has no sales price | Owner: identity, unit, price — or not sold |
| 129 product names over 113 lines (16 lines were renamed on 9 Oct); the unit is stated plainly for only some | Owner: confirm name and unit for each when mapping |
| 434 unlabelled rows (rows 117–123, 125–131 on 31 sheets). Rows 117–118 equal column totals; the others match nothing | Owner or Accountant: say what each row number is, exclude it, or flag it |

## Defaults I applied in the importer that need your confirmation

| # | Topic | Current behaviour |
|---|---|---|
| I1 | What identifies a product line across sheets | The `S/N` number. Names may change between sheets; the line number is treated as the same line. If a future workbook numbers its lines differently, carry-forward differences will be flagged, not hidden |
| I2 | When a price change counts as "unusual" | Falls by more than half, more than doubles, purchase price above the sales price, or below a fifth of it. Smaller changes are recorded in the price history and flagged on the mapping line, without a separate exception |
| I3 | Who may decide what | Product identity and prices: Owner only. Missing dates, arithmetic, conflicting copies, unlabelled rows: Owner or Accountant. Importing, reopening a decision, and accepting the history: Owner only |
| I8 | Which history questions block go-live | Only open questions about what a product is or what it costs (same name with different prices, unusual price change, missing price). I read your "product prices approved" this way. Missing dates, mappings and unlabelled rows do not block go-live |
| I9 | Closing a missing-price question without a price | Allowed only as "Not sold; keep the history only" |
| I10 | A "data-entry error" on a same-name pair | Still needs name, size, price, type and date for both lines, so the record shows what each line was meant to be |
| I4 | What blocks "reconciled" | Any open material exception, any unlabelled row still pending or flagged, and any source product not yet mapped or rejected |
| I5 | Every product on sale needs an approved count before go-live | A count of zero is allowed but must be entered |
| I6 | Correcting an approved count before go-live | By a further count sheet, which the Owner also approves; both stay in the ledger |
| I7 | The import itself needs the Owner to tick "backup taken" | The system cannot check that a backup exists; it records who confirmed |

## What you must provide before go-live

1. **Your decisions on the exceptions above**, made in the Excel History screens (or tell me and I will note them for you to enter).
2. **A physical stock count** of every product, entered on the count sheet and approved by you.
3. **The verified opening cumulative sales balance** and its cutover date — or your explicit confirmation that tracking starts fresh from zero.
## Product table enhancement (12 Oct 2026)

Built as specified: the Products screen shows Product, Unit (first labelled "Sold By"; renamed at the owner's request on 13 Oct 2026), Volume (ml), Total Stock, Sales, Closing
Stock, Purchase Price, Selling Price, Total Sales, Profit and Stock, for a business day or a date range, with search,
sorting, pagination, a details view and CSV export. Cost and profit are for the Owner and Accountant only.

### How the figures are defined

| Column | Definition in the system |
|---|---|
| Total Stock | Opening stock for the period + deliveries, returns to the shelf, and counts that added stock |
| Sales | Quantity sold in the period, in the product's own unit. A cancelled sale is not a sale. A crate sold from a bottle product counts as its bottles |
| Closing Stock | Opening + stock in − sales − breakages and other stock out. For a simple day: Total Stock − Sales |
| Purchase Price | Weighted-average cost of the units now in stock, per unit |
| Selling Price | The current selling price |
| Total Sales | Completed sales in the period, at the prices actually charged, less refunds given in the period |
| Profit | Gross profit: Total Sales − cost of goods sold. Expenses are not taken off |
| Stock | The live balance from the stock ledger |

### Decisions I made that need your confirmation

| # | Topic | What the system does | Why |
|---|---|---|---|
| P1 | **The internal stock unit** | Each product's stock is kept in its own unit (your earlier decision D3: one unit per product, as in the Excel). A Konyagi counted in bottles is kept in bottles; a Safari counted in crates is kept in crates | You wrote "preferably individual bottles or another approved base unit". Converting crate products to bottles would change every count sheet and price. Tell me if you want that instead |
| P2 | **Package configuration** | Two separate things: (a) "bottles in one crate" on a crate product, used to show the bottle equivalent; (b) an extra package on a product, e.g. "also sell by the crate of 12", with its own price. Selling one crate takes 12 bottles out of stock. Each product has its own figure | Covers both "a product sold as a crate" and "a product sold in several package sizes" |
| P3 | **Who configures packages** | Owner or Accountant adds or changes a package; **only the Owner verifies** it, and it cannot be sold until verified. Changing the number resets verification. Every sale line keeps the number it was sold with | So a change can never alter past sales or stock |
| P4 | **Changing the Unit** | Refused once a product has stock, sales or packages | Its recorded quantities would silently change meaning |
| P5 | **Costing method** | Weighted average, recalculated on each delivery: (in stock × old average + received × delivery cost) ÷ (in stock + received). The latest price is never applied to stock already held | As you specified |
| P6 | **Cost of opening stock** | Valued at the Purchase Price entered on the product when the Owner approves the count. If none is entered, cost is unknown | There are no delivery records for opening stock |
| P7 | **A delivery recorded with no cost** | Carried at the existing average, and the product is marked **provisional**; profit on what is sold from it shows "(provisional)" | Rather than invent a cost or drop the profit figure |
| P8 | **No reliable cost at all** | Purchase Price shows "Not known" and Profit shows "Not available" for affected sales; they are left out of the profit total and counted in a warning | Never guessed |
| P9 | **Refunds and cancellations in profit** | A cancelled sale counts in neither sales nor cost. A refund reduces Total Sales on the day it is given. Goods put back on the shelf take their cost back; **damaged goods stay a cost** | Consistent with your decision D6 |
| P10 | **The "Purchase Price" you type on a product** | Kept as the last purchase price entered. It starts the average for opening stock. It does not overwrite the average afterwards unless you tick "also update purchase price" on a delivery | So typing a new price cannot rewrite the cost of stock already bought |
| P11 | **Volume from existing size text** | Your two existing products had sizes "750 mls" and "200 mls"; these were read as 750 and 200 ml. Anything not plainly a number of millilitres is left blank for you to enter | No volume is invented |
| P12 | **Adding a unit such as "Single"** | A developer adds it to the approved list and runs a migration; the database then accepts it. There is no screen for adding units | You asked for "approved configuration or migration" |

### What is not done

- The **stock on hand report** and the **Excel history mapping** use the new fields, but the Excel mapping asks for the
  size as text ("750ml") rather than a separate volume box.
- **Category** and **brand** exist on a product but are not shown in the table or the form.
- The "supplier pack" text field is no longer on the product form (it is still stored for products that have it).
## Replicating the Excel workflow (13 Oct 2026)

Findings and what is built are in [EXCEL_WORKFLOW.md](EXCEL_WORKFLOW.md). The workbook's sums reproduce all 21,018
calculated figures in the 31 sheets with no differences. These questions must be answered before the rest is built:

| # | Question | Why it matters |
|---|---|---|
| W1 | **Is the Daily Sheet to replace the New Sale screen, or sit beside it?** In Excel you type one Sales quantity per product per day. The system currently records each sale as it happens (with a receipt and how it was paid) and fills the sheet from those | If quantities are typed on the sheet, there is no record of how each sale was paid, so the cashier's cash count and the mobile money and bank checks have nothing to compare against. Both ways cannot be used for the same product on the same day without counting sales twice |
| W2 | ~~If Sales are typed on the sheet, who types them, and when?~~ **Decided 13 Oct 2026: the cashier types sales, at any time during the day.** Built: an "Add to Sales" box on every line of today's sheet | Closed |
| W3 | ~~What are the seven typed amounts under the product list?~~ **Decided 13 Oct 2026: the owner withdrew this question. The block of figures under the product list (rows 120–131) is not to be implemented** | Closed. Nothing is built for it |
| W4 | **Profit: which rule do you want to rely on?** The workbook uses Sales x (Sales price - Purchase price that day). The Products screen uses the weighted-average cost you asked for on 12 October. For a product whose purchase price changed while old stock remained, the two give different profit | Both are shown, each on its own screen. Say if only one should be kept |
| W5 | **The 13 empty Profit cells** ("Hajos wine dum" on 11 days, "gb k", "gb ndg"): 94,000 of profit missing from the workbook's totals | Left empty and marked. Say if they should be filled by the sum, as an approved correction |
| W6 | **"Stock" on the sheet is a money value at selling price.** On the Products screen "Stock" is a quantity | Same word, two meanings, on two screens. I can rename one |
| W7 | **Please close the workbook in Excel** (or save a copy elsewhere) so I can read the formulas themselves | The sums are confirmed from the results; reading the cells would confirm nothing is hidden, such as a link to another file |