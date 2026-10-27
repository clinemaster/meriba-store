import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { SidebarNav } from "@/components/SidebarNav";

const group = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
/** The links inside the groups (Help, below them, is always there and checked on its own). */
const shownLinks = () => screen.queryAllByRole("link").map((a) => a.textContent).filter((t) => t !== "Help");

describe("collapsible sidebar groups", () => {
  afterEach(cleanup);

  it("shows the four groups, with only the current page's group open", () => {
    render(<SidebarNav role="OWNER" pathname="/products" />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Selling", "Stock", "Money & Reports", "Admin"]);
    expect(group("Stock")).toHaveAttribute("aria-expanded", "true");
    for (const name of ["Selling", "Money & Reports", "Admin"]) expect(group(name)).toHaveAttribute("aria-expanded", "false");
    expect(shownLinks()).toEqual(["Products", "Stock", "Receive Stock"]);
    expect(screen.getByRole("link", { name: "Products" })).toHaveAttribute("aria-current", "page");
  });

  it("opens a group on a click, closes it on a second click, and keeps several open", async () => {
    render(<SidebarNav role="OWNER" pathname="/products" />);
    await userEvent.click(group("Admin"));
    expect(group("Admin")).toHaveAttribute("aria-expanded", "true");
    expect(shownLinks()).toEqual(["Products", "Stock", "Receive Stock", "Users", "Settings", "Setup"]);
    await userEvent.click(group("Money & Reports"));
    expect(shownLinks()).toEqual(["Products", "Stock", "Receive Stock", "Daily Closing", "Expenses", "Reports", "Audit History", "Users", "Settings", "Setup"]);
    await userEvent.click(group("Admin"));
    expect(group("Admin")).toHaveAttribute("aria-expanded", "false");
    expect(shownLinks()).not.toContain("Users");
  });

  it("opens the group of a page reached from elsewhere, leaving open groups open", async () => {
    const { rerender } = render(<SidebarNav role="OWNER" pathname="/" />);
    await userEvent.click(group("Admin"));
    rerender(<SidebarNav role="OWNER" pathname="/closing" />);
    expect(group("Money & Reports")).toHaveAttribute("aria-expanded", "true");
    expect(group("Selling")).toHaveAttribute("aria-expanded", "true");
    expect(group("Admin")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Daily Closing" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps each role's own menu: the cashier has Selling only, the accountant no Users or Settings", async () => {
    render(<SidebarNav role="CASHIER" pathname="/sheet" />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Selling"]);
    expect(shownLinks()).toEqual(["Home", "Today's Sales", "Daily Sheet", "Close Day"]);
    cleanup();
    render(<SidebarNav role="ACCOUNTANT" pathname="/" />);
    await userEvent.click(group("Admin"));
    expect(shownLinks()).toContain("Setup");
    expect(shownLinks()).not.toContain("Users");
    expect(shownLinks()).not.toContain("Settings");
  });

  it("shows Help below the groups for every role, highlighted on the Help page, without opening a group", () => {
    for (const role of ["OWNER", "ACCOUNTANT", "CASHIER"] as const) {
      render(<SidebarNav role={role} pathname="/" />);
      const links = screen.getAllByRole("link");
      expect(links.at(-1)).toHaveTextContent("Help");
      expect(links.at(-1)).toHaveAttribute("href", "/help");
      expect(links.at(-1)).not.toHaveAttribute("aria-current");
      cleanup();
    }
    render(<SidebarNav role="OWNER" pathname="/help" />);
    expect(screen.getByRole("link", { name: "Help" })).toHaveAttribute("aria-current", "page");
    expect(shownLinks()).toEqual([]);
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });
});
