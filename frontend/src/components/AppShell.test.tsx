import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";

const state = vi.hoisted(() => ({ user: null as null | { role: string; must_change_password: boolean; display_name: string }, pathname: "/products", replace: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: state.user, loading: false, signOut: vi.fn() }) }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname, useRouter: () => ({ replace: state.replace }) }));
vi.mock("./SidebarNav", () => ({ SidebarNav: () => null }));
vi.mock("./StockAlerts", () => ({ StockAlerts: () => null }));

const owner = { role: "OWNER", must_change_password: false, display_name: "Owner" };

beforeEach(() => { state.replace.mockReset(); state.user = null; });
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

describe("Signing in from a page", () => {
  it("remembers the page that was asked for", () => {
    state.pathname = "/products";
    render(<AppShell>page</AppShell>);
    expect(state.replace).toHaveBeenCalledWith("/login?next=%2Fproducts");
  });

  it("returns to that page after signing in", () => {
    state.pathname = "/login";
    state.user = owner;
    window.history.replaceState(null, "", "/login?next=%2Fproducts");
    render(<AppShell>page</AppShell>);
    expect(state.replace).toHaveBeenCalledWith("/products");
  });

  it("goes to the dashboard when there is no page to return to, or it points outside the system", () => {
    state.pathname = "/login";
    state.user = owner;
    window.history.replaceState(null, "", "/login?next=%2F%2Fevil.example");
    render(<AppShell>page</AppShell>);
    expect(state.replace).toHaveBeenCalledWith("/");
  });
});
