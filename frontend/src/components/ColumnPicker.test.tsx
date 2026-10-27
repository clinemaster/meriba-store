import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ColumnPicker } from "@/components/ColumnPicker";
import type { ColumnDef } from "@/lib/columns";
import { storageKey } from "@/lib/columns";
import { useColumnVisibility } from "@/lib/useColumnVisibility";

const auth = vi.hoisted(() => ({ user: { id: 1 } as { id: number } | null }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: auth.user }) }));

const COLUMNS: ColumnDef[] = [
  { key: "name", label: "Name", essential: true },
  ...["b", "c", "d", "e", "f", "g", "h", "i", "j"].map((k) => ({ key: k, label: `Col ${k}` })),
];

function Demo({ id = "demo" }: { id?: string }) {
  const cols = useColumnVisibility(id, COLUMNS);
  return (
    <div>
      <ColumnPicker visibility={cols} />
      <table><thead><tr>{COLUMNS.filter((c) => cols.show(c.key)).map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead></table>
    </div>
  );
}

const headers = () => screen.queryAllByRole("columnheader").map((h) => h.textContent);

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
  });
  auth.user = { id: 1 };
});
afterEach(cleanup);

describe("ColumnPicker", () => {
  it("shows all ten columns and a 10 of 10 count at first", () => {
    render(<Demo />);
    expect(headers()).toHaveLength(10);
    expect(screen.getByRole("button", { name: /Columns \(10 of 10\)/ })).toBeInTheDocument();
  });

  it("hides five columns at once and restores them with one click", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: /Columns/ }));
    for (const k of ["b", "c", "d", "e", "f"]) await user.click(screen.getByRole("checkbox", { name: `Col ${k}` }));
    expect(headers()).toEqual(["Name", "Col g", "Col h", "Col i", "Col j"]);
    expect(screen.getByRole("button", { name: /Columns \(5 of 10\)/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all columns" }));
    expect(headers()).toHaveLength(10);
  });

  it("locks the essential column", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: /Columns/ }));
    expect(screen.getByRole("checkbox", { name: /^Name/ })).toBeDisabled();
  });

  it("remembers the choice after a reload, per table and per user", async () => {
    const user = userEvent.setup();
    const first = render(<Demo />);
    await user.click(screen.getByRole("button", { name: /Columns/ }));
    await user.click(screen.getByRole("checkbox", { name: "Col b" }));
    expect(JSON.parse(window.localStorage.getItem(storageKey(1, "demo"))!)).toEqual(["b"]);
    first.unmount();

    render(<Demo />);
    expect(await screen.findByRole("button", { name: /Columns \(9 of 10\)/ })).toBeInTheDocument();
    cleanup();

    render(<Demo id="other" />);
    expect(headers()).toHaveLength(10);
    cleanup();

    auth.user = { id: 2 };
    render(<Demo />);
    expect(headers()).toHaveLength(10);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: /Columns/ }));
    expect(screen.getByRole("group")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group")).toBeNull();
  });
});
