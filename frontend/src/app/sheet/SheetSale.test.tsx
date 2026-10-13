import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SheetSale } from "./SheetSale";

const line = { product: 7, details: "Konyagi ndogo 200ml", sales_price: "4500", closing_stock: "30" };
const product = {
  id: 7, sku: "P00007", name: "Konyagi ndogo", package_size: "200ml", pack_description: "", base_unit: "Bottle", barcode: "",
  category: null, category_name: "", brand: "", selling_price: "4500.00", is_active: true, stock_on_hand: "30.000", stock_status: "IN_STOCK",
  units: [{ id: 9, name: "Crate", factor: "12.000", selling_price: "50000.00", is_verified: true, is_active: true }],
};
const savedSale = {
  id: 1, receipt_number: "MB-20261102-0001", status: "COMPLETED", status_label: "Completed", business_date: "2026-11-02",
  created_at: "2026-11-02T09:00:00Z", cashier_name: "Asha", subtotal: "9000.00", total: "9000.00", amount_tendered: "10000.00", change_due: "1000.00",
  items: [{ id: 1, product_name: "Konyagi ndogo 200ml", unit_name: "Bottle", quantity: "2.000", unit_price: "4500.00", line_total: "9000.00" }],
  payments: [{ id: 1, method_name: "Cash", is_cash: true, amount: "9000.00", tendered: "10000.00", reference: "", status: "RECORDED" }],
  void_reason: "", voided_by_name: "",
};

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
let salePosts: { request_key: string; items: unknown[]; payments: unknown[] }[];
let saleResponder: () => Promise<Response>;
let onSaved: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.cookie = "csrftoken=test-token";
  salePosts = [];
  saleResponder = () => json(savedSale, 201);
  onSaved = vi.fn();
  onClose = vi.fn();
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/sales/") && init?.method === "POST") {
      salePosts.push(JSON.parse(String(init.body)));
      return saleResponder();
    }
    if (url.includes("/payment-methods/")) return json([
      { id: 1, code: "cash", name: "Cash", is_cash: true, reference_label: "", is_active: true },
      { id: 2, code: "mobile-money", name: "Mobile Money", is_cash: false, reference_label: "Transaction ID", is_active: true },
    ]);
    if (url.includes("/settings/")) return json({ branch_name: "MERIBA Main Branch", receipt_header: "MERIBA STORE", receipt_footer: "", split_payments_enabled: true });
    if (url.includes("/products/7/")) return json(product);
    return json({ message: "not mocked" }, 404);
  }));
});

async function open(quantity = 2) {
  render(<SheetSale line={line} quantity={quantity} onClose={onClose} onSaved={onSaved} />);
  await screen.findByRole("radio", { name: /Cash/ });
  await screen.findByLabelText("Sold as");
}
const saveButton = () => screen.getByRole("button", { name: /^Save sale/ });

describe("a sale typed on the Daily Sheet", () => {
  it("shows the total for the quantity typed on the sheet", async () => {
    await open();
    expect(screen.getByLabelText("Quantity sold")).toHaveValue("2");
    expect(screen.getByTestId("sale-total")).toHaveTextContent("TZS 9,000");
  });

  it("shows change for cash and blocks saving when the amount is too small", async () => {
    const user = userEvent.setup();
    await open();
    const received = screen.getByLabelText("Cash received (TZS)");
    await user.type(received, "5000");
    expect(screen.getByText(/Still to pay: TZS 4,000/)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await user.clear(received);
    await user.type(received, "10000");
    expect(screen.getByText("Change to give back")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("will not save more than is left in stock and says so in plain words", async () => {
    await open(31);
    expect(screen.getByRole("alert")).toHaveTextContent("Only 30 of Konyagi ndogo 200ml left in stock.");
    expect(saveButton()).toBeDisabled();
  });

  it("a double click saves the sale only once (AT-UX-06), then shows the receipt", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => {};
    saleResponder = () => new Promise<Response>((resolve) => { release = resolve; });
    await open();
    await user.dblClick(saveButton());
    await waitFor(() => expect(salePosts).toHaveLength(1));
    expect(screen.getByRole("button", { name: /Saving the sale/ })).toBeDisabled();
    release(new Response(JSON.stringify(savedSale), { status: 201 }));
    expect(await screen.findByText(/has been saved and added to the sheet/)).toBeInTheDocument();
    expect(screen.getAllByText(/MB-20261102-0001/).length).toBeGreaterThan(0);
    expect(screen.getByText("Give change: TZS 1,000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print Receipt" })).toBeInTheDocument();
    expect(salePosts).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("keeps what was typed after a connection problem and retries with the same key (AT-UX-04)", async () => {
    const user = userEvent.setup();
    saleResponder = () => Promise.reject(new TypeError("Failed to fetch"));
    await open();
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not reach the shop system. Check the connection and try again.");
    expect(screen.getByTestId("sale-total")).toHaveTextContent("TZS 9,000"); // nothing was lost
    expect(onSaved).not.toHaveBeenCalled();

    saleResponder = () => json(savedSale, 201);
    await user.click(saveButton());
    await screen.findByText(/has been saved/);
    expect(salePosts).toHaveLength(2);
    expect(salePosts[1].request_key).toBe(salePosts[0].request_key); // the server will treat it as the same sale
    expect(salePosts[1].items).toEqual([{ product: 7, quantity: 2 }]);
    expect(salePosts[1].payments).toEqual([{ method: 1, amount: "9000.00", reference: "" }]);
  });

  it("sells a verified package at its own price, checking stock in bottles", async () => {
    const user = userEvent.setup();
    await open();
    await user.selectOptions(screen.getByLabelText("Sold as"), "9");
    expect(screen.getByTestId("sale-total")).toHaveTextContent("TZS 100,000"); // 2 crates x 50,000
    expect(screen.getByText(/counts this as 24 bottle\(s\) in the Sales column/)).toBeInTheDocument();
    const quantity = screen.getByLabelText("Quantity sold");
    await user.clear(quantity);
    await user.type(quantity, "3"); // 36 bottles, only 30 left
    expect(screen.getByRole("alert")).toHaveTextContent("Only 30 of Konyagi ndogo 200ml left in stock.");
    await user.clear(quantity);
    await user.type(quantity, "2");
    await user.click(saveButton());
    await waitFor(() => expect(salePosts).toHaveLength(1));
    expect(salePosts[0].items).toEqual([{ product: 7, quantity: 2, unit: 9 }]);
  });

  it("takes part in cash and part by mobile money", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: "Customer is paying with more than one method" }));
    await user.type(screen.getByLabelText("Cash received (TZS)"), "4000");
    expect(saveButton()).toBeDisabled();
    await user.type(screen.getByLabelText("Mobile Money amount (TZS)"), "5000");
    await user.click(saveButton());
    await waitFor(() => expect(salePosts).toHaveLength(1));
    expect(salePosts[0].payments).toEqual([{ method: 1, amount: "4000.00", reference: "" }, { method: 2, amount: "5000.00", reference: "" }]);
  });
});
