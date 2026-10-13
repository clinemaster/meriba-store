import { describe, expect, it } from "vitest";

import { canOpen, navFor } from "./nav";

describe("menus by role", () => {
  it("cashier sees only daily sales functions", () => {
    expect(navFor("CASHIER").map((i) => i.label)).toEqual(["Home", "Today's Sales", "Daily Sheet", "Close Day"]);
  });
  it("accountant sees finance, stock and reports but not users", () => {
    const labels = navFor("ACCOUNTANT").map((i) => i.label);
    expect(labels).toContain("Daily Closing");
    expect(labels).toContain("Stock");
    expect(labels).toEqual(expect.arrayContaining(["Receive Stock", "Expenses", "Reports", "Setup"]));
    expect(labels).not.toContain("Users");
  });
  it("owner sees everything", () => {
    expect(navFor("OWNER").map((i) => i.label)).toEqual(expect.arrayContaining(["Users", "Setup", "Products", "Daily Closing"]));
  });
});

describe("opening a page by typing its address (AT-UX-02)", () => {
  it.each(["/users", "/setup", "/products", "/stock", "/closing", "/receive", "/expenses", "/reports", "/history", "/audit", "/settings", "/anything-else"])("cashier is refused %s", (path) => {
    expect(canOpen("CASHIER", path)).toBe(false);
  });
  it.each(["/", "/sale", "/sales", "/sheet", "/day/start", "/day/close", "/change-password", "/help"])("cashier may open %s", (path) => {
    expect(canOpen("CASHIER", path)).toBe(true);
  });
  it("accountant is refused owner-only pages", () => {
    expect(canOpen("ACCOUNTANT", "/users")).toBe(false);
    expect(canOpen("ACCOUNTANT", "/settings")).toBe(false);
    expect(canOpen("ACCOUNTANT", "/audit")).toBe(true);
    expect(canOpen("ACCOUNTANT", "/reports")).toBe(true);
    expect(canOpen("ACCOUNTANT", "/closing")).toBe(true);
  });
});
