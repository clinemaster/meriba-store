import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Product } from "@/lib/types";

import { UploadReceived, type ImportRow, type Preview } from "./UploadReceived";

const konyagi = { id: 7, label: "Konyagi ndogo", base_unit: "Bottle", volume_ml: 200, serial_number: 1 };
const castle = { id: 8, label: "Castle lager", base_unit: "Bottle", volume_ml: 500, serial_number: 2 };
const products = [
  { id: 7, name: "Konyagi ndogo", package_size: "", base_unit: "Bottle", volume_ml: 200 },
  { id: 8, name: "Castle lager", package_size: "", base_unit: "Bottle", volume_ml: 500 },
] as Product[];

function row(n: number, extra: Partial<ImportRow> = {}): ImportRow {
  return {
    row: n, sheet: "Sheet", sn: String(n - 1), details: "Konyagi ndogo", unit: "Bottle", volume: "", quantity: "24",
    uploaded: { details: "Konyagi ndogo", unit: "Bottle", volume: "", quantity: "24" }, edited: [], excluded: false, chosen: false,
    status: "READY", status_label: "Ready to add", match_status: "MATCHED", match_label: "Matched", name_differs: false,
    problems: [], notes: [], product: konyagi, candidates: [], factor: "1", adds: "24", stock_before: "100", stock_after: "124",
    duplicate: false, ...extra,
  };
}
const mystery = (extra: Partial<ImportRow> = {}) => row(3, {
  details: "Mystery", uploaded: { details: "Mystery", unit: "Bottle", volume: "", quantity: "5" }, quantity: "5",
  status: "UNMATCHED", status_label: "Product not found", match_status: "UNMATCHED", match_label: "Unmatched", product: null,
  adds: null, stock_before: null, stock_after: undefined,
  problems: [{ problem: "No product called 'Mystery' was found.", fix: "Choose the right product, or exclude the row." }], ...extra,
});
const summary = (extra: Partial<Preview["summary"]> = {}): Preview["summary"] => ({
  total_rows: 2, matched: 1, needs_review: 0, unmatched: 1, duplicate_rows: 0, ready: 1, excluded: 0, not_product_rows: 0,
  blocking: 1, undecided_duplicates: 0, can_confirm: false, received_by_unit: [{ unit: "Bottle", quantity: "24" }], ...extra,
});
const base: Preview = {
  batch: "b1", file: "delivery.xlsx", status: "PREVIEW", is_live: true, already_imported: null, result: null,
  rows: [row(2), mystery()], summary: summary(), edits: {}, decisions: {}, duplicates: [],
};

let calls: { url: string; body: unknown }[];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  calls = [];
  document.cookie = "csrftoken=t";
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, body });
    let data: unknown = base;
    if (url.endsWith("/b1/")) {
      const edit = body?.edits?.["3"] ?? {};
      data = edit.excluded
        ? { ...base, edits: body.edits, rows: [row(2), mystery({ excluded: true, status: "EXCLUDED", match_status: "EXCLUDED", match_label: "Excluded" })],
            summary: summary({ unmatched: 0, excluded: 1, blocking: 0, can_confirm: true }) }
        : { ...base, edits: body.edits, rows: [row(2), mystery({ product: castle, chosen: true, name_differs: true })] };
    } else if (url.endsWith("/confirm/")) {
      data = { result: { batch: "b1", file: "delivery.xlsx", receipts: [41], rows_added: 1, products_updated: 1,
        added: [{ row: 2, details: "Konyagi ndogo", product: "Konyagi ndogo", added: "24", base_unit: "Bottle", receipt: 41 }],
        skipped: [{ row: 3, details: "Mystery", status: "Excluded by you", problems: [] }] } };
    }
    return Promise.resolve(new Response(JSON.stringify(data), { status: url.endsWith("/confirm/") ? 201 : 200, headers: { "Content-Type": "application/json" } }));
  }));
});

async function uploaded() {
  render(<UploadReceived suppliers={[]} products={products} onClose={() => {}} onImported={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Excel file (.xlsx)"), { target: { files: [new File(["x"], "delivery.xlsx")] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload and check" }));
  return screen.findByLabelText("Import summary");
}

describe("Upload Received Stock preview", () => {
  it("shows the summary and every row against its product, with no import button while a row is unresolved", async () => {
    const box = await uploaded();
    expect(within(box).getByText("Rows uploaded").nextSibling).toHaveTextContent("2");
    expect(within(box).getByText("Unmatched").nextSibling).toHaveTextContent("1");
    expect(box).toHaveTextContent("24 bottles");
    const konyagiRow = screen.getAllByRole("row").find((r) => r.textContent?.includes("Excel row 2"))!;
    expect(konyagiRow).toHaveTextContent("100 bottles");
    expect(konyagiRow).toHaveTextContent("124 bottles");
    expect(konyagiRow).toHaveTextContent("Matched");
    expect(screen.queryByRole("button", { name: "Confirm and Import Stock" })).not.toBeInTheDocument();
    expect(screen.getByText(/review or exclude 1 row/)).toBeInTheDocument();
  });

  it("lets the Owner choose the product for a row, then shows the different name", async () => {
    await uploaded();
    fireEvent.click(screen.getByRole("button", { name: "Review Excel row 3" }));
    fireEvent.change(screen.getByLabelText("System product"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check again" }));
    expect(await screen.findByText(/Different name from the file/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/b1/"))!.body).toEqual({ edits: { 3: { product: 8 } } });
  });

  it("imports only after the problem row is excluded and the Owner confirms", async () => {
    await uploaded();
    fireEvent.click(screen.getByRole("button", { name: "Review Excel row 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Exclude this row" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and Import Stock" }));
    expect(calls.some((c) => c.url.endsWith("/confirm/"))).toBe(false);  // asks first
    fireEvent.click(await screen.findByRole("button", { name: "Yes, import the stock" }));
    expect(await screen.findByText(/Stock increased for 1 product\(s\) from 1 row\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/Row 3 \(Mystery\): Excluded by you/)).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/confirm/"))).toHaveLength(1));
  });
});
