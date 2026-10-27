# Historical Excel import and review

How the old daily Excel sheets are brought in, checked and reviewed. Confirmed by the business owner as
implementation policy on 12 Oct 2026 (decisions H1–H8 in [OPEN_DECISIONS.md](OPEN_DECISIONS.md)).

**Standing rule:** where a source record is ambiguous it is preserved and clarification is requested. No value is
invented and no original data is silently changed.

## The principle

The Excel sheets are **reference material**. They are stored exactly as written, in their own tables, and are
reviewed there. Nothing in them ever becomes a sale, a payment, a stock movement or a balance in the live system.
Live opening stock comes only from an approved physical count.

The data is labelled **NOT RECONCILED** everywhere until every exception has been decided and the Owner
explicitly accepts it.

## What the importer reads (column mapping)

One worksheet per day, named `DD.MM.YYYY`. The heading row is the one whose first cell is `S/N`.

| Workbook column | Stored as | Notes |
|---|---|---|
| `S/N` | line number | Identifies the product line within the workbook series |
| `Details` | source product name | Kept as typed; compared ignoring capitals and extra spaces |
| column C / `Description` (9 Oct sheet only) | pack text / size text | e.g. "Box (24)", "200mls". Never interpreted automatically |
| the column before `Add Purchases` (headed "2") | opening quantity | The sheet gives it no proper heading |
| `Add Purchases` | quantity bought | |
| `Total stock` | total stock | |
| `Sales` | quantity sold | |
| `Closing stock` | closing quantity | |
| `Purchase price` | **purchase price** | Kept as its own price type |
| `Sales price` | **sales price** | Kept as its own price type; never mixed with purchase price |
| `Total Sales`, `Profit`, `Stock`, `T.Purchases` | as written | |

- An empty cell stays empty. It is not turned into zero.
- A row under the product list with no `S/N` and name (rows 117–131 in the October workbook) is kept as an
  **unlabelled row** and never interpreted.
- A sheet whose name is not a date, or with no `S/N` heading, is **not read** and is reported. Sheet names never
  create branches, dates or anything else.

## The two outputs

**Product Mapping Review** — one line per product name as it appears in the sheets: the name, pack/size text, when it
was seen, every sales price and purchase price recorded with dates, flags, the proposed unit (only when the sheet
states it plainly), review status, and the Owner's decision.

Flags: name differs between sheets · unit not stated · "is one unit a bottle or a box?" · selling price changed ·
purchase price changed · no selling price.

**Historical Daily Records** — one line per product per day: source file, worksheet, row, business date, the original
cell text, the figures read from it, validation status (Valid / Warning / Error) and import status.

## Exceptions the importer raises

| Exception | When | Who decides | Possible decisions |
|---|---|---|---|
| **Missing dates** | Calendar days between two sheets have no sheet. Lists each product whose closing stock before differs from its opening stock after | Owner or Accountant | Explained with evidence · Accepted as incomplete · Records rejected |
| **Stock does not carry forward** | Next day's opening differs from the previous day's closing, with no gap | Owner or Accountant | same |
| **Same name, different prices** | One name on two lines of a sheet (Henken) | **Owner** | Same product, legitimate price change · Different sizes or variants · Different price types · Data-entry error |
| **Unusual price change** | A price falls by more than half, more than doubles, a purchase price rises above the sales price or drops below a fifth of it (MAGIC MOMENT) | **Owner** | Recorded value is correct · Data-entry error (the correct value must be entered) · The column holds a different price type · Other |
| **Missing price** | The latest sheet has no sales price (mkwawa) | **Owner** | Selling price approved · Not sold, keep history only |
| **Figures do not add up** | opening + bought − sold ≠ closing, or sold × sales price ≠ total sales | Owner or Accountant | Explained · Accepted as incomplete · Rejected |
| **Unreadable values** | A number cell holds text | Owner or Accountant | same |
| **Same record with different values** | A later workbook has a line already stored, with different figures | Owner or Accountant | same |
| **Sheet not read** | Sheet name is not a date, or headings are missing | Owner or Accountant | same |

What the importer never does: fill in a missing day, estimate or interpolate a quantity, assume an unexplained
difference was a sale, merge two names, prefer one price over another, correct a value, or invent a price.

### What must be confirmed before an exception can be closed

| Exception | Mandatory before it is marked resolved |
|---|---|
| Same name, different prices | For **each** line: confirmed product name, package size, approved price, **price type**, **effective date** |
| Unusual price change | The **price type** the figure represents, the amount that applies, and its effective date. This applies even when the recorded value is confirmed as correct |
| Missing price → "Selling price approved" | Confirmed product name, its **unit or package size**, and the approved selling price with effective date |
| Explained with evidence | A reference to where the evidence is |
| Any decision | A note |

Confirmed identities and approved prices are stored separately from the original values, which never change.
A decision that is reopened and decided again leaves both sets of approved prices on record.

## Statuses

| Thing | Statuses | Moves |
|---|---|---|
| Historical record | **Imported** (stored, no open exception) · **Pending review** (an exception touching it is open) · **Approved** (those exceptions are decided) · **Rejected** (a reviewer rejected it) | Changes automatically when an exception is decided or reopened. A separate **Incomplete** mark stays on while an exception is open, rejected, or was accepted without explanation |
| Exception | Pending review → Approved or Rejected | A decision can be reopened by the Owner, with a reason. The earlier decision stays in the audit trail |
| Source product (mapping) | Pending review → Approved (mapped to a live product) or Rejected (history only) | Owner only. Blocked while a price question about that product is open |
| Unlabelled row | Pending review → Classified (approved) · Excluded (rejected) · Needs investigation | Owner or Accountant. Excluding, and changing an earlier decision, need a reason. Every decision is kept in the row's decision history with reviewer and time |

## Permissions

| Action | Cashier | Accountant | Owner |
|---|---|---|---|
| See anything historical | ✘ | ✔ | ✔ |
| Dry run (check a file) | ✘ | ✔ | ✔ |
| Import a file | ✘ | ✘ | ✔ |
| Add an explanation with evidence | ✘ | ✔ | ✔ |
| Decide missing dates, arithmetic, conflicts; classify unlabelled rows | ✘ | ✔ | ✔ |
| Decide product identity and prices; map products | ✘ | ✘ | ✔ |
| Reopen a decision; accept the history as reconciled | ✘ | ✘ | ✔ |
| Download the exception report | ✘ | ✔ | ✔ |

## How to import

1. **Take a database backup** ([BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md)).
2. Sign in as Owner → **Excel History** → choose the workbook → **Step 1 · Check the file**. Nothing is saved.
   Read the preview: sheets read, new lines, lines already stored, conflicts, problems, exceptions.
   **Download this preview as an exception report** to read or share it before deciding to import.
3. Tick the two boxes (backup taken, preview read) → **Step 2 · Import as historical reference**.
4. Work through the tabs: **Exceptions**, **Product Mapping Review**, **Unlabelled rows**.
5. Download the **exception report** at any time for discussion.
6. When nothing is waiting, the Owner may **Accept as reconciled**, with a note. Any later import or reopened
   decision withdraws that status until it is accepted again.

## Safe to repeat; supplementary workbooks

Each line has a stable key (date + line number + name). Importing the same file again adds nothing. A different
workbook is treated as a supplementary source:

- lines not yet stored are added;
- lines already stored with the same figures are skipped;
- lines already stored with **different** figures are **not** imported; the stored record is kept and a
  "same record with different values" exception is raised;
- if the new sheets fill a gap so that stock now carries forward, the "missing dates" exception is closed
  automatically, with a note naming the file.

## Mapping a source product to the live product list

The Owner confirms the name and the unit it is counted and sold in (required; never guessed), and either picks an
existing product or creates a new one with an approved selling price. Without an approved selling price the product
is created **switched off** and cannot be sold or activated. Mapping never gives a product stock.

## Go-live and the history review

Reviewing the old records and building or testing the application go on side by side. Go-live does **not** wait
for missing dates, product mappings or unlabelled rows to be settled, and going live says nothing about the past:
the history stays NOT RECONCILED until the Owner accepts it.

Go-live **is** refused while any question about what a product is or what it costs is still open, alongside the
other requirements: products with selling prices, payment methods, an Owner-approved physical count of every
product on sale, a cashier account, and the Owner's approval of the opening balance.

## Opening stock (separate from all of the above)

Before go-live: **Stock** → enter the count date, who counted, and the counted quantity of every product on sale
(zero is a valid count). Where a product is mapped, the last Excel closing figure is shown beside the count **for
comparison only**, with the difference. Nothing is stock until the Owner approves the sheet; approval posts one
opening movement per product and records its reference on the sheet. Go-live is blocked until every product on sale
has an approved count.

## What the October 2026 workbook contains (dry run, 12 Oct 2026)

31 sheets (31 Aug, then 10 Sep – 9 Oct), 3,503 product lines, 129 source product names over 113 line numbers,
434 unlabelled rows (rows 117–123 and 125–131), no unreadable values and no lines that fail to add up.
Sales as written total TZS 50,395,300 (unverified). Five material exceptions:

1. No sheets for 1–9 September; the stock of 57 products changes across the gap.
2. "Henken" on lines 4 and 5 with sales prices 3,500 and 4,000.
3. "black and whithe" on two lines with different prices (renamed "kubwa" and "ndogo" on 9 Oct).
4. "MAGIC MOMENT" purchase price 9,000 → 1,290 on 30 September.
5. "mkwawa" has no sales price on any sheet.

Of the unlabelled rows, rows 117 and 118 (and row 119 on some sheets) equal column totals; the rest match nothing.

## Adding the workbook's products to the product table (13 Oct 2026)

At the Owner's request the products on the latest imported sheet (9 Oct 2026) were added to the product table with

    python manage.py add_excel_products --owner <owner username>            (shows what would happen; saves nothing)
    python manage.py add_excel_products --owner <owner username> --commit

It uses only what the sheet states: the name as written, the unit where the sheet names one (bottle, crate, carton),
the size from the description column, and that sheet's sales and purchase prices. It creates **no stock**; stock on
hand still comes only from an approved opening count. Each product is recorded as a Product Mapping decision and in
the audit history. Running it again adds nothing twice. A backup was taken first
(`C:\MeribaBackups\meriba_lsms_2026-10-13_before_adding_excel_products.dump`).

Result on the shop database: 70 products created (39 Bottle with the 2 already there, 21 Crate, 12 Carton),
2 matched to products that already existed (Konyagi ndogo, Konyagi Kubwa), 41 left for the Owner:

| Left for the Owner | Lines | Why |
|---|---|---|
| The sheet shows only "Box (n)" | 37 | It does not say whether one unit sold is a bottle, a pack or the whole box (question X1 in OPEN_DECISIONS.md) |
| Hajos wine dum | 1 | The sheet says "5lts", not a unit |
| Henken (two lines, 3,500 and 4,000) | 2 | Open price question in Excel History |
| MAGIC MOMENT kati | 1 | Open price question: purchase price 9,000 then 1,290 |

"mkwawa" was created but is not on sale: the workbook has no price for it. (A price of 12,000 was entered later.)

### The "Box (n)" lines and Hajos (14 Oct 2026)

The Owner answered question X1: on a line marked only "BOX(6)", "BOX(12)", "BOX(24)" or "BOX(30)", one unit is one
bottle or can; on a line marked "Box (4)", one unit is one pack. Hajos wine dum is one 5-litre container. The answer is
given to the same command per S/N; it is used only where the sheet states no unit:

    python manage.py add_excel_products --owner <owner username> --unit 3=Pack --unit 11=Bottle --size 20=5000ml ... --commit

Backup first: `C:\MeribaBackups\meriba_lsms_2026-10-14_before_adding_box_products.dump`. Result: 38 products created
(12 Pack: S/N 3, 6, 8, 9, 10, 41, 42, 60, 72, 73, 87, 90; 26 Bottle, including Hajos at 5,000 ml). Bottles per pack is
not set, because the sheet does not say what a pack holds. The product table now has 110 products. Still left for the
Owner: Henken (lines 4 and 5) and MAGIC MOMENT kati, the open price questions in Excel History.

### Henken (22 Oct 2026)

The Owner decided the Henken price question (H3 in OPEN_DECISIONS.md): the two lines are different sizes of Henken,
both sold by the bottle. The exception was closed as "Different package sizes or variants", with the selling and
purchase prices of each line approved from 31 Aug 2026, and each line was mapped to a new product:

| S/No | Product | Size | Sells | Buys |
|---|---|---|---|---|
| 4 | Henken ndogo | 330ml | 3,500 | 2,917 |
| 5 | Henken kubwa | 500ml | 4,000 | 3,125 |

No stock was created. The product table now has 112 products. Still left for the Owner: MAGIC MOMENT kati.

### MAGIC MOMENT kati (22 Oct 2026)

The Owner decided the MAGIC MOMENT price question (H4 in OPEN_DECISIONS.md): the purchase price of 1,290 written from
30 Sep 2026 is a typing error, and 9,000 applies. The exception was closed as "Data-entry error", with selling 13,000
and purchase 9,000 approved from 31 Aug 2026. The sheets keep 1,290 exactly as written. Line 83 ("MAGIC MOMENT" until
8 Oct, "MAGIC MOMENT kati" on 9 Oct) was mapped to one new product: S/No 83, MAGIC MOMENT kati, Bottle, 375mls,
sells 13,000, buys 9,000. No stock was created. The product table now has 113 products, one for every line number
(S/No 1 to 113), and no price question from the workbook is left open. Still waiting in the Product Mapping Review:
15 older names of lines renamed on 9 Oct (for example "grants", "Hennesy kt"), whose line already has a product.
