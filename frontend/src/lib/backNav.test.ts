import { beforeEach, describe, expect, it, vi } from "vitest";

import { parentOf, previousPage, readTrail, recordVisit, replaceTo, resetBackNav, stepTrail } from "./backNav";

/** jsdom starts every test file with a history of one entry, like a freshly opened tab. */
function visit(...paths: string[]) {
  for (const path of paths) {
    window.history.pushState(null, "", path);
    recordVisit(path);
  }
}

beforeEach(() => {
  sessionStorage.clear();
  resetBackNav();
});

describe("the trail", () => {
  it("adds a new page, drops the last one on a step back, and ignores a refresh", () => {
    expect(stepTrail(["/"], "/sales")).toEqual({ trail: ["/", "/sales"], back: false });
    expect(stepTrail(["/", "/sales"], "/", "pop")).toEqual({ trail: ["/"], back: true });
    expect(stepTrail(["/", "/sales"], "/sales")).toEqual({ trail: ["/", "/sales"], back: false });
  });

  it("treats a link to the page before as a new page, and the browser's Forward as one too", () => {
    expect(stepTrail(["/products", "/stock"], "/products")).toEqual({ trail: ["/products", "/stock", "/products"], back: false });
    expect(stepTrail(["/products"], "/stock", "pop")).toEqual({ trail: ["/products", "/stock"], back: false });
  });

  it("swaps the last page on a redirect instead of adding one", () => {
    expect(stepTrail(["/", "/sale"], "/sheet", "replace")).toEqual({ trail: ["/", "/sheet"], back: false });
  });

  it("notices the browser's Back button", () => {
    visit("/", "/products", "/stock");
    window.dispatchEvent(new PopStateEvent("popstate"));
    recordVisit("/products");
    expect(readTrail()).toEqual(["/", "/products"]);
  });

  it("starts a fresh trail when the app is opened from a typed address or a new tab, but not on a refresh", () => {
    sessionStorage.setItem("meriba.back.trail", JSON.stringify(["/", "/products"]));
    const kind = vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" }] as never);
    recordVisit("/products");
    expect(readTrail()).toEqual(["/", "/products"]);

    resetBackNav();
    kind.mockReturnValue([{ type: "navigate" }] as never);
    recordVisit("/sales");
    expect(readTrail()).toEqual(["/sales"]);
    kind.mockRestore();
  });

  it("starts again on the sign-in page", () => {
    visit("/", "/products");
    recordVisit("/login");
    expect(readTrail()).toEqual([]);
  });

  it("follows a redirect made with replaceTo, even when the page redirects before the shell records it", () => {
    visit("/");
    replaceTo({ replace: vi.fn() }, "/sheet?x=1"); // what /sale does in its own effect
    recordVisit("/sale"); // the shell then records /sale itself
    recordVisit("/sheet");
    expect(readTrail()).toEqual(["/", "/sheet"]);
  });
});

describe("where Back goes", () => {
  it("returns to the page the user came from", () => {
    visit("/", "/products", "/stock");
    expect(previousPage("OWNER", "/stock")).toBe("/products");
  });

  it("still knows the earlier page after a refresh", () => {
    visit("/", "/audit");
    recordVisit("/audit"); // the reload records the same page again
    expect(previousPage("ACCOUNTANT", "/audit")).toBe("/");
  });

  it("has nowhere to return to when the page was opened straight from its address", () => {
    visit("/reports");
    expect(previousPage("OWNER", "/reports")).toBeNull();
  });

  it("never returns to the sign-in page or the forced password change", () => {
    visit("/change-password", "/");
    visit("/sales");
    expect(previousPage("CASHIER", "/sales")).toBe("/");
    sessionStorage.setItem("meriba.back.trail", JSON.stringify(["/login", "/sales"]));
    expect(previousPage("CASHIER", "/sales")).toBeNull();
    sessionStorage.setItem("meriba.back.trail", JSON.stringify(["/change-password", "/sales"]));
    expect(previousPage("CASHIER", "/sales")).toBeNull();
  });

  it("never returns to a page the role may not open", () => {
    sessionStorage.setItem("meriba.back.trail", JSON.stringify(["/users", "/sales"]));
    window.history.pushState(null, "", "/sales");
    expect(previousPage("OWNER", "/sales")).toBe("/users");
    expect(previousPage("ACCOUNTANT", "/sales")).toBeNull();
    expect(previousPage("CASHIER", "/sales")).toBeNull();
  });

  it("ignores a trail that does not end on the page showing", () => {
    visit("/", "/products");
    expect(previousPage("OWNER", "/stock")).toBeNull();
  });

  it("falls back to the page's parent, else Home", () => {
    expect(parentOf("/history", "OWNER")).toBe("/setup");
    expect(parentOf("/history", "ACCOUNTANT")).toBe("/setup");
    expect(parentOf("/day/close", "CASHIER")).toBe("/");
    expect(parentOf("/products", "OWNER")).toBe("/");
    expect(parentOf("/settings", "OWNER")).toBe("/");
  });
});
