import { describe, expect, it } from "vitest";

import { canOpen, navFor } from "./nav";

describe("menus by role", () => {
  it("cashier sees only daily sales functions", () => {
    expect(navFor("CASHIER").map((i) => i.label)).toEqual(["Home", "New Sale", "Today's Sales", "Close Day"]);
  });
  it("accountant sees finance and stock but not users or setup", () => {
    const labels = navFor("ACCOUNTANT").map((i) => i.label);
    expect(labels).toContain("Daily Closing");
    expect(labels).toContain("Stock");
    expect(labels).not.toContain("Users");
    expect(labels).not.toContain("Setup");
  });
  it("owner sees everything", () => {
    expect(navFor("OWNER").map((i) => i.label)).toEqual(expect.arrayContaining(["Users", "Setup", "Products", "Daily Closing"]));
  });
});

describe("opening a page by typing its address (AT-UX-02)", () => {
  it.each(["/users", "/setup", "/products", "/stock", "/closing", "/anything-else"])("cashier is refused %s", (path) => {
    expect(canOpen("CASHIER", path)).toBe(false);
  });
  it.each(["/", "/sale", "/sales", "/day/start", "/day/close", "/change-password"])("cashier may open %s", (path) => {
    expect(canOpen("CASHIER", path)).toBe(true);
  });
  it("accountant is refused owner-only pages", () => {
    expect(canOpen("ACCOUNTANT", "/users")).toBe(false);
    expect(canOpen("ACCOUNTANT", "/setup")).toBe(false);
    expect(canOpen("ACCOUNTANT", "/closing")).toBe(true);
  });
});
