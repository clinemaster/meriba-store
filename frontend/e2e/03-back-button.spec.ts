import { expect, test, type Page } from "@playwright/test";

/**
 * The Back button above every page title, in a real browser: it follows the pages actually visited,
 * keeps a page's filters, survives a refresh, and goes to the parent page when there is nothing to go back to.
 * Runs after 01-trading-day, which sets the shop up and creates the cashier account used here.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { username: process.env.E2E_OWNER ?? "e2e_owner", password: process.env.E2E_OWNER_PASSWORD ?? "" };
const CASHIER = { username: "asha", password: "Shop-Till-7781" };
const HOME = /^Hello,/;

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "LOGIN" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function openScreen(page: Page, link: string, heading: string | RegExp) {
  const menu = page.getByRole("navigation", { name: "Main menu" });
  const target = menu.getByRole("link", { name: link, exact: true });
  const closed = menu.getByRole("button", { expanded: false });
  while (!(await target.isVisible()) && (await closed.count()) > 0) await closed.first().click();
  await target.click();
  await showing(page, heading);
}

async function showing(page: Page, heading: string | RegExp) {
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

async function back(page: Page) {
  await page.getByRole("button", { name: "Back", exact: true }).click();
}

test("owner: Back follows the pages visited and keeps the Products filters", async ({ page }) => {
  await signIn(page, OWNER.username, OWNER.password);
  await showing(page, HOME);
  await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0); // Home is the top

  await openScreen(page, "Products", "Products");
  await page.getByLabel("Search").fill("zz-no-such-product");
  await openScreen(page, "Stock", "Stock");
  await back(page);
  await showing(page, "Products");
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByLabel("Search")).toHaveValue("zz-no-such-product");

  await back(page);
  await showing(page, HOME);

  // The menu to the page before is a new visit, not a Back: the filters start fresh.
  await openScreen(page, "Products", "Products");
  await openScreen(page, "Stock", "Stock");
  await openScreen(page, "Products", "Products");
  await expect(page.getByLabel("Search")).toHaveValue("");
});

test("owner: Back still works after a refresh", async ({ page }) => {
  await signIn(page, OWNER.username, OWNER.password);
  await openScreen(page, "Reports", "Reports");
  await openScreen(page, "Audit History", "Audit History");
  await page.reload();
  await showing(page, "Audit History");
  await back(page);
  await showing(page, "Reports");
});

test("owner: a page opened from its address goes to its parent, without bouncing back", async ({ page }) => {
  await signIn(page, OWNER.username, OWNER.password);
  await page.goto("/history");
  await showing(page, "Excel History");
  await back(page);
  await showing(page, /Setup/);
  await expect(page).toHaveURL(/\/setup$/);
  await back(page);
  await showing(page, HOME);
});

test("owner: a page opened in a new tab goes to Home and stays in the app", async ({ page, context }) => {
  await signIn(page, OWNER.username, OWNER.password);
  await openScreen(page, "Expenses", "Expenses");
  const tab = await context.newPage();
  await tab.goto("/settings");
  await showing(tab, "Settings");
  await back(tab);
  await showing(tab, HOME);
  await expect(tab).toHaveURL(/:\d+\/$/);
});

test("cashier: Back goes Home, and never to an office page", async ({ page }) => {
  await signIn(page, CASHIER.username, CASHIER.password);
  await openScreen(page, "Today's Sales", "Today's Sales");
  await back(page);
  await showing(page, HOME);

  await page.goto("/day/close");
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await back(page);
  await showing(page, HOME);

  // An office page is refused, with no Back button to slip past the refusal.
  await page.goto("/products");
  await expect(page.getByText("This page is not available for your account.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
});
