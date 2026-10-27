import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackButton } from "@/components/BackButton";
import { readTrail, recordVisit, resetBackNav, useBackState } from "@/lib/backNav";
import type { Role } from "@/lib/types";

const nav = vi.hoisted(() => ({ pathname: "/", back: vi.fn(), replace: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null as null | { role: Role; must_change_password: boolean } }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ back: nav.back, replace: nav.replace }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: auth.user }) }));

function signedIn(role: Role, must_change_password = false) {
  auth.user = { role, must_change_password };
}

function visit(...paths: string[]) {
  for (const path of paths) {
    window.history.pushState(null, "", path);
    recordVisit(path);
    nav.pathname = path;
  }
}

const back = () => screen.getByRole("button", { name: "Back" });

beforeEach(() => {
  sessionStorage.clear();
  resetBackNav();
  nav.back.mockReset();
  nav.replace.mockReset();
  signedIn("OWNER");
});

describe("Back button", () => {
  it("goes back through the browser history to the page the user came from", async () => {
    visit("/", "/products");
    render(<BackButton />);
    await userEvent.click(back());
    expect(nav.back).toHaveBeenCalledOnce();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("opened straight from its address, goes to the parent page and replaces this one", async () => {
    visit("/history");
    render(<BackButton />);
    await userEvent.click(back());
    expect(nav.back).not.toHaveBeenCalled();
    expect(nav.replace).toHaveBeenCalledWith("/setup");
    act(() => visit("/setup")); // arriving swaps the trail's last page, so Back on Setup cannot bounce to Excel History
    expect(readTrail()).toEqual(["/setup"]);
  });

  it("after a refresh still goes back, not to Home", async () => {
    visit("/", "/sales", "/reports");
    recordVisit("/reports");
    render(<BackButton />);
    await userEvent.click(back());
    expect(nav.back).toHaveBeenCalledOnce();
  });

  it("for a cashier, never goes back to an office page; goes Home instead", async () => {
    signedIn("CASHIER");
    sessionStorage.setItem("meriba.back.trail", JSON.stringify(["/products", "/sales"]));
    nav.pathname = "/sales";
    render(<BackButton />);
    await userEvent.click(back());
    expect(nav.back).not.toHaveBeenCalled();
    expect(nav.replace).toHaveBeenCalledWith("/");
  });

  it("for an accountant, goes back to an office page but not an owner-only one", async () => {
    signedIn("ACCOUNTANT");
    visit("/", "/products", "/audit");
    const { unmount } = render(<BackButton />);
    await userEvent.click(back());
    expect(nav.back).toHaveBeenCalledOnce();
    unmount();

    sessionStorage.setItem("meriba.back.trail", JSON.stringify(["/settings", "/audit"]));
    render(<BackButton />);
    await userEvent.click(back());
    expect(nav.replace).toHaveBeenCalledWith("/");
  });

  it("is not shown on Home, when signed out, or during the forced password change", () => {
    nav.pathname = "/";
    const { unmount } = render(<BackButton />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    unmount();

    nav.pathname = "/change-password";
    signedIn("CASHIER", true);
    const second = render(<BackButton />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    second.unmount();

    auth.user = null;
    nav.pathname = "/sales";
    render(<BackButton />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});

function Filters() {
  const [search, setSearch] = useBackState("search", "");
  const [page, setPage] = useBackState("page", 1);
  return (
    <>
      <input aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
      <button onClick={() => setPage(page + 1)}>Page {page}</button>
    </>
  );
}

describe("filters kept for Back", () => {
  it("are put back when returning to the page, and start fresh when arriving any other way", async () => {
    visit("/", "/products");
    const first = render(<Filters />);
    await userEvent.type(screen.getByLabelText("Search"), "konyagi");
    await userEvent.click(screen.getByRole("button", { name: "Page 1" }));
    first.unmount();

    visit("/stock");
    window.dispatchEvent(new PopStateEvent("popstate")); // Back: the page renders before the shell records the step back
    nav.pathname = "/products";
    const returned = render(<Filters />);
    expect(screen.getByLabelText("Search")).toHaveValue("konyagi");
    expect(screen.getByRole("button", { name: "Page 2" })).toBeInTheDocument();
    act(() => recordVisit("/products"));
    returned.unmount();

    visit("/stock", "/products"); // through the menu, not Back, even though it is the page before
    render(<Filters />);
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Page 1" })).toBeInTheDocument();
  });
});
