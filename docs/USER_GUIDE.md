# User guide

Open the shop system in the web browser and sign in with **your own** username and password.
Never share your password: every sale and change is recorded under the name that was signed in.

Amounts are in Tanzanian shillings (TZS). You can type `4500` or `4,500`.

---

## Cashier

### 1. Start your day
1. Sign in. Press **Start Day**.
2. The screen shows the **opening cumulative sales balance**. This is the running total of all sales up to
   the last closed day. It is not the cash in your drawer.
3. Type the **cash float** — the money you were given to make change. Type `0` if there is none.
4. Press **Start Day**.

### 2. Make a sale
1. Press **New Sale**.
2. Type part of the product name (or scan the barcode). Press the product to add it.
   Press it again to add one more, or use **+** and **−**, or type the quantity.
3. Check the **Total to pay**.
4. Choose how the customer pays: **Cash**, **Mobile Money** or **Bank Transfer**.
   - Cash: type the money the customer handed you. The screen shows the **change to give back**.
     Leave the box empty if they paid the exact amount.
   - Paying partly cash and partly mobile money? Press **Customer is paying with more than one method**
     and type each amount.
5. Press **Complete Sale**. Wait for the green "Sale saved" message and the receipt number.
6. Press **Print Receipt** if the customer wants one, then **Next Sale**.

**If something goes wrong**
- *"Only 3 left in stock"* — you cannot sell more than the system has. Tell the Owner if the shelf shows more.
- *"We could not reach the shop system"* — nothing is lost. Check the connection and press
  **Complete Sale** again. The sale will be saved only once.
- You entered the wrong product and already completed the sale? You cannot change it.
  Tell the Accountant or Owner; they can cancel it with a reason.

### 3. See your sales
Press **Today's Sales**. Press **View** on a sale to see or print its receipt again.

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
Closing = opening + net sales. Each day opens with the previous closing balance. Days with no trading do not appear.
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

### Expenses — **Expenses**
Record money spent running the shop. If cash was taken from a cashier's drawer, choose that drawer so the closing
count still agrees. Expenses never reduce the cumulative sales balance. A wrong expense is cancelled with a reason, not deleted.

### Reports — **Reports**
Choose a report and the dates. **Download for Excel (CSV)** saves the same figures as a file.
Available: daily sales and cumulative balance, sales by product, sales by cashier, payment methods, daily closing and
cash reconciliation, stock on hand, low stock, stock movement by product, stock received, expenses, and a
sales/purchases/expenses summary.

### Before go-live — **Setup** and **Stock**
You can enter and correct the opening stock count, and prepare the opening cumulative sales balance with its cutover
date and how you verified it. Only the Owner can approve them.

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
2. **Opening stock** (Stock): count every product physically and type the quantities (the Accountant can do this
   for you). Check it, then on Setup press **Approve the opening stock**. This locks it; **Unlock** lets you fix a count.
3. **Create at least one cashier account** (Users).
4. **Opening cumulative sales balance**: type the verified running total of sales as of your cutover date, the date,
   and how it was verified. No figure is filled in for you. Type `0` only if cumulative tracking is truly starting
   fresh; you will be asked to confirm that separately.
5. **Approve and go live**: tick the confirmation and press **Approve and start live selling**.

Until you go live, nobody can start a day or sell. The opening figures cannot be changed afterwards
except through recorded corrections.

### Users — **Users**
- **Add User**: choose a username, name, role and a first password. The person must choose their own
  password the first time they sign in.
- **Edit**: change the role, or untick **Active** when someone leaves. Accounts are never deleted.
- **New password**: if someone forgets theirs.
- There must always be one active Owner; you cannot remove your own Owner access.

---

### Correct a closed day — **Daily Closing → balance history → Correct…**
For formal accounting corrections only; a normal customer refund should use **Refund items**. Choose whether net sales
go down or up, the amount and a clear reason. The original figures are kept, your name is recorded, and every later
day's opening and closing balance is recalculated.

---

## Not available yet
Purchase orders, screens for shop settings, payment methods and audit history, reopening a closed day to add sales,
importing the old Excel records. See `REQUIREMENTS_CHECKLIST.md`.
