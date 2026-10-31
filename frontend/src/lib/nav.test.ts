import { describe, expect, it } from "vitest";

import { canOpen, isActive, navFor, navGroupsFor } from "./nav";

describe("sidebar groups", () => {
  const shape = (role: Parameters<typeof navGroupsFor>[0]) => navGroupsFor(role).map((g) => [g.group, g.items.map((i) => i.label)]);
  it("owner sees all four groups in order", () => {
    expect(shape("OWNER")).toEqual([
      ["Selling", ["Home", "Today's Sales", "Daily Sheet", "Close Day"]],
      ["Stock", ["Products", "Stock", "Receive Stock", "Damaged Product"]],
      ["Money & Reports", ["Payments", "Daily Closing", "Expenses", "Reports", "Audit History"]],
      ["Admin", ["Users", "Settings", "Setup"]],
    ]);
  });
  it("accountant's Admin group holds only Setup", () => {
    expect(shape("ACCOUNTANT").at(-1)).toEqual(["Admin", ["Setup"]]);
  });
  it("cashier sees only the Selling group", () => {
    expect(shape("CASHIER")).toEqual([["Selling", ["Home", "Today's Sales", "Daily Sheet", "Close Day", "My Payments"]]]);
  });
  it("every menu entry belongs to a group", () => {
    expect(navFor("OWNER").every((i) => i.group)).toBe(true);
  });
  it("marks the right entry as the current page", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/sales")).toBe(false);
    expect(isActive("/stock", "/stock")).toBe(true);
    expect(isActive("/sales", "/sales")).toBe(true);
    expect(isActive("/sale", "/sales")).toBe(false); // a longer address is not the same page
  });
});

describe("menus by role", () => {
  it("cashier sees only daily sales functions", () => {
    expect(navFor("CASHIER").map((i) => i.label)).toEqual(["Home", "Today's Sales", "Daily Sheet", "Close Day", "My Payments"]);
  });
  it("accountant sees finance, stock and reports but not users", () => {
    const labels = navFor("ACCOUNTANT").map((i) => i.label);
    expect(labels).toContain("Daily Closing");
    expect(labels).toContain("Stock");
    expect(labels).toEqual(expect.arrayContaining(["Receive Stock", "Damaged Product", "Expenses", "Reports", "Setup"]));
    expect(canOpen("OWNER", "/damaged-products")).toBe(true);
    expect(canOpen("ACCOUNTANT", "/damaged-products")).toBe(true);
    expect(canOpen("CASHIER", "/damaged-products")).toBe(false);
    expect(labels).not.toContain("Users");
  });
  it("Excel History is off the menu but still opens for the office", () => {
    expect(navFor("OWNER").map((i) => i.label)).not.toContain("Excel History");
    expect(canOpen("OWNER", "/history")).toBe(true);
    expect(canOpen("ACCOUNTANT", "/history")).toBe(true);
  });
  it("owner sees everything", () => {
    expect(navFor("OWNER").map((i) => i.label)).toEqual(expect.arrayContaining(["Users", "Setup", "Products", "Daily Closing"]));
  });
});

describe("opening a page by typing its address (AT-UX-02)", () => {
  it.each(["/users", "/setup", "/products", "/stock", "/closing", "/receive", "/damaged-products", "/expenses", "/reports", "/history", "/audit", "/settings", "/anything-else"])("cashier is refused %s", (path) => {
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

  it("opens Payments for every role, and payment settings for the back office only", () => {
    for (const role of ["OWNER", "ACCOUNTANT", "CASHIER"] as const) expect(canOpen(role, "/payments/transactions")).toBe(true);
    expect(canOpen("ACCOUNTANT", "/settings/payment-methods")).toBe(true);
    expect(canOpen("ACCOUNTANT", "/settings")).toBe(false);
    expect(canOpen("CASHIER", "/settings/payment-methods")).toBe(false);
  });
});
