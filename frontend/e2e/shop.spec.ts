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
    { name: "Konyagi ndogo", size: "200ml", unit: "Bottle", price: "4500", cost: "3750" },
    { name: "Safari Kubwa", size: "", unit: "Crate", price: "36000", cost: "34000" },
  ]) {
    await page.getByRole("button", { name: "+ Add Product" }).click();
    // typed key by key, as a person would: the cursor must stay in the box while the window re-draws
    await page.getByLabel("Product name").click();
    await page.keyboard.type(p.name, { delay: 15 });
    await expect(page.getByLabel("Product name")).toHaveValue(p.name);
    await page.getByLabel("Size").fill(p.size);
    await page.getByLabel("Sold and counted by").fill(p.unit);
    await page.getByLabel("Selling price (TZS)").fill(p.price);
    await page.getByLabel("Purchase cost (TZS)").fill(p.cost);
    await page.getByRole("button", { name: "Save Product" }).click();
    await expect(page.getByRole("cell", { name: new RegExp(p.name) })).toBeVisible();
  }
  // a product cannot be put on sale without a price
  await page.getByRole("button", { name: "+ Add Product" }).click();
  await page.getByLabel("Product name").fill("mkwawa");
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
  await expect(menu.getByRole("link")).toHaveText(["Home", "New Sale", "Today's Sales", "Close Day"]);
  await page.goto("/users");
  await expect(page.getByText("This page is not available for your account")).toBeVisible();
  await page.goto("/");

  await page.getByRole("link", { name: "Start Day" }).click();
  await expect(page.getByText("Opening cumulative sales balance")).toBeVisible();
  await page.getByLabel("Cash float in the drawer (TZS)").fill("100000");
  await page.getByRole("button", { name: /Start Day with TZS 100,000 float/ }).click();
  await expect(page).toHaveURL(/\/sale$/);

  // Sale 1: two bottles, cash with change
  await page.getByLabel("1. Find the product").fill("kony");
  const konyagi = page.getByRole("button", { name: /Konyagi ndogo 200ml.*in stock/ });
  await konyagi.click();
  await konyagi.click();
  await expect(page.getByTestId("sale-total")).toHaveText("TZS 9,000");
  await page.getByLabel("Cash received (TZS)").fill("10000");
  await expect(page.getByText("Change to give back")).toBeVisible();
  await page.getByRole("button", { name: /Complete Sale/ }).click();
  const saved = page.getByRole("dialog", { name: "Sale saved" });
  await expect(saved).toContainText(/MB-\d{8}-0001/);
  await expect(saved).toContainText("Give change: TZS 1,000");
  await saved.getByRole("button", { name: "Next Sale" }).click();
  await expect(page.getByTestId("sale-total")).toHaveText("TZS 0");

  // Sale 2: one crate, part cash and part mobile money
  await page.getByLabel("1. Find the product").fill("safari");
  await page.getByRole("button", { name: /Safari Kubwa.*in stock/ }).click();
  await page.getByRole("button", { name: "Customer is paying with more than one method" }).click();
  await page.getByLabel("Cash received (TZS)").fill("6000");
  await expect(page.getByText(/Still to pay: TZS 30,000/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Complete Sale/ })).toBeDisabled();
  await page.getByLabel("Mobile Money amount (TZS)").fill("30000");
  await page.getByRole("button", { name: /Complete Sale/ }).click();
  await expect(page.getByRole("dialog", { name: "Sale saved" })).toContainText(/MB-\d{8}-0002/);
  await page.getByRole("button", { name: "Next Sale" }).click();

  // stock on the sale screen has gone down
  await page.getByLabel("1. Find the product").fill("kony");
  await expect(page.getByRole("button", { name: /Konyagi ndogo 200ml.*46 Bottle in stock/ })).toBeVisible();

  await page.getByRole("link", { name: "Today's Sales" }).click();
  await expect(page.getByRole("row").filter({ hasText: /MB-\d{8}-000/ })).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Cancel this sale|Refund items/ })).toHaveCount(0);
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

  await page.getByRole("link", { name: "Today's Sales" }).click();
  await page.getByRole("row").filter({ hasText: /-0001/ }).getByRole("button", { name: "View" }).click();
  await page.getByRole("button", { name: "Refund items…" }).click();
  await page.getByLabel("Quantity of Konyagi ndogo 200ml to refund").fill("1");
  await page.getByRole("radio", { name: "Cash" }).click();
  await page.getByLabel("Reason for the refund").fill("Bottle was leaking");
  await page.getByRole("button", { name: /Refund TZS 4,500/ }).click();
  await expect(page.getByRole("dialog").getByText(/Refund of TZS 4,500 by Cash/)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("link", { name: "Expenses" }).click();
  await page.getByLabel("Category").selectOption("Transport");
  await page.getByLabel("Amount (TZS)").fill("1000");
  await page.getByLabel("What was it for?").fill("Boda boda to the depot");
  await page.getByLabel("How was it paid?").selectOption({ label: "Cash" });
  await page.getByLabel("Where did the cash come from?").selectOption({ label: "Asha Juma's drawer (open now)" });
  await page.getByRole("button", { name: "Save Expense" }).click();
  await expect(page.getByText("Expense of TZS 1,000 saved.")).toBeVisible();

  // 48 counted - 2 sold + 24 received + 1 returned = 71
  await page.getByRole("link", { name: "Products", exact: true }).first().click();
  await expect(page.getByRole("row").filter({ hasText: "Konyagi ndogo" })).toContainText("71");
});

test("cashier closes the day with the cash count", async ({ page }) => {
  await signIn(page, CASHIER.username, CASHIER.own);
  await page.getByRole("link", { name: "Close Day" }).first().click();
  await expect(page.getByRole("heading", { name: "Close Day" })).toBeVisible();
  // float 100,000 + cash sales 15,000 - cash refund 4,500 - expense 1,000
  await expect(page.getByText("TZS 109,500")).toBeVisible();
  const close = page.getByRole("button", { name: "Review and Close…" });
  await expect(close).toBeDisabled();
  await page.getByLabel("Cash you counted (TZS)").fill("109000");
  await expect(page.getByText("Short by TZS 500")).toBeVisible();
  await expect(close).toBeDisabled(); // a difference needs a note
  await page.getByLabel("Cash you counted (TZS)").fill("109500");
  await expect(page.getByText("No difference")).toBeVisible();
  await close.click();
  await page.getByRole("button", { name: "Yes, close my shift" }).click();
  await expect(page.getByText(/is closed\. No more sales can be added/)).toBeVisible();
  await expect(page.getByText("Closing cumulative sales").locator("..")).toContainText("TZS 40,500"); // 45,000 sold - 4,500 refunded

  await page.goto("/sale");
  await expect(page.getByText("Start your day before making a sale")).toBeVisible();
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
  await expect(page.getByRole("row").filter({ hasText: "Closed" }).last()).toContainText("TZS 40,500");

  await openScreen(page, "Reports", "Reports");
  await expect(page.getByRole("heading", { level: 2, name: "Daily sales and cumulative balance" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Total" })).toContainText("TZS 40,500");
  await page.getByLabel("Report").selectOption({ label: "Stock movement by product" });
  await expect(page.getByRole("heading", { level: 2, name: "Stock movement by product" })).toBeVisible();
  const konyagi = page.getByRole("row").filter({ hasText: "Konyagi ndogo" });
  await expect(konyagi).toContainText("71");
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
  await expect(correction.getByText(/New closing balance for this day: TZS 40,000/)).toBeVisible();
  await correction.getByRole("button", { name: "Record this correction" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "Closed" }).last()).toContainText("TZS 40,000");
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
