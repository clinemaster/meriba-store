# User guide

Open the shop system in the web browser and sign in with **your own** username and password.
Never share your password: every sale and change is recorded under the name that was signed in.

Amounts are in Tanzanian shillings (TZS). You can type `4500` or `4,500`.

Press **Help** at the top of any screen for step-by-step instructions.

Press **← Back**, above the title of any screen, to return to the screen you came from. Searches, filters and the page number you had chosen there are put back as they were.
If there is no earlier screen (you opened the page from its address, a bookmark or a new tab), Back takes you to the screen above it, usually Home. Back never leaves the shop system and never opens a screen your account is not allowed to see.

---

## Cashier

### 1. Start your day
1. Sign in. Press **Start Day**.
2. The screen shows the **opening cumulative sales balance**. This is the running total of all sales up to
   the last closed day. It is not the cash in your drawer.
3. Type the **cash float** — the money you were given to make change. Type `0` if there is none.
4. Press **Start Day**.

If you typed the wrong float, tell the Owner: only the Owner can change it, and only until you close your day.

### 2. Record a sale on the Daily Sheet
The Daily Sheet is the same sheet as in Excel: one row for each product. It is the only place sales are entered.

1. Press **Daily Sheet**. (After Start Day it opens by itself.)
2. Find the product. Typing part of its name in **Find a product on the sheet** shortens the list.
3. In the **Add to Sales** box on that row, type the quantity sold and press **Save**.
4. Check the **Total to pay**. If the product is also sold by the crate, choose it under **Sold as**.
5. Choose how the customer pays: **Cash**, **Mobile Money** or **Bank Transfer**.
   - Cash: type the money the customer handed you. The screen shows the **change to give back**.
     Leave the box empty if they paid the exact amount.
   - Paying partly cash and partly mobile money? Press **Customer is paying with more than one method**
     and type each amount.
6. Press **Save sale**. Wait for the green "Sale saved" message and the receipt number.
7. Press **Share receipt** to send the receipt using the device share menu, or copy and paste it into WhatsApp or a text message. You can also press **Print Receipt**, then **Back to the sheet**.

The sheet has now added the quantity to **Sales** and worked out **Closing stock**, **Total Sales** and **Stock**.
Each entry is for one product. A customer buying three products is three entries.

**If something goes wrong**
- *"Only 3 left in stock"* — you cannot sell more than the system has. Tell the Owner if the shelf shows more.
- *"We could not reach the shop system"* — nothing is lost. Check the connection and press
  **Complete Sale** again. The sale will be saved only once.
- You entered the wrong product and already completed the sale? You cannot change it.
  Tell the Accountant or Owner; they can cancel it with a reason.

### 3. See your sales
Press **Today's Sales**. Press **View** on a completed sale to see, print or share its receipt again.

### 4. Close your day
1. Press **Close Day**.
2. **Step 1** — check your sales total and how much was paid by each method.
3. **Step 2** — count all the cash in the drawer (including the float) and type the amount.
   The screen shows whether it matches. If it does not, count again. If it is still different,
   write a short note saying what you think happened.
4. **Step 3** — press **Review and Close**, check the summary, then **Yes, close my shift**.

After closing you cannot add sales until the next day.

---

## Accountant

You can do everything a cashier can, plus:

### Review a cashier's closing — **Daily Closing**
- **Cashier shifts** lists every shift with sales, cash expected, cash counted and the difference.
- Press **Review** on a shift that is *Waiting for payment checks* or *Cash difference to review*.
  - Compare each **Mobile Money / Bank** total with the phone or bank record, and tick it.
    A reference typed by the cashier is not proof that money arrived.
  - For a cash difference, write how it was resolved.
  - Press **Approve this shift**. You cannot approve a shift you ran yourself.
- If a cashier went home without closing, press **Close it for them** and enter the counted cash.
  A new day cannot start until the old one is closed.

### Cumulative sales balance history — **Daily Closing**, bottom table
Each row is one business day: opening balance, net sales, closing balance.
Closing = opening + net sales. Each day opens with the previous closing balance, unless the Owner changed it; those
days are marked **Changed by Owner**. Days with no trading do not appear.
This is a running total of sales — it is **not** cash, profit or stock.

### Cancel a wrong sale — **Today's Sales → View → Cancel this sale**
Only possible while that cashier's shift is still open. You must give a reason. The items go back into stock,
the amount comes off the day's sales, and the sale stays on record marked "Cancelled".

### Refund or return — **Today's Sales → choose the day → View → Refund items**
Use this when a customer brings something back, including for a sale from an earlier, closed day.
1. Type how many of each item are coming back. Tick **Damaged** if the item cannot go back on the shelf.
2. Choose how the money is given back. Cash comes out of the open cashier's drawer and lowers the cash expected at closing.
3. Write the reason and press **Refund**.

The refund is recorded on **today's** business day and linked to the original sale. The day the sale was made is
never changed. A business day must be open to record a refund.

### Receive a delivery — **Receive Stock**
1. Choose the supplier and type the invoice number, if you have them. Leave them empty if you do not; never guess.
2. Find each product, type the quantity that actually arrived and, if known, the cost for one.
3. Press **Save delivery**. Stock goes up immediately. A saved delivery cannot be edited; fix a mistake with a stock adjustment.

### Upload a delivery from Excel — **Receive Stock → Upload Received Stock** (Owner only)
For a long delivery list. Only the Owner sees this button; the Accountant receives deliveries by typing them as above. Press **Download the template** once; it has the five columns, in this order:
**S/N, Details, Counted by or Unit, Volume (ml), Quantity received**. Only .xlsx files are read (save an old .xls as .xlsx).

1. Choose the file and press **Upload and check**. Nothing changes yet.
2. The top of the preview counts the rows: uploaded, matched, needs review, unmatched, duplicate, excluded and ready,
   and what will be added to stock in each unit (bottles and crates are never added together).
3. The table is in the same order as the Products page; each row keeps its Excel row number. For every row it shows the
   file's details beside the **matched system product**, the unit and volume in the file and in the system, the
   **existing stock**, the **quantity received** and the **projected stock** (existing + received, after any package
   conversion; for example 2 crates of 12 add 24 bottles). A product is matched only when the name is certain
   (capitals and spaces do not matter); S/N is never used to find a product.
   In **Counted by or Unit** you may write the unit (Bottle, Crate, Carton, Box, Pack; CRET is read as Crate) or the
   product's own pack as recorded from the Excel sheet, such as BOX(24) or Box (4). The pack is then read in the
   product's own unit: 20 BOX(24) for Bavaria is 20 bottles, 20 Box (4) for Windhock is 20 packs. A pack written for a
   product with no pack recorded (for example Konyagi ndogo) waits for you to choose the unit in Review.
   Size words may be written in full or short: "Amarula ndogo" finds "Amarula ndg", "Hennesy kubwa" finds "Hennesy kb",
   "1mage kati" finds "1mage kat". This is used only when no product has the exact name, the rest of the name must be
   the same, and the row is marked "Different name from the file" so you can check it.
4. **Match Status**: Matched (green), Duplicate, Needs review, Unmatched or Excluded. A row matched to a product with a
   different name is marked “Different name from the file: check it”.
5. Press **Review** (or **Change** on a matched row) to choose another product, correct the unit, volume or quantity,
   or **Exclude this row**. Corrections are kept with the upload, so you can leave and come back; the file itself is
   not changed. **Back to the file's values** undoes them.
6. If the same product is on several rows, choose **Add together** or **Keep as separate deliveries**.
7. **Confirm and Import Stock** appears only when every row is matched or excluded and every repeated product has a
   choice. Choose the supplier and invoice number if you have them, then confirm. All rows go in together or not at
   all, as ordinary deliveries; each product's current purchase price is recorded as the cost.
8. The summary lists what was added (with the delivery numbers) and what was left out. The import, your corrections
   and the excluded rows are kept in Audit History.

The same file cannot add stock twice: uploading it again shows when it was imported. To import it a second time
(only if it really is a second delivery) the Owner must write why; this is kept in Audit History.

### Expenses — **Expenses**
Record money spent running the shop. If cash was taken from a cashier's drawer, choose that drawer so the closing
count still agrees. Expenses never reduce the cumulative sales balance. A wrong expense is cancelled with a reason, not deleted.

### Reports — **Reports**
Choose a report and the dates. **Download for Excel (CSV)** saves the same figures as a file.
Available: daily sales and cumulative balance, sales by product, sales by cashier, payment methods, daily closing and
cash reconciliation, stock on hand, low stock, stock movement by product, stock received, expenses, and a
sales/purchases/expenses summary.

### Before go-live — **Stock** and **Setup**
**Opening stock count (Stock).** Enter the date of the count and who counted. For every product on sale, type the
quantity physically counted (type 0 if there is none) and press **Save to the count sheet**. You can keep adding to
and correcting the sheet. Where a product has an old Excel figure, it is shown beside your count with the difference,
for comparison only. Nothing becomes stock until the Owner approves the sheet.

**Opening cumulative sales balance (Setup).** Prepare the figure with its cutover date and how you verified it.
Only the Owner can approve it.

### The old Excel sheets — **Excel History**
The Excel records are kept for reference and reviewed here. Nothing on these screens changes live stock or sales.
- **Overview and import**: choose the workbook and press **Step 1 · Check the file** to see what it contains.
  Nothing is saved. Only the Owner can do Step 2.
- **Exceptions**: things the system found that need a decision. Open one to see the source sheet and row.
  You can add an explanation and say where the evidence is. You can decide missing dates and figures that do not
  add up: *Explained with evidence*, *Accepted as incomplete*, or *Records rejected*. Questions about what a product
  is, or its price, are for the Owner.
- **Unlabelled rows**: rows under the product list with no label. Say what a row is, exclude it (with a reason), or
  flag it. They are never treated as sales or payments.
- **Historical Daily Records**: every line as it was written. Lines marked *Incomplete* are affected by an open or
  unexplained exception.
- **Download the exception report** for a meeting with the Owner.

### Products and stock
- **Products**: add a product, change a price (you will be asked to confirm), or switch a product off.
  Products are never deleted.
- **Stock**: if a physical count differs from the system, type the counted quantity and the reason, then save.
  The change is recorded with your name. The bottom table shows the latest stock movements.

---

## Owner

You can do everything above, plus:

### First-time setup — **Setup**
Work through the steps; each shows *Done* or *Not done yet*.
1. **Add your products and selling prices** (Products).
2. **Opening stock** (Stock): every product on sale must be physically counted and typed onto the count sheet
   (the Accountant can prepare it). Check the sheet, then press **Approve the count**. Only then do the counted
   quantities become stock. Press **Reject for a recount** with a note if something looks wrong. To correct a count
   after approving, save another count sheet and approve that. Old Excel figures are never used as stock.
3. **Create at least one cashier account** (Users).
4. **Opening cumulative sales balance**: type the verified running total of sales as of your cutover date, the date,
   and how it was verified. No figure is filled in for you. Type `0` only if cumulative tracking is truly starting
   fresh; you will be asked to confirm that separately.
5. **Approve and go live**: tick the confirmation and press **Approve and start live selling**.

Until you go live, nobody can start a day or sell. After that, the opening balance can only be changed as
described under **Change the float or the opening balance** below, or through a recorded correction.

### Settings — **Settings**
Change the branch name, the top and bottom lines of the receipt, whether a sale may be split between payment
methods, and how much cash difference counts as balanced at closing. Add a payment method, or switch one off;
at least one must stay on.

### Audit History — **Audit History**
Who did what and when. Filter by area, username or dates; press **Details** to see the figures before and after.
Entries cannot be edited or deleted by anyone. The Accountant can see this screen too.

### Users — **Users**
- **Add User**: choose a username, name, role and a first password. The person must choose their own
  password the first time they sign in.
- **Edit**: change the role, or untick **Active** when someone leaves. Accounts are never deleted.
- **New password**: if someone forgets theirs.
- There must always be one active Owner; you cannot remove your own Owner access.

---

### The old Excel sheets — **Excel History**
1. Take a backup, then **Step 1 · Check the file** and read the preview. You can **download the preview as an
   exception report** before deciding. Tick the two boxes and press **Step 2 · Import**.
   The lines are stored as historical reference only. Importing the same file again adds nothing.
2. **Exceptions** that only you can decide:
   - *Same name, different prices* (for example two "Henken" lines): choose whether it is the same product with a price
     change, different sizes, different price types, or a typing error. You can record the confirmed name, the
     approved price, its type and the date it applies from. Both original lines are always kept.
   - *Unusual price change* (for example a cost dropping from 9,000 to 1,290): confirm it is correct, or record the
     correct value. The original figure is never changed.
   - *Missing price*: approve a selling price, or mark the product as not sold.
3. **Product Mapping Review**: for each name found in the sheets, confirm the name and the unit it is sold in, then
   create a product (with an approved selling price) or link it to one that exists. A product with no approved
   selling price is created switched off and cannot be sold. Mapping never gives a product stock.
   These questions cannot be closed with a note alone. The screen tells you what must be filled in: the confirmed
   name, the package size, the approved price, which type of price it is, and the date it applies from.
   **You cannot go live while one of these questions is open.** The rest of the review can wait.
4. When nothing is waiting, **Accept as reconciled** with a note. Until then every screen says **NOT RECONCILED**.
   You can **reopen** any decision with a reason.

### Correct a closed day — **Daily Closing → balance history → Correct…**
For formal accounting corrections only; a normal customer refund should use **Refund items**. Choose whether net sales
go down or up, the amount and a clear reason. The original figures are kept, your name is recorded, and every later
day's opening and closing balance is recalculated.

### Change the float or the opening balance (Owner only)
- **When you start the day**: on **Start Day**, type the float (the cash for change) as usual. To start from a different
  **opening cumulative sales balance**, press **Change the opening balance…**, type the correct figure and the reason.
  This only works for the person who opens the day. If someone has already opened it, use Daily Closing instead.
- **During the day — opening balance**: **Daily Closing → Open day → Change opening balance…**. Type the correct figure and
  the reason. Today's closing balance follows it. Once the day is closed, use **Correct…** instead.
- **During the day — float**: **Daily Closing → Open day → Change float…** next to the cashier's open shift. Cash expected at
  closing follows the new float. Once the shift is closed, its float can no longer be changed.

Every change needs a reason of at least 10 characters. The old figure, the new one, your name and the reason are kept
permanently and shown in **Audit History**. If an earlier closed day is corrected later, your change to the opening
balance is kept.

---

## Not available yet
Purchase orders, and reopening a closed day to add sales. See `REQUIREMENTS_CHECKLIST.md`.

---

## Choosing which columns to show

Tables such as Products, Daily Sheet, Reports, Sales, Expenses, Closing, Users and Audit History have a **Columns (5 of 10)** button.
Tick or untick columns to show or hide them straight away. Keep at least one column showing; the main column (for example the product name) and the buttons at the end of each row always stay.
Press **Show all columns** to go back to the full table.
Your choice is remembered on this computer and browser, separately for each person and each table.
It only changes what you see: nothing is deleted, and **Download for Excel (CSV)** always contains every column.

---

## The Products table (Owner and Accountant)

**Products** shows every product on one line, for the day or dates chosen at the top.
Leave the dates empty for the current business day.

| Column | What it tells you |
|---|---|
| Product | The product's name |
| Unit | Crate, Carton, Box, Bottle or Pack: what it is counted and sold in |
| Volume (ml) | The size of one bottle |
| Total Stock | What you had to sell: opening stock plus anything that came in |
| Sales | How many were sold |
| Closing Stock | What was left: Total Stock less sales and breakages |
| Purchase Price | The average cost of one unit now in stock |
| Selling Price | Today's selling price |
| Total Sales | Money from sales in the period, less refunds |
| Profit | Total Sales less what those goods cost. Rent, wages and other expenses are not taken off here |
| Stock on Hand | What is on the shelf right now |

- Press a **column heading** to sort by it; press again to reverse.
- **Search**, **Unit** and **Show** narrow the list. **Download for Excel** saves what you see.
- Profit says **Not available** when a sale has no purchase cost on record, and **(provisional)** when a delivery was
  entered without a cost. Enter costs on deliveries to avoid both.
- **Details** shows the day's sums, the package configuration, every stock movement, and every delivery with what it
  did to the average cost.

### Adding or changing a product
Press **+ Add Product** or **Edit**. Choose the **Unit** from the list. **Volume (ml)** is the size of one bottle;
leave it empty if it does not apply. For a crate, carton, box or pack you can enter how many bottles one holds.
**Purchase Price** is what one costs from the supplier; cashiers never see it.
Once a product has stock or sales, its unit cannot be changed.

### Stock warnings: green, amber and red
Each product can have two warning levels, set under **Stock warnings** when you add or edit it, in the product's own unit:

| What you see | When |
|---|---|
| ✔ **Healthy** (green) | Above the low-stock level |
| ! **Low stock** (amber) | At or below **Low stock at** |
| ⚠ **Critical stock** (red) | At or below **Critical at** (optional; must be lower than Low stock at) |
| ✕ **Out of stock** (red) | Nothing left |

For example, with Low stock at 10 and Critical at 5: 15 bottles is green, 10 is amber, 5 is red Critical, 0 is
red Out of stock. A level of 0 means no warning. The quantity is always shown beside the word, and the levels only
read the stock the system already holds; they never change how stock is worked out.

The colours appear on Products (Stock on Hand), Stock, Receive Stock, today's Daily Sheet (Closing stock) and the
stock reports. The Home page shows how many products are at each level; press one to see those products. The
**Stock level** filter on Products does the same. When a sale, count or other movement makes a product's stock
worse, the Owner and Accountant see a note in the bottom corner, once. A delivery that puts it right raises no note.
Screens with stock figures refresh by themselves after each change and every 30 seconds.

### Selling the same product by the crate as well as the bottle
1. Open **Details** for the product.
2. Under *Package configuration*, choose the package (for example Crate), how many it holds (for example 12) and its
   selling price, then **Add package**.
3. The **Owner** presses **Verify** to confirm the number. Until then it cannot be sold.
4. On the **Daily Sheet** the cashier chooses the crate under **Sold as** in the sale window. Selling one takes 12 bottles out of stock and adds 12 to the Sales column.

If the number is changed later it must be verified again. Past sales keep the number they were sold with.
## The Daily Sheet (Owner and Accountant)

The Daily Sheet is the worksheet you kept in Excel, one for each day, with the same columns in the same order:
S/N, Details, Opening stock, Add Purchases, Total stock, Sales, Closing stock, Purchase price, Sales price,
Total Sales, Profit, Stock, T.Purchases, and a TOTAL row.

- **Previous sheet / Next sheet** move from day to day, like the tabs at the bottom of the workbook.
- **Days from Excel** (31 August to 9 October) are shown exactly as they were written. A cell marked with a warning
  sign is one the workbook left empty or wrote differently from its own sum. Nothing has been corrected.
- **Days recorded in the system** fill in by themselves: Add Purchases from Receive Stock, Sales from the sales made,
  and Opening stock from the previous day's Closing stock.
- **Closed days** are kept as they stood at closing. Changing a price later does not change an old sheet.
- **Download for Excel (CSV)** gives the sheet with the same headings.

**Typing a sale on the sheet.** See "Record a sale on the Daily Sheet" in the Cashier section. A mistake is put
right in Today's Sales (cancel or refund, with a reason), not by typing over the quantity. The cashier's sheet shows
today only and leaves out Purchase price, Profit and T.Purchases.

**Profit.** Worked out as in Excel: quantity sold × (Sales price − Purchase price on the day of the sale). The purchase
price is kept with each sale and each closed sheet, so changing a price later does not change past profit.

**Empty Profit cells in the Excel workbook (Owner).** Thirteen lines in the workbook have sales but an empty Profit
cell. They are kept empty. Open the list at the bottom of the Daily Sheet screen to review them. To approve a figure,
press **Approve a figure…**, type the figure and the reason. It is recorded beside the cell with your name and the
date; the cell itself stays as the workbook has it.

Add Purchases is still filled from Receive Stock (Owner and Accountant); it cannot be typed on the sheet.
The sums used are listed at the bottom of the screen and in EXCEL_WORKFLOW.md.

### Stock value after the day's sales
Under the sheet (and on the Home page) the Owner and Accountant see the money value of the stock, at selling prices:

    Stock value at the close of the previous day      72,772,500
    Sales of the day                                 −    45,000
    Stock value now                                   72,727,500

A delivery, a return or count, or a selling-price change since the previous day appears on its own line, only when
it happened. The last line is always the sheet's Stock total (Closing stock × Sales price, added up), exactly as in
Excel. On a day when goods were delivered and the same goods sold, the value does not move: the delivery adds what
the sales take off. Bottle and crate quantities are counted separately and are never changed by these amounts.

## S/No on the Products screen

The first column of the Products table is **S/No**, the product's line number as on the Excel sheet, and the table
is listed in that order. Products added from the workbook keep the workbook's number. A product you add yourself
takes the next free number. The Daily Sheet lists products by the same number.
