import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DamagedProductsPage from "./page";

const auth = vi.hoisted(() => ({ role: "OWNER" }));
const damageRequest = vi.hoisted(() => ({ body: null as Record<string, unknown> | null }));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, role: auth.role } }) }));
vi.mock("@/components/BackButton", () => ({ BackButton: () => null }));

const products = [
  { id: 1, sku: "P1", name: "Konyagi", package_size: "200ml", base_unit: "Bottle", stock_on_hand: "20", stock_status: "IN_STOCK", selling_price: "4500.00", average_cost: "1000.0000" },
  { id: 2, sku: "P2", name: "Serengeti", package_size: "500ml", base_unit: "Bottle", stock_on_hand: "10", stock_status: "IN_STOCK", selling_price: "3000.00", average_cost: "1200.0000" },
];

beforeEach(() => {
  damageRequest.body = null;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/csrf/")) return Promise.resolve(new Response(JSON.stringify({ csrfToken: "test-token" }), { status: 200 }));
    if (url.includes("/products/")) return Promise.resolve(new Response(JSON.stringify({ count: 2, next: null, previous: null, results: products }), { status: 200 }));
    if (url.includes("/stock/damaged/") && init?.method === "POST") {
      damageRequest.body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({ reference: "DR-000001", damaged_quantity: "5.000", damage_value: "18000.00" }), { status: 201 }));
    }
    if (url.includes("/stock/damaged/")) {
      return Promise.resolve(new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [], summary: { records: 0, products: 0, damaged_quantity: "0", damage_value: "0", inventory_cost_value: "0" } }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Damaged Product", () => {
  it("previews retail and inventory-cost values and submits damaged quantities after confirmation", async () => {
    render(<DamagedProductsPage />);

    fireEvent.change(await screen.findByLabelText("Quantity damaged for Konyagi 200ml"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Quantity damaged for Serengeti 500ml"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Reason for damage"), { target: { value: "Broken in storage" } });

    expect(screen.getAllByText("Grand Total Damage Value")[0].parentElement).toHaveTextContent("TZS 18,000");
    expect(screen.getAllByText("Inventory cost of damage")[1].parentElement).toHaveTextContent("TZS 5,600");
    fireEvent.click(screen.getByRole("button", { name: "Review and record damaged stock" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm damaged products" }));

    await waitFor(() => expect(damageRequest.body).not.toBeNull());
    expect(damageRequest.body).toMatchObject({
      reason: "Broken in storage",
      lines: [{ product: 1, quantity: "2.000" }, { product: 2, quantity: "3.000" }],
    });
    expect(await screen.findByText(/DR-000001: 5 units damaged/)).toBeInTheDocument();
  });
});