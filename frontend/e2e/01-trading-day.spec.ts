import fs from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * One trading day, start to finish, through the real screens:
 * Owner sets the shop up and goes live -> Cashier sells -> Owner receives stock, refunds and records an expense ->
 * Cashier closes -> Owner reviews the closing, reads reports, checks audit, settings and the Excel preview.
 * The tests run in order and share the same throwaway database.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { username: process.env.E2E_OWNER ?? "e2e_owner", password: process.env.E2E_OWNER_PASSWORD ?? "" };
const CASHIER = { username: "asha", first: "Start-Day-2026", own: "Shop-Till-7781" };
const WORKBOOK = process.env.MERIBA_WORKBOOK ?? "";
const today = new Date().toISOString().slice(0, 10);

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/** Go to a screen from the menu and wait until that screen is actually showing.
 *  Without the wait, a check can run against the screen being left, which is still on display for a moment. */
async function openScreen(page: Page, link: string, heading: string | RegExp) {
  await page.getByRole("link", { name: link, exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

function acceptDialogs(page: Page) {
  page.on("dialog", (dialog) => dialog.accept());
}

test("sign-in refuses a wrong password in plain words", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/); // not signed in: sent to the sign-in page
  await page.getByLabel("Username").fill(OWNER.username);
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("The username or password is not correct");
});

test("owner sets up the shop and goes live", async ({ page }) => {
  acceptDialogs(page);
  await signIn(page, OWNER.username, OWNER.password);
  await expect(page.getByText("The shop is not ready for selling yet")).toBeVisible();

  // Products
  await page.getByRole("link", { name: "Products", exact: true }).first().click();
  for (const p of [
    { name: "Konyagi ndogo", volume: "200", unit: "Bottle", bottles: "", price: "4500", cost: "3750" },
    { name: "Safari Kubwa", volume: "500", unit: "Crate", bottles: "25", price: "36000", cost: "34000" },
  ]) {
    await page.getByRole("button", { name: "+ Add Product" }).click();
    const form = page.getByRole("dialog");
    // typed key by key, as a person would: the cursor must stay in the box while the window re-draws
    await form.getByLabel("Product Name").click();
    await page.keyboard.type(p.name, { delay: 15 });
    await expect(form.getByLabel("Product Name")).toHaveValue(p.name);
    // Unit is a fixed list, not free text
    await expect(form.getByLabel("Unit", { exact: true }).locator("option")).toHaveText(["Bottle", "Crate", "Carton", "Box", "Pack"]);
    await form.getByLabel("Unit", { exact: true }).selectOption(p.unit);
    await form.getByLabel("Volume (ml)").fill(p.volume);
    if (p.bottles) await form.getByLabel("Bottles in one crate").fill(p.bottles);
    await form.getByLabel("Selling Price (TZS)").fill(p.price);
    await form.getByLabel("Purchase Price (TZS)").fill(p.cost);
    await form.getByRole("button", { name: "Save Product" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("cell", { name: new RegExp(p.name) })).toBeVisible();
  }
  // the table shows the agreed columns, in the agreed order
  await expect(page.getByRole("columnheader")).toHaveText([
    /^Product( [▲▼])?$/, /^Unit/, /^Volume \(ml\)/, /^Total Stock/, /^Sales/, /^Closing Stock/, /^Purchase Price/, /^Selling Price/,
    /^Total Sales/, /^Profit/, /^Stock/, /^Actions/]);
  const safariRow = page.getByRole("row").filter({ hasText: "Safari Kubwa" });
  await expect(safariRow).toContainText("Crate");
  await expect(safariRow).toContainText("25 bottles");
  await expect(safariRow).toContainText("500 ml");
  await expect(safariRow).toContainText("TZS 34,000"); // the purchase price entered, as on the Excel sheet
  // a product cannot be put on sale without a price
  await page.getByRole("button", { name: "+ Add Product" }).click();
  await page.getByRole("dialog").getByLabel("Product Name").fill("mkwawa");
  await page.getByRole("button", { name: "Save Product" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("cannot be on sale without one");
  await page.getByRole("button", { name: "Cancel" }).click();

  // Cashier account
  await page.getByRole("link", { name: "Users", exact: true }).first().click();
  await page.getByRole("button", { name: "+ Add User" }).click();
  await page.getByLabel("Username").fill(CASHIER.username);
  await page.getByLabel("Full name").fill("Asha Juma");
  await page.getByRole("radio", { name: /^Cashier/ }).check();
  await page.getByLabel("First password").fill(CASHIER.first);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Asha Juma" })).toBeVisible();

  // Physical count sheet, then the Owner's approval
  await page.getByRole("link", { name: "Stock", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Opening Stock Count" })).toBeVisible();
  await page.getByLabel("Counted by").fill("Juma");
  await page.getByLabel("Quantity counted for Konyagi ndogo 200ml").fill("48");
  await page.getByLabel("Quantity counted for Safari Kubwa").fill("10");
  await page.getByRole("button", { name: /Save 2 to the count sheet/ }).click();
  await expect(page.getByText("Stock does not change until the Owner approves")).toBeVisible();
  await page.getByRole("button", { name: "Approve the count" }).click();
  await expect(page.getByText("Count sheet approved")).toBeVisible();
  await expect(page.getByText("Opening stock is approved for every product on sale")).toBeVisible();

  // Go live: zero needs its own confirmation
  await page.getByRole("link", { name: "Setup", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "First-time Setup" })).toBeVisible();
  const goLive = page.getByRole("button", { name: "Approve and start live selling" });
  await page.getByLabel("Verified balance (TZS)").fill("0");
  await page.getByLabel("Correct as of (cutover date)").fill(today);
  await page.getByLabel(/I approve the products/).check();
  await expect(goLive).toBeDisabled(); // TZS 0 not yet confirmed as a new baseline
  await page.getByLabel(/genuinely new starting point/).check();
  await expect(goLive).toBeEnabled();
  await goLive.click();
  await expect(page.getByText(/The shop went live/)).toBeVisible();
});

test("cashier chooses a password, starts the day and sells", async ({ page }) => {
  await signIn(page, CASHIER.username, CASHIER.first);
  await expect(page).toHaveURL(/\/change-password$/); // a password set by someone else must be changed first
  await page.getByLabel("Current password").fill(CASHIER.first);
  await page.getByLabel("New password", { exact: true }).fill(CASHIER.own);
  await page.getByLabel("New password again").fill(CASHIER.own);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("heading", { name: /Hello, Asha Juma/ })).toBeVisible();

  // the cashier sees only daily selling
  const menu = page.getByRole("navigation", { name: "Main menu" });
  await expect(menu.getByRole("link")).toHaveText(["Home", "Today's Sales", "Daily Sheet", "Close Day"]);
  await page.goto("/users");
  await expect(page.getByText("This page is not available for your account")).toBeVisible();
  await page.goto("/");

  await page.getByRole("link", { name: "Start Day" }).click();
  await expect(page.getByText("Opening cumulative sales balance")).toBeVisible();
  await page.getByLabel("Cash float in the drawer (TZS)").fill("100000");
  await page.getByRole("button", { name: /Start Day with TZS 100,000 float/ }).click();
  await expect(page).toHaveURL(/\/sheet$/);

  // Sales are typed on the Daily Sheet, the only place they are entered
  await expect(page.getByRole("heading", { level: 1, name: "Daily Sheet" })).toBeVisible();
  const konyagi = page.getByRole("row").filter({ hasText: "Konyagi ndogo 200ml" });
  const entry = page.getByRole("dialog", { name: "Save this sale" });
  const saved = page.getByRole("dialog", { name: "Sale saved" });

  // Sale 1: two bottles, cash with change
  await page.getByLabel("Quantity of Konyagi ndogo 200ml sold").fill("2");
  await page.getByRole("button", { name: "Save sale of Konyagi ndogo 200ml" }).click();
  await expect(entry.getByTestId("sale-total")).toHaveText("TZS 9,000");
  await entry.getByLabel("Cash received (TZS)").fill("10000");
  await expect(entry.getByText("Change to give back")).toBeVisible();
  await entry.getByRole("button", { name: /^Save sale/ }).click();
  await expect(saved).toContainText(/MB-\d{8}-0001/);
  await expect(saved).toContainText("Give change: TZS 1,000");
  await expect(saved.getByRole("button", { name: "Print Receipt" })).toBeVisible();
  await saved.getByRole("button", { name: "Back to the sheet" }).click();
  // the sheet has worked out the rest: Sales 2, Closing stock 48 - 2
  await expect(konyagi.getByRole("cell").nth(5)).toHaveText("2");
  await expect(konyagi.getByRole("cell").nth(6)).toHaveText("46");

  // Sale 2: one crate, part cash and part mobile money
  await page.getByLabel("Find a product on the sheet").fill("safari");
  await expect(konyagi).toHaveCount(0);
  await page.getByLabel(/Quantity of Safari Kubwa.* sold/).fill("1");
  await page.getByRole("button", { name: /Save sale of Safari Kubwa/ }).click();
  await entry.getByRole("button", { name: "Customer is paying with more than one method" }).click();
  await entry.getByLabel("Cash received (TZS)").fill("6000");
  await expect(entry.getByText(/Still to pay: TZS 30,000/)).toBeVisible();
  await expect(entry.getByRole("button", { name: /^Save sale/ })).toBeDisabled();
  await entry.getByLabel("Mobile Money amount (TZS)").fill("30000");
  await entry.getByRole("button", { name: /^Save sale/ }).click();
  await expect(saved).toContainText(/MB-\d{8}-0002/);
  await saved.getByRole("button", { name: "Back to the sheet" }).click();
  await page.getByLabel("Find a product on the sheet").fill("");

  // Sale 3: one bottle, exact cash (the Owner will cancel this one later)
  await page.getByLabel("Quantity of Konyagi ndogo 200ml sold").fill("1");
  await page.getByRole("button", { name: "Save sale of Konyagi ndogo 200ml" }).click();
  await entry.getByRole("button", { name: /^Save sale/ }).click();
  await expect(saved).toContainText(/MB-\d{8}-0003/);
  await saved.getByRole("button", { name: "Back to the sheet" }).click();
  await expect(konyagi.getByRole("cell").nth(5)).toHaveText("3");

  await openScreen(page, "Today's Sales", "Today's Sales");
  await expect(page.getByRole("row").filter({ hasText: /MB-\d{8}-000/ })).toHaveCount(3);
  // a cashier can look at a receipt but cannot cancel or refund
  await page.getByRole("row").filter({ hasText: /-0003/ }).getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Print Receipt" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Cancel this sale|Refund items/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("owner receives stock, refunds an item and records an expense during the day", async ({ page }) => {
  acceptDialogs(page);
  await signIn(page, OWNER.username, OWNER.password);

  await page.getByRole("link", { name: "Receive Stock" }).click();
  await page.getByLabel("Add a product that was delivered").fill("kony");
  await page.getByRole("button", { name: /Konyagi ndogo 200ml/ }).click();
  await page.getByLabel("Quantity received of Konyagi ndogo").fill("24");
  await page.getByRole("button", { name: /Save delivery of 1 product/ }).click();
  await expect(page.getByText(/Delivery saved/)).toBeVisible();

  // The Owner opens a till of their own, so two drawers are open at once
  await openScreen(page, "Home", /Hello, Test Owner/);
  await page.getByRole("link", { name: "Start Day" }).click();
  await page.getByRole("button", { name: /Start Day with TZS 0 float/ }).click();
  await expect(page).toHaveURL(/\/sheet$/);

  // Refund one bottle in cash: with two drawers open, the screen must ask which one
  await openScreen(page, "Today's Sales", "Sales");
  await page.getByRole("row").filter({ hasText: /-0001/ }).getByRole("button", { name: "View" }).click();
  await page.getByRole("button", { name: "Refund items…" }).click();
  await page.getByLabel("Quantity of Konyagi ndogo 200ml to refund").fill("1");
  await page.getByRole("radio", { name: "Cash" }).click();
  await page.getByLabel("Reason for the refund").fill("Bottle was leaking");
  await page.getByRole("button", { name: /Refund TZS 4,500/ }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Choose which cashier's drawer");
  await page.getByLabel("Which drawer is the cash taken from?").selectOption({ label: "Asha Juma's drawer" });
  await page.getByRole("button", { name: /Refund TZS 4,500/ }).click();
  await expect(page.getByRole("dialog").getByText(/Refund of TZS 4,500 by Cash/)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // Cancel (void) the third sale, with a reason
  await page.getByRole("row").filter({ hasText: /-0003/ }).getByRole("button", { name: "View" }).click();
  await page.getByRole("button", { name: "Cancel this sale…" }).click();
  await page.getByRole("button", { name: "Yes, cancel this sale" }).click();
  await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: "reason" })).toBeVisible(); // not without a reason
  await page.getByLabel("Reason for cancelling").click();
  await page.keyboard.type("Rung up by mistake", { delay: 5 });
  await page.getByRole("button", { name: "Yes, cancel this sale" }).click();
  await expect(page.getByRole("dialog").getByText(/Cancelled by Test Owner\. Reason: Rung up by mistake/)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: /-0003/ })).toContainText("Cancelled");

  // The Owner closes their own till (no sales, nothing in it); the day stays open for the cashier
  await openScreen(page, "Close Day", "Close Day");
  await page.getByLabel("Cash you counted (TZS)").fill("0");
  await page.getByRole("button", { name: "Review and Close…" }).click();
  await page.getByRole("button", { name: "Yes, close my shift" }).click();
  await expect(page.getByText(/is closed\. No more sales can be added/)).toBeVisible();

  await openScreen(page, "Expenses", "Expenses");
  await page.getByLabel("Category").selectOption("Transport");
  await page.getByLabel("Amount (TZS)").fill("1000");
  await page.getByLabel("What was it for?").fill("Boda boda to the depot");
  await page.getByLabel("How was it paid?").selectOption({ label: "Cash" });
  await page.getByLabel("Where did the cash come from?").selectOption({ label: "Asha Juma's drawer (open now)" });
  await page.getByRole("button", { name: "Save Expense" }).click();
  await expect(page.getByText("Expense of TZS 1,000 saved.")).toBeVisible();

  // Stock adjustment after go-live: a crate was broken, so the count is 8 not 9
  await openScreen(page, "Stock", "Stock");
  await page.getByLabel("Quantity counted for Safari Kubwa").fill("8");
  await page.getByRole("button", { name: /Save 1 counted quantity/ }).click();
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("Write the reason"); // not without a reason
  await page.getByLabel("Reason for the change").fill("One crate broken in the store room");
  await page.getByRole("button", { name: /Save 1 counted quantity/ }).click();
  await expect(page.getByText("Saved the counted quantity for 1 product(s).")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "One crate broken in the store room" })).toContainText("-1");

  // Edit a product's price (confirmed), and check stock: 48 counted - 3 sold + 1 cancelled + 24 received + 1 returned = 71
  await openScreen(page, "Products", "Products");
  // The product table for today. Konyagi: counted 48 + delivered 24 + returned 1 = 73 in; 2 sold (the cancelled sale
  // is not a sale); 71 left. Sales 9,000 less the 4,500 refund; cost 3,750 a bottle; gross profit 750.
  const konyagiRow = page.getByRole("row").filter({ hasText: "Konyagi ndogo" });
  await expect(konyagiRow.getByRole("cell")).toHaveText([
    "Konyagi ndogo", "Bottle", "200 ml", "73", "2", "71", "TZS 3,750", "TZS 4,500", "TZS 4,500", "TZS 750", "71", /Details/]);
  // Safari: 10 crates counted, 1 sold, 1 broken, 8 left; sold for 36,000, cost 34,000
  await expect(page.getByRole("row").filter({ hasText: "Safari Kubwa" }).getByRole("cell")).toHaveText([
    "Safari Kubwa", /^Crate/, "500 ml", "10", "1", "8", "TZS 34,000", "TZS 36,000", "TZS 36,000", "TZS 2,000", "8", /Details/]);
  await expect(page.getByRole("row").filter({ hasText: /^Total for all 2 products/ })).toContainText("TZS 40,500");
  // sorting by a column
  await page.getByRole("button", { name: /^Total Sales/ }).click();
  await expect(page.getByRole("row").nth(1)).toContainText("Konyagi ndogo"); // smallest first
  await page.getByRole("button", { name: /^Total Sales/ }).click();
  await expect(page.getByRole("row").nth(1)).toContainText("Safari Kubwa"); // largest first
  // searching
  await page.getByLabel("Search").fill("kony");
  await expect(page.getByRole("row").filter({ hasText: "Safari Kubwa" })).toHaveCount(0);
  await page.getByLabel("Search").fill("");
  await expect(page.getByRole("row").filter({ hasText: "Safari Kubwa" })).toHaveCount(1);
  // export
  const tableDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: /Download for Excel/ }).click();
  expect((await tableDownload).suggestedFilename()).toMatch(/^meriba_products_.*\.csv$/);

  // Product details: the day's figures, package configuration, movement and purchase history
  await konyagiRow.getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog");
  await expect(details.getByRole("row").filter({ hasText: "= Total Stock" })).toContainText("73");
  await expect(details.getByRole("row").filter({ hasText: "= Closing Stock" })).toContainText("71");
  await expect(details.getByRole("row").filter({ hasText: "Gross profit" })).toContainText("TZS 750");
  await expect(details).toContainText("each bottle is 200 ml");
  await expect(details.getByRole("row").filter({ hasText: "Customer return" })).toContainText("+1");
  await expect(details.getByRole("row").filter({ hasText: "Sale cancelled" })).toContainText("+1");
  // add a package: one crate holds 12 bottles. It cannot be sold until the Owner verifies the figure.
  await details.getByLabel("Package to add").selectOption("Crate");
  await details.getByLabel("How many bottles it holds").fill("12");
  await details.getByLabel("Selling price of the package").fill("50000");
  await details.getByRole("button", { name: "Add package" }).click();
  const crate = details.getByRole("row").filter({ hasText: "12 bottle(s)" });
  await expect(crate).toContainText("Waiting for the Owner to verify");
  await crate.getByRole("button", { name: "Verify" }).click();
  await expect(crate).toContainText("Verified");
  await expect(details).toContainText("Added package to 'Konyagi ndogo 200ml': 1 Crate = 12 Bottle(s)");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // Edit a product's price (confirmed)
  await page.getByRole("row").filter({ hasText: "Safari Kubwa" }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog").getByLabel("Selling Price (TZS)").fill("37000");
  await page.getByRole("button", { name: "Save Product" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const safari = page.getByRole("row").filter({ hasText: "Safari Kubwa" });
  await expect(safari).toContainText("TZS 37,000");
  await expect(safari).toContainText("8");

  // Add a user, then switch the account off (accounts are never deleted)
  await openScreen(page, "Users", "Users");
  await page.getByRole("button", { name: "+ Add User" }).click();
  await page.getByLabel("Username").fill("juma");
  await page.getByLabel("Full name").fill("Juma Ali");
  await page.getByLabel("First password").fill("Short1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(/too short/i); // weak password refused, in plain words
  await page.getByLabel("First password").fill("Count-Stock-55");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const juma = page.getByRole("row").filter({ hasText: "Juma Ali" });
  await juma.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel(/^Active/).uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(juma).toContainText("Switched off");
});

test("cashier closes the day with the cash count", async ({ page }) => {
  await signIn(page, CASHIER.username, CASHIER.own);

  // The Daily Sheet, as the cashier sees it: no purchase price or profit, and a box to type the quantity sold
  await openScreen(page, "Daily Sheet", "Daily Sheet");
  await expect(page.getByRole("columnheader")).toHaveText([
    "S/N", "Details", "Opening stock", "Add Purchases", "Total stock", "Sales", "Closing stock", "Sales price", "Total Sales", "Stock", "Other", "Add to Sales"]);
  await expect(page.getByRole("button", { name: "Previous sheet" })).toHaveCount(0);
  const konyagi = page.getByRole("row").filter({ hasText: "Konyagi ndogo 200ml" });
  const entry = page.getByRole("dialog", { name: "Save this sale" });
  const saved = page.getByRole("dialog", { name: "Sale saved" });
  await expect(konyagi.getByRole("cell").nth(6)).toHaveText("71");

  // One more sale first: a whole crate of Konyagi, the package the Owner configured and verified (12 bottles)
  await page.getByLabel("Quantity of Konyagi ndogo 200ml sold").fill("1");
  await page.getByRole("button", { name: "Save sale of Konyagi ndogo 200ml" }).click();
  await entry.getByLabel("Sold as").selectOption({ label: "Crate of 12 · TZS 50,000" });
  await expect(entry.getByTestId("sale-total")).toHaveText("TZS 50,000");
  await entry.getByRole("button", { name: /^Save sale/ }).click();
  await expect(saved).toContainText("1 Crate x 50,000");
  await saved.getByRole("button", { name: "Back to the sheet" }).click();
  // the sheet counts the crate as 12 bottles: Sales 2 -> 14, Closing stock 71 -> 59
  await expect(konyagi.getByRole("cell").nth(5)).toHaveText("14");
  await expect(konyagi.getByRole("cell").nth(6)).toHaveText("59");

  // and one bottle paid by mobile money
  await page.getByLabel("Quantity of Konyagi ndogo 200ml sold").fill("1");
  await page.getByRole("button", { name: "Save sale of Konyagi ndogo 200ml" }).click();
  await expect(entry.getByTestId("sale-total")).toHaveText("TZS 4,500");
  await entry.getByRole("radio", { name: "Mobile Money" }).click();
  await entry.getByRole("button", { name: /^Save sale/ }).click();
  await saved.getByRole("button", { name: "Back to the sheet" }).click();
  await expect(page.getByText(/Saved: 1 Bottle × Konyagi ndogo 200ml, TZS 4,500\. Receipt/)).toBeVisible();
  await expect(konyagi.getByRole("cell").nth(5)).toHaveText("15");
  await expect(konyagi.getByRole("cell").nth(6)).toHaveText("58");

  await page.getByRole("link", { name: "Close Day" }).first().click();
  await expect(page.getByRole("heading", { name: "Close Day" })).toBeVisible();
  // float 100,000 + cash sales 65,000 - cash refund 4,500 - expense 1,000
  await expect(page.getByText("TZS 159,500")).toBeVisible();
  const close = page.getByRole("button", { name: "Review and Close…" });
  await expect(close).toBeDisabled();
  await page.getByLabel("Cash you counted (TZS)").fill("159000");
  await expect(page.getByText("Short by TZS 500")).toBeVisible();
  await expect(close).toBeDisabled(); // a difference needs a note
  await page.getByLabel("Cash you counted (TZS)").fill("159500");
  await expect(page.getByText("No difference")).toBeVisible();
  await close.click();
  await page.getByRole("button", { name: "Yes, close my shift" }).click();
  await expect(page.getByText(/is closed\. No more sales can be added/)).toBeVisible();
  await expect(page.getByText("Closing cumulative sales").locator("..")).toContainText("TZS 95,000"); // 99,500 sold - 4,500 refunded

  // the old New Sale address now leads to the sheet, and a closed day's sheet takes no more sales
  await page.goto("/sale");
  await expect(page).toHaveURL(/\/sheet$/);
  await expect(page.getByText("This day is closed. The sheet is kept as it stood at closing.")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Add to Sales" })).toHaveCount(0);
});

test("owner reviews the closing and reads reports, audit history, settings and help", async ({ page }) => {
  await signIn(page, OWNER.username, OWNER.password);

  await openScreen(page, "Daily Closing", "Daily Closing");
  const shift = page.getByRole("row").filter({ hasText: "Asha Juma" }).first();
  await expect(shift).toContainText("Waiting for payment checks"); // mobile money still to be checked
  await shift.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog");
  await review.getByRole("button", { name: "Approve this shift" }).click();
  await expect(review.getByRole("alert")).toContainText("Mobile Money"); // not until it has been checked
  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "Approve this shift" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Asha Juma" }).first()).toContainText("Reviewed and approved");
  await expect(page.getByRole("row").filter({ hasText: "Closed" }).last()).toContainText("TZS 95,000");

  // The product table after the crate sale: 15 bottles sold (2 singly, a crate of 12, 1 typed on the Daily Sheet), 58 left.
  // Sales 9,000 + 50,000 + 4,500 - 4,500 refunded; cost 14 bottles at 3,750; gross profit 6,500.
  await openScreen(page, "Products", "Products");
  await expect(page.getByRole("row").filter({ hasText: "Konyagi ndogo" }).getByRole("cell")).toHaveText([
    "Konyagi ndogo", "Bottle", "200 ml", "73", "15", "58", "TZS 3,750", "TZS 4,500", "TZS 59,000", "TZS 6,500", "58", /Details/]);

  // The Daily Sheet: the Excel worksheet's columns, in the Excel order, with the Excel sums
  await openScreen(page, "Daily Sheet", "Daily Sheet");
  await expect(page.getByText("This day is closed. The sheet is kept as it stood at closing.")).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveText([
    "S/N", "Details", "Opening stock", "Add Purchases", "Total stock", "Sales", "Closing stock", "Purchase price", "Sales price",
    "Total Sales", "Profit", "Stock", "T.Purchases", "Other"]);
  // Konyagi: 24 bought, 15 sold. Total Sales 15 x 4,500 = 67,500; Profit 15 x 750; Stock 58 x 4,500; T.Purchases 24 x 3,750.
  // The opening count (48) and the returned bottle are not purchases, so they show under "Other" and closing is 58.
  await expect(page.getByRole("row").filter({ hasText: "Konyagi ndogo 200ml" }).getByRole("cell")).toHaveText([
    "1", /^Konyagi ndogo 200ml/, "0", "24", "24", "15", "58", "3,750", "4,500", /^67,500taken 59,000$/, "11,250", "261,000", "90,000", "+49"]);

  await openScreen(page, "Reports", "Reports");
  await expect(page.getByRole("heading", { level: 2, name: "Daily sales and cumulative balance" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Total" })).toContainText("TZS 95,000");
  await page.getByLabel("Report").selectOption({ label: "Stock movement by product" });
  await expect(page.getByRole("heading", { level: 2, name: "Stock movement by product" })).toBeVisible();
  const konyagi = page.getByRole("row").filter({ hasText: "Konyagi ndogo" });
  await expect(konyagi).toContainText("58");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /Download for Excel/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^meriba_stock-daily_.*\.csv$/);

  await openScreen(page, "Audit History", "Audit History");
  await expect(page.getByRole("row").filter({ hasText: "Closed business day" }).first()).toBeVisible();
  await page.getByLabel("Area").selectOption({ label: "Sales, cancellations and refunds" });
  await expect(page.getByRole("row").filter({ hasText: "Refund of 4,500" }).first()).toBeVisible();

  await openScreen(page, "Settings", "Settings");
  await expect(page.getByLabel("Bottom line of the receipt")).not.toHaveValue(""); // the saved settings have loaded
  await page.getByLabel("Bottom line of the receipt").fill("Asante sana. Karibu tena!");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  await openScreen(page, "Help", "Help");
  await page.getByText("The two balances, and why they differ").click();
  await expect(page.getByText(/Mobile money and bank payments are sales but are not cash/)).toBeVisible();

  // Formal correction of the closed day: original figures kept, new closing balance shown
  await openScreen(page, "Daily Closing", "Daily Closing");
  const closedDay = page.getByRole("row").filter({ hasText: "Closed" }).last();
  await closedDay.getByRole("button", { name: "Correct…" }).click();
  const correction = page.getByRole("dialog");
  await correction.getByLabel("By how much (TZS)?").fill("500");
  await expect(correction.getByRole("button", { name: "Record this correction" })).toBeDisabled(); // a reason is required
  await correction.getByLabel("Reason").click();
  await page.keyboard.type("Refund was keyed 500 short on the day", { delay: 5 });
  await expect(correction.getByText(/New closing balance for this day: TZS 94,500/)).toBeVisible();
  await correction.getByRole("button", { name: "Record this correction" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "Closed" }).last()).toContainText("TZS 94,500");
});

test("owner checks the Excel workbook without saving anything", async ({ page }) => {
  test.skip(!WORKBOOK || !fs.existsSync(WORKBOOK), "the shop's workbook is not on this computer");
  await signIn(page, OWNER.username, OWNER.password);
  await page.getByRole("link", { name: "Excel History" }).click();
  await expect(page.getByText("No historical data has been imported.")).toBeVisible();
  await page.getByLabel("Excel workbook (.xlsx)").setInputFiles(WORKBOOK);
  await page.getByRole("button", { name: /Step 1 · Check the file/ }).click();
  await expect(page.getByText(/This is a preview\. Nothing has been saved/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("3,503")).toBeVisible();
  await expect(page.getByRole("table").first()).toContainText("No sheets for 01 Sep to 09 Sep 2026");
  await expect(page.getByRole("table").first()).toContainText("Henken");
  await expect(page.getByRole("button", { name: /Step 2 · Import as historical reference/ })).toBeDisabled(); // backup and preview not confirmed
  await page.reload();
  await expect(page.getByText("No historical data has been imported.")).toBeVisible(); // still nothing stored
});
