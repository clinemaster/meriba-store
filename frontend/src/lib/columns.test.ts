import { describe, expect, it } from "vitest";

import {
  canToggle, isDefault, isDefaultOrder, moveColumn, orderDefs, orderStorageKey, sanitizeHidden, sanitizeOrder, storageKey,
  toggleHidden, visibleKeys, loadHidden, saveHidden, type ColumnDef,
} from "./columns";

const ten: ColumnDef[] = Array.from({ length: 10 }, (_, i) => ({ key: `c${i}`, label: `Column ${i}`, essential: i === 0 }));

describe("column visibility rules", () => {
  it("shows everything by default", () => {
    expect(sanitizeHidden(ten, null)).toEqual([]);
    expect(visibleKeys(ten, [])).toHaveLength(10);
  });

  it("honours defaultHidden from the table configuration", () => {
    const defs = [{ key: "a", label: "A" }, { key: "b", label: "B", defaultHidden: true }];
    expect(sanitizeHidden(defs, null)).toEqual(["b"]);
  });

  it("lets a user pick any five of ten columns", () => {
    let hidden: string[] = [];
    for (const k of ["c1", "c3", "c5", "c7", "c9"]) hidden = toggleHidden(ten, hidden, k);
    expect(visibleKeys(ten, hidden)).toEqual(["c0", "c2", "c4", "c6", "c8"]);
  });

  it("toggles back on", () => {
    const off = toggleHidden(ten, [], "c2");
    expect(toggleHidden(ten, off, "c2")).toEqual([]);
  });

  it("never hides an essential column", () => {
    expect(canToggle(ten, [], "c0")).toBe(false);
    expect(toggleHidden(ten, [], "c0")).toEqual([]);
    expect(sanitizeHidden(ten, ["c0", "c1"])).toEqual(["c1"]);
  });

  it("never hides the last visible column", () => {
    const two: ColumnDef[] = [{ key: "a", label: "A" }, { key: "b", label: "B" }];
    const hidden = toggleHidden(two, [], "a");
    expect(canToggle(two, hidden, "b")).toBe(false);
    expect(toggleHidden(two, hidden, "b")).toEqual(["a"]);
    expect(canToggle(two, hidden, "a")).toBe(true);
    expect(sanitizeHidden(two, ["a", "b"])).toHaveLength(1);
  });

  it("drops unknown or malformed stored values", () => {
    expect(sanitizeHidden(ten, ["gone", 5, "c2"])).toEqual(["c2"]);
    expect(sanitizeHidden(ten, "nonsense")).toEqual([]);
  });

  it("reports whether the default layout is showing", () => {
    expect(isDefault(ten, [])).toBe(true);
    expect(isDefault(ten, ["c1"])).toBe(false);
  });

  it("keeps preferences apart per user and per table", () => {
    expect(storageKey(1, "products")).not.toBe(storageKey(2, "products"));
    expect(storageKey(1, "products")).not.toBe(storageKey(1, "sales"));
  });

  it("survives broken or missing storage", () => {
    expect(loadHidden(null, "k")).toBeNull();
    expect(loadHidden({ getItem: () => "{bad" }, "k")).toBeNull();
    expect(() => saveHidden({ setItem: () => { throw new Error("full"); }, removeItem: () => {} }, "k", ["a"])).not.toThrow();
  });
});

describe("column order rules", () => {
  const defs: ColumnDef[] = ["a", "b", "c", "d"].map((k) => ({ key: k, label: k.toUpperCase() }));

  it("starts in the table's own order", () => {
    expect(sanitizeOrder(defs, null)).toEqual(["a", "b", "c", "d"]);
    expect(isDefaultOrder(defs, ["a", "b", "c", "d"])).toBe(true);
  });

  it("moves a column one place either way, and not past the ends", () => {
    const order = ["a", "b", "c", "d"];
    expect(moveColumn(order, "c", -1)).toEqual(["a", "c", "b", "d"]);
    expect(moveColumn(order, "c", 1)).toEqual(["a", "b", "d", "c"]);
    expect(moveColumn(order, "a", -1)).toBe(order);
    expect(moveColumn(order, "d", 1)).toBe(order);
    expect(moveColumn(order, "zz", 1)).toBe(order);
  });

  it("drops unknown and repeated keys, and slots new columns in beside their neighbours", () => {
    expect(sanitizeOrder(defs, ["d", "gone", "a", "d", 7])).toEqual(["d", "a", "b", "c"]);
    expect(sanitizeOrder(defs, ["c", "a"])).toEqual(["c", "d", "a", "b"]);
    expect(sanitizeOrder(defs, "nonsense")).toEqual(["a", "b", "c", "d"]);
  });

  it("lists the definitions in the chosen order", () => {
    expect(orderDefs(defs, ["b", "a", "d", "c"]).map((d) => d.key)).toEqual(["b", "a", "d", "c"]);
  });

  it("keeps order preferences apart from the hidden-columns preference", () => {
    expect(orderStorageKey(1, "products")).not.toBe(storageKey(1, "products"));
  });
});
