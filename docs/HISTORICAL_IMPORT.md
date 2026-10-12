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
