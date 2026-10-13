import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The Excel History review, through the real screens, on a small workbook that carries every exception the
 * business owner listed: missing dates, the same name at two prices, an unusual price change, a product with
 * no price, and unlabelled rows. Runs after 01-trading-day, on the same throwaway database (the shop is live).
 */
test.describe.configure({ mode: "serial" });

const OWNER = { username: process.env.E2E_OWNER ?? "e2e_owner", password: process.env.E2E_OWNER_PASSWORD ?? "" };
const FIXTURE = process.env.E2E_HISTORY_FIXTURE ?? "";
const NOTE = "Checked with the stock book on 12 October";

const HAS_FIXTURE = !!FIXTURE && fs.existsSync(FIXTURE);
const SESSION = path.join(__dirname, ".fixtures", "owner-session.json");

// Sign in once and reuse the session. The system allows ten sign-in attempts a minute from one computer;
// signing in again for every test would trip that protection on a fast run (as it once did).
test.beforeAll(async ({ browser }, testInfo) => {
  if (!HAS_FIXTURE) return;
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await context.storageState({ path: SESSION });
  await context.close();
});
test.use({ storageState: async ({}, use) => use(fs.existsSync(SESSION) ? SESSION : undefined) });

test.beforeEach(async ({ page }) => {
  test.skip(!HAS_FIXTURE, "the history test workbook was not generated (run scripts/e2e.ps1)");
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.getByRole("link", { name: "Excel History", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Excel History" })).toBeVisible();
});

async function openTab(page: Page, name: RegExp) {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
}

async function review(page: Page, rowText: string | RegExp) {
  await page.getByRole("row").filter({ hasText: rowText }).first().getByRole("button", { name: "Review" }).click();
  return page.getByRole("dialog");
}

test("owner checks the file, downloads the preview report, then imports it as history", async ({ page }) => {
  await expect(page.getByText("No historical data has been imported.")).toBeVisible();
  await page.getByLabel("Excel workbook (.xlsx)").setInputFiles(FIXTURE);
  await page.getByRole("button", { name: /Step 1 · Check the file/ }).click();
  await expect(page.getByText(/This is a preview\. Nothing has been saved/)).toBeVisible();
  await expect(page.getByText("New lines to store").locator("..")).toContainText("24");
  await expect(page.getByText("Exceptions found").locator("..")).toContainText("4");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download this preview as an exception report/ }).click();
  expect((await download).suggestedFilename()).toBe("meriba_import_preview.csv");

  const step2 = page.getByRole("button", { name: /Step 2 · Import as historical reference/ });
  await expect(step2).toBeDisabled();
  await page.getByLabel(/I have taken a backup/).check();
  await expect(step2).toBeDisabled();
  await page.getByLabel(/I have read this preview/).check();
  await step2.click();
  await expect(page.getByText("Imported 24 historical records. Live stock and sales were not changed.")).toBeVisible();
  await expect(page.getByText(/NOT RECONCILED/).first()).toBeVisible();
  await expect(page.getByText("Dates with no sheet:")).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Exceptions \(4\)/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Product Mapping Review \(6\)/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Unlabelled rows \(8\)/ })).toBeVisible();
});

test("owner decides each exception; identity and price questions need the full confirmation", async ({ page }) => {
  await openTab(page, /^Exceptions/);
  await expect(page.getByRole("button", { name: "Review" })).toHaveCount(4);

  // Same name at two prices: a note alone is refused
  let dialog = await review(page, "Henken");
  await expect(dialog).toContainText("3,500");
  await expect(dialog).toContainText("4,000");
  await expect(dialog).toContainText("They have not been merged and no price has been preferred");
  await dialog.getByLabel("Different package sizes or variants").check();
  await dialog.getByLabel("Note explaining the decision").fill("Line 2 is the bottle, line 3 the can");
  await dialog.getByRole("button", { name: "Record the decision" }).click();
  await expect(dialog.getByRole("alert")).toContainText("For each line, confirm the product name and its package size");
  for (const [line, name, size, amount] of [["2", "Heineken bottle", "330ml", "3500"], ["3", "Heineken can", "500ml", "4000"]]) {
    await dialog.getByLabel(`Confirmed name for line ${line}`).fill(name);
    await dialog.getByLabel(`Package size for line ${line}`).fill(size);
    await dialog.getByLabel(`Approved amount for line ${line}`).fill(amount);
  }
  await dialog.getByRole("button", { name: "Record the decision" }).click();
  await expect(dialog.getByRole("alert")).toContainText("the date it applies from"); // effective date still missing
  await dialog.getByLabel("Applies from (effective date)").nth(0).fill("2026-08-31");
  await dialog.getByLabel("Applies from (effective date)").nth(1).fill("2026-08-31");
  await dialog.getByRole("button", { name: "Record the decision" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Review" })).toHaveCount(3);

  // Missing dates: add an explanation with evidence, then accept as incomplete
  dialog = await review(page, /No sheets for/);
  await expect(dialog).toContainText("Nothing has been filled in for these dates");
  await expect(dialog).toContainText("Konyagi ndogo");
  await dialog.getByLabel("Explanation", { exact: true }).fill("Shop was closed for stock-taking that week");
  await dialog.getByLabel("Where the evidence is").fill("Owner's diary, September");
  await dialog.getByRole("button", { name: "Add explanation" }).click();
  await expect(dialog.getByText(/Test Owner.*Shop was closed for stock-taking that week.*Evidence: Owner's diary/)).toBeVisible();
  await dialog.getByLabel("Accepted as incomplete (not verified)").check();
  await dialog.getByLabel("Note explaining the decision").fill(NOTE);
  await dialog.getByRole("button", { name: "Record the decision" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // Unusual price change: even "correct" needs the price type and the amount that applies
  dialog = await review(page, /MAGIC MOMENT/);
  await expect(dialog).toContainText("Purchase price (read as: purchase cost)");
  await expect(dialog).toContainText("Neither has been changed");
  await dialog.getByLabel("The recorded value is correct").check();
  await dialog.getByLabel("Note explaining the decision").fill("Promotional cost from the supplier");
  await dialog.getByRole("button", { name: "Record the decision" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Confirm which price type");
  await dialog.getByLabel("Price type for line 4").selectOption("PURCHASE_COST");
  await dialog.getByLabel("Approved amount for line 4").fill("1290");
  await dialog.getByLabel("Applies from (effective date)").fill("2026-09-12");
  await dialog.getByRole("button", { name: "Record the decision" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // Missing price: not sold
  dialog = await review(page, /mkwawa/);
  await expect(dialog).toContainText("No price has been invented");
  await dialog.getByLabel("Not sold; keep the history only").check();
  await dialog.getByLabel("Note explaining the decision").fill("No longer stocked since August");
  await dialog.getByRole("button", { name: "Record the decision" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Nothing here.")).toBeVisible();

  // Decided exceptions stay on record and can be reopened by the Owner
  await page.getByLabel("Show").selectOption("APPROVED");
  await expect(page.getByRole("button", { name: "View" })).toHaveCount(4);
  await page.getByRole("row").filter({ hasText: "Henken" }).getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog")).toContainText("Different package sizes or variants");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Reopen this decision…" })).toBeVisible();
});

test("owner maps source products; nothing is merged, guessed or given stock", async ({ page }) => {
  await openTab(page, /^Product Mapping Review/);
  await expect(page.getByRole("button", { name: "Decide" })).toHaveCount(6);
  await expect(page.getByRole("row").filter({ hasText: "mkwawa" })).toContainText("No selling price");

  async function decide(rowText: string) {
    await page.getByRole("row").filter({ hasText: rowText }).first().getByRole("button", { name: "Decide" }).click();
    return page.getByRole("dialog");
  }
  async function linkToExisting(rowText: string, unit: string, liveName: string) {
    const dialog = await decide(rowText);
    await dialog.getByRole("button", { name: "Approve this mapping" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Confirm the product name and the unit"); // the unit is never assumed
    await dialog.getByLabel("Unit counted and sold in").selectOption(unit);
    await dialog.getByLabel("It is a product that already exists").check();
    const select = dialog.getByLabel("Existing product");
    const value = await select.locator("option", { hasText: liveName }).getAttribute("value");
    await select.selectOption(value!);
    await dialog.getByRole("button", { name: "Approve this mapping" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await linkToExisting("Safari Kubwa", "Crate", "Safari Kubwa");
  await linkToExisting("Konyagi ndogo", "Bottle", "Konyagi ndogo");
  await expect(page.getByRole("button", { name: "Decide" })).toHaveCount(4);

  // mkwawa: created without a price, so it exists but is not on sale
  let dialog = await decide("mkwawa");
  await dialog.getByLabel("Unit counted and sold in").selectOption("Carton");
  await expect(dialog.getByLabel("Approved selling price (TZS)")).toHaveValue("");
  await dialog.getByRole("button", { name: "Approve this mapping" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // The rest are kept as history only; that needs a note
  await expect(page.getByRole("button", { name: "Decide" })).toHaveCount(3);
  let left = 3;
  for (const name of ["Henken", "Henken", "MAGIC MOMENT"]) {
    dialog = await decide(name);
    await dialog.getByRole("button", { name: "Do not map (keep history only)" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Write why");
    await dialog.getByLabel("Note").fill("Will be set up by hand after the count");
    await dialog.getByRole("button", { name: "Do not map (keep history only)" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    // the decided line has left the list before the next one is picked (there are two lines called Henken)
    await expect(page.getByRole("button", { name: "Decide" })).toHaveCount(--left);
  }
  await expect(page.getByText("Nothing here.")).toBeVisible();

  await page.getByLabel("Show").selectOption("APPROVED");
  await expect(page.getByRole("row").filter({ hasText: "mkwawa" })).toContainText("(not on sale)");
  await expect(page.getByRole("row").filter({ hasText: "Safari Kubwa" })).toContainText("→ Safari Kubwa");
});

test("unlabelled rows can only be labelled, excluded or flagged, and keep their history", async ({ page }) => {
  await openTab(page, /^Unlabelled rows/);
  const totals = page.locator("section").filter({ hasText: "Row 11 ·" });
  const unknown = page.locator("section").filter({ hasText: "Row 12 ·" });
  await expect(totals).toContainText("in 4 sheet(s)");
  await expect(totals).toContainText("Pending review");
  await totals.getByText("Show the original values in each sheet").click();
  await expect(totals).toContainText("31.08.2026 row 11");
  await expect(totals).toContainText("J: 45000");

  await totals.getByLabel("What row 11 is").fill("Column totals");
  await totals.getByRole("button", { name: "Classify" }).click();
  await expect(totals).toContainText("Classified");
  await expect(totals).toContainText("reviewer: Test Owner");

  await unknown.getByRole("button", { name: "Exclude" }).click();
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("Row 12: A reason is needed");
  await unknown.getByLabel("Reason for row 12").fill("Owner's private note, not shop data");
  await unknown.getByRole("button", { name: "Exclude" }).click();
  await expect(unknown).toContainText("Excluded");
  await unknown.getByText(/Decision history \(1\)/).click();
  await expect(unknown).toContainText("Test Owner · Excluded · Owner's private note, not shop data");
});

test("owner accepts the history; live stock was never touched", async ({ page }) => {
  await expect(page.getByText(/NOT RECONCILED/).first()).toBeVisible(); // everything decided, but not yet accepted
  await expect(page.getByText("Everything has been reviewed.")).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept as reconciled" });
  await expect(accept).toBeDisabled();
  await page.getByLabel("On what basis do you accept it?").fill("All exceptions reviewed with the accountant");
  await accept.click();
  await expect(page.getByText("Accepted as reconciled by the Owner.")).toBeVisible();

  // lines affected by the gap were accepted without explanation, so they stay marked incomplete
  await openTab(page, /^Historical Daily Records/);
  await page.getByLabel("Only incomplete lines").check();
  const incomplete = page.getByRole("row").filter({ hasText: "Incomplete" });
  await expect(incomplete.first()).toContainText("10.09.2026 row 4");
  await expect(incomplete.first()).toContainText("Konyagi ndogo");

  // the historical figures (Konyagi closing 60, Safari 20) changed nothing in the live system
  await page.getByRole("link", { name: "Products", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Products" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Konyagi ndogo" })).toContainText("58");
  const mkwawa = page.getByRole("row").filter({ hasText: "mkwawa" });
  await expect(mkwawa).toContainText("No price");
  await expect(mkwawa).toContainText("Switched off");
});
