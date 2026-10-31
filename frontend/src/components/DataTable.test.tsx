import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ColumnPicker } from "@/components/ColumnPicker";
import { ActionButton, DataTable, Pagination } from "@/components/DataTable";
import type { TableColumn } from "@/lib/table";
import { useColumnVisibility } from "@/lib/useColumnVisibility";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1 } }) }));

type Row = { id: number; name: string; total: string; qty: number };
const ROWS: Row[] = [
  { id: 1, name: "Safari", total: "2500", qty: 3 },
  { id: 2, name: "Konyagi", total: "12000", qty: 10 },
];
const COLUMNS: TableColumn<Row>[] = [
  { key: "name", label: "Product", essential: true, sortable: true },
  { key: "qty", label: "Qty", type: "quantity", sortable: true },
  { key: "total", label: "Total", type: "currency" },
];

function Demo(props: { onSort?: (o: string) => void; ordering?: string }) {
  const cols = useColumnVisibility("demo", COLUMNS);
  return (
    <>
      <ColumnPicker visibility={cols} />
      <DataTable label="Demo" columns={COLUMNS} visibility={cols} rows={ROWS} rowKey={(r) => r.id}
        sort={props.onSort ? { ordering: props.ordering ?? "", onSort: props.onSort } : undefined}
        actions={(r) => <ActionButton aria-label={`Edit ${r.name}`}>Edit</ActionButton>}
        totals={{ label: "All products", values: { total: "TZS 14,500" } }} />
    </>
  );
}

const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent);
const firstColumn = () => screen.getAllByRole("row").slice(1, -1).map((r) => within(r).getAllByRole("cell")[0].textContent);

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
  });
});
afterEach(cleanup);

describe("DataTable", () => {
  it("draws headings with scope, formats by type and aligns numbers right", () => {
    render(<Demo />);
    expect(screen.getByRole("table", { name: "Demo" })).toBeInTheDocument();
    expect(headers()).toEqual(["Product", "Qty", "Total", "Actions"]);
    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("scope", "col");
    const cell = screen.getByRole("cell", { name: "TZS 12,000" });
    expect(cell).toHaveClass("num");
  });

  it("gives every row its own named, compact action button", () => {
    render(<Demo />);
    const edit = screen.getByRole("button", { name: "Edit Konyagi" });
    expect(edit).toHaveClass("btn-table");
    expect(edit.closest("td")).toHaveClass("actions-cell");
  });

  it("puts the totals label before the first total column", () => {
    render(<Demo />);
    const foot = screen.getAllByRole("row").at(-1)!;
    expect(within(foot).getAllByRole("cell").map((c) => c.textContent)).toEqual(["All products", "TZS 14,500", ""]);
    expect(within(foot).getByText("All products")).toHaveAttribute("colspan", "2");
  });

  it("sorts here when no server sorting is given, and reverses on a second press", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: /^Product/ }));
    expect(firstColumn()).toEqual(["Konyagi", "Safari"]);
    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("aria-sort", "ascending");
    await user.click(screen.getByRole("button", { name: /^Product/ }));
    expect(firstColumn()).toEqual(["Safari", "Konyagi"]);
    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("aria-sort", "descending");
  });

  it("hands sorting to the server when asked, without reordering the rows itself", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<Demo onSort={onSort} ordering="qty" />);
    await user.click(screen.getByRole("button", { name: /^Qty/ }));
    expect(onSort).toHaveBeenCalledWith("-qty");
    await user.click(screen.getByRole("button", { name: /^Product/ }));
    expect(onSort).toHaveBeenCalledWith("name");
    expect(firstColumn()).toEqual(["Safari", "Konyagi"]);
  });

  it("follows the person's hidden columns and column order, and restores the default", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: /Columns/ }));
    await user.click(screen.getByRole("checkbox", { name: "Qty" }));
    expect(headers()).toEqual(["Product", "Total", "Actions"]);
    await user.click(screen.getByRole("button", { name: "Move Total up" }));
    await user.click(screen.getByRole("button", { name: "Show all columns" }));
    expect(headers()).toEqual(["Product", "Total", "Qty", "Actions"]);
    await user.click(screen.getByRole("button", { name: "Restore default" }));
    expect(headers()).toEqual(["Product", "Qty", "Total", "Actions"]);
  });

  it("shows loading, problem and empty states in place of the table", () => {
    const base = { label: "T", columns: COLUMNS, rowKey: (r: Row) => r.id };
    const { rerender } = render(<DataTable {...base} rows={undefined} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    rerender(<DataTable {...base} rows={undefined} error="Server down" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Server down");
    rerender(<DataTable {...base} rows={[]} empty="No products yet." />);
    expect(screen.getByText("No products yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Pagination", () => {
  it("hides itself for one page and pages either way", async () => {
    const user = userEvent.setup();
    const onPage = vi.fn();
    const { rerender } = render(<Pagination page={1} pages={1} onPage={onPage} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    rerender(<Pagination page={2} pages={3} onPage={onPage} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPage.mock.calls).toEqual([[3], [1]]);
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
  });
});
