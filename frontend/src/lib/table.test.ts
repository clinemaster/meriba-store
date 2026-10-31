import { describe, expect, it } from "vitest";

import { alignOf, cellContent, formatValue, nextOrdering, parseOrdering, sortRows, type TableColumn } from "./table";

type Row = { id: number; name: string; price: string | null; qty: number };
const rows: Row[] = [
  { id: 1, name: "Safari", price: "2500", qty: 3 },
  { id: 2, name: "konyagi", price: null, qty: 10 },
  { id: 3, name: "Kilimanjaro", price: "12000.5", qty: 3 },
];
const cols: TableColumn<Row>[] = [
  { key: "name", label: "Name", sortable: true },
  { key: "price", label: "Price", type: "currency", sortable: true },
  { key: "qty", label: "Qty", type: "quantity", sortable: true },
  { key: "double", label: "Double", type: "number", accessor: (r) => r.qty * 2 },
];

describe("shared column rules", () => {
  it("aligns numbers right and text left unless told otherwise", () => {
    expect(alignOf(cols[0])).toBe("left");
    expect(alignOf(cols[1])).toBe("right");
    expect(alignOf({ ...cols[1], align: "center" })).toBe("center");
  });

  it("formats values by type, the same way everywhere", () => {
    expect(formatValue("currency", "2500")).toBe("TZS 2,500");
    expect(formatValue("amount", "12000.5")).toBe("12,000.50");
    expect(formatValue("quantity", "1.2500")).toBe("1.25");
    expect(formatValue("number", 1500)).toBe("1,500");
    expect(formatValue("currency", null)).toBe("—");
    expect(formatValue("text", undefined)).toBe("");
  });

  it("reads cells by field, accessor, format or render", () => {
    expect(cellContent(cols[3], rows[0])).toBe("6");
    expect(cellContent({ ...cols[0], format: (v) => `[${v}]` }, rows[0])).toBe("[Safari]");
    expect(cellContent({ ...cols[0], render: (r) => r.id }, rows[0])).toBe(1);
  });

  it("toggles server ordering like the API expects", () => {
    expect(nextOrdering("name", "name")).toBe("-name");
    expect(nextOrdering("-name", "name")).toBe("name");
    expect(nextOrdering("name", "qty")).toBe("qty");
    expect(parseOrdering("-qty")).toEqual({ key: "qty", desc: true });
  });

  it("sorts text without regard to case, and numbers as numbers", () => {
    expect(sortRows(rows, cols, "name").map((r) => r.id)).toEqual([3, 2, 1]);
    expect(sortRows(rows, cols, "-qty").map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it("keeps ties in their original order and puts empty values last both ways", () => {
    expect(sortRows(rows, cols, "qty").map((r) => r.id)).toEqual([1, 3, 2]);
    expect(sortRows(rows, cols, "price").map((r) => r.id)).toEqual([1, 3, 2]);
    expect(sortRows(rows, cols, "-price").map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it("leaves rows alone when there is no ordering or the column is unknown", () => {
    expect(sortRows(rows, cols, "")).toBe(rows);
    expect(sortRows(rows, cols, "gone")).toBe(rows);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
