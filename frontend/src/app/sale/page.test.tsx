import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import NewSalePage from "./page";

const product = {
  id: 7, sku: "P00007", name: "Konyagi ndogo", package_size: "200ml", pack_description: "", base_unit: "Bottle", barcode: "",
  category: null, category_name: "", brand: "", selling_price: "4500.00", is_active: true, stock_on_hand: "3.000", stock_status: "IN_STOCK", units: [],
};
const savedSale = {
  id: 1, receipt_number: "MB-20261102-0001", status: "COMPLETED", status_label: "Completed", business_date: "2026-11-02",
  created_at: "2026-11-02T09:00:00Z", cashier_name: "Asha", subtotal: "9000.00", total: "9000.00", amount_tendered: "10000.00", change_due: "1000.00",
  items: [{ id: 1, product_name: "Konyagi ndogo 200ml", unit_name: "Bottle", quantity: "2.000", unit_price: "4500.00", line_total: "9000.00" }],
  payments: [{ id: 1, method_name: "Cash", is_cash: true, amount: "9000.00", tendered: "10000.00", reference: "", status: "RECORDED" }],
  void_reason: "", voided_by_name: "",
};

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
let salePosts: { request_key: string; items: unknown[]; payments: { amount: string }[] }[];
let saleResponder: () => Promise<Response>;
let products: unknown[];

beforeEach(() => {
  document.cookie = "csrftoken=test-token";
  salePosts = [];
  products = [product];
  saleResponder = () => json(savedSale, 201);
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/sales/") && init?.method === "POST") {
      salePosts.push(JSON.parse(String(init.body)));
      return saleResponder();
    }
    if (url.includes("/day/current/")) return json({ is_live: true, today: "2026-11-02", day: { id: 1 }, shift: { id: 1 }, shift_figures: {} });
    if (url.includes("/payment-methods/")) return json([
      { id: 1, code: "cash", name: "Cash", is_cash: true, reference_label: "", is_active: true },
      { id: 2, code: "mobile-money", name: "Mobile Money", is_cash: false, reference_label: "Transaction ID", is_active: true },
    ]);
    if (url.includes("/settings/")) return json({ branch_name: "MERIBA Main Branch", receipt_header: "MERIBA STORE", receipt_footer: "", split_payments_enabled: true });
    if (url.includes("/products/")) return json({ count: products.length, next: null, previous: null, results: products });
    return json({ message: "not mocked" }, 404);
  }));
});

async function addTwoBottles(user: ReturnType<typeof userEvent.setup>) {
  render(<NewSalePage />);
  const tile = await screen.findByRole("button", { name: /Konyagi ndogo 200ml.*in stock/ });
  await user.click(tile);
  await user.click(tile);
}

describe("New Sale screen", () => {
  it("shows the line total and grand total as products are added", async () => {
    const user = userEvent.setup();
    await addTwoBottles(user);
    expect(screen.getByTestId("sale-total")).toHaveTextContent("TZS 9,000");
    expect(screen.getByLabelText("Quantity of Konyagi ndogo 200ml")).toHaveValue("2");
  });

  it("will not add more than is in stock and says so in plain words", async () => {
    const user = userEvent.setup();
    await addTwoBottles(user);
    const tile = screen.getByRole("button", { name: /Konyagi ndogo 200ml.*in stock/ });
    await user.click(tile);
    await user.click(tile); // a 4th bottle, but only 3 exist
    expect(screen.getByLabelText("Quantity of Konyagi ndogo 200ml")).toHaveValue("3");
    expect(screen.getByRole("alert")).toHaveTextContent("Only 3 of Konyagi ndogo left in stock.");
  });

  it("shows change for cash and blocks completion when the amount is too small", async () => {
    const user = userEvent.setup();
    await addTwoBottles(user);
    const received = screen.getByLabelText("Cash received (TZS)");
    await user.type(received, "5000");
    expect(screen.getByText(/Still to pay: TZS 4,000/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Complete Sale/ })).toBeDisabled();
    await user.clear(received);
    await user.type(received, "10000");
    expect(screen.getByText("Change to give back")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Complete Sale/ })).toBeEnabled();
  });

  it("a double click saves the sale only once (AT-UX-06)", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => {};
    saleResponder = () => new Promise<Response>((resolve) => { release = resolve; });
    await addTwoBottles(user);
    const button = screen.getByRole("button", { name: /Complete Sale/ });
    await user.dblClick(button);
    await waitFor(() => expect(salePosts).toHaveLength(1));
    expect(screen.getByRole("button", { name: /Saving the sale/ })).toBeDisabled();
    release(new Response(JSON.stringify(savedSale), { status: 201 }));
    expect(await screen.findByText(/has been saved/)).toBeInTheDocument();
    expect(screen.getAllByText(/MB-20261102-0001/).length).toBeGreaterThan(0);
    expect(salePosts).toHaveLength(1);
  });

  it("keeps the sale on screen after a connection problem and retries with the same key (AT-UX-04)", async () => {
    const user = userEvent.setup();
    saleResponder = () => Promise.reject(new TypeError("Failed to fetch"));
    await addTwoBottles(user);
    await user.click(screen.getByRole("button", { name: /Complete Sale/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not reach the shop system. Check the connection and try again.");
    expect(screen.getByTestId("sale-total")).toHaveTextContent("TZS 9,000"); // nothing was lost

    saleResponder = () => json(savedSale, 201);
    await user.click(screen.getByRole("button", { name: /Complete Sale/ }));
    await screen.findByText(/has been saved/);
    expect(salePosts).toHaveLength(2);
    expect(salePosts[1].request_key).toBe(salePosts[0].request_key); // the server will treat it as the same sale
    expect(salePosts[1].payments).toEqual([{ method: 1, amount: "9000.00", reference: "" }]);

    await user.click(screen.getByRole("button", { name: "Next Sale" }));
    expect(screen.getByTestId("sale-total")).toHaveTextContent("TZS 0");
  });

  it("sells a verified package, counting stock in bottles across the bottle and crate lines", async () => {
    const user = userEvent.setup();
    products = [{ ...product, stock_on_hand: "30.000",
      units: [{ id: 9, name: "Crate", factor: "12.000", selling_price: "50000.00", is_verified: true, is_active: true }] }];
    render(<NewSalePage />);
    const crate = await screen.findByRole("button", { name: /Sell a whole crate of Konyagi ndogo \(12 bottles\)/ });
    const bottle = screen.getByRole("button", { name: /Konyagi ndogo 200ml.*in stock/ });
    await user.click(crate);
    await user.click(crate); // 24 bottles
    await user.click(bottle); // + 1 = 25
    expect(screen.getByLabelText("Quantity of Konyagi ndogo 200ml (Crate of 12)")).toHaveValue("2");
    expect(screen.getByTestId("sale-total")).toHaveTextContent("TZS 104,500"); // 2 x 50,000 + 4,500

    await user.click(crate); // a third crate would need 37 bottles; only 30 exist
    expect(screen.getByLabelText("Quantity of Konyagi ndogo 200ml (Crate of 12)")).toHaveValue("2");
    expect(screen.getByRole("alert")).toHaveTextContent("Only 30 of Konyagi ndogo left in stock.");
    const bottles = screen.getByLabelText("Quantity of Konyagi ndogo 200ml");
    await user.clear(bottles);
    await user.type(bottles, "9"); // 24 + 9 = 33: more than 30, so it is held at the 6 that are left
    expect(bottles).toHaveValue("6");

    await user.click(screen.getByRole("button", { name: /Complete Sale/ }));
    await waitFor(() => expect(salePosts).toHaveLength(1));
    expect(salePosts[0].items).toEqual([{ product: 7, quantity: 2, unit: 9 }, { product: 7, quantity: 6 }]);
  });
});
