import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PaymentCategoryTotal, PaymentMetrics } from "@/lib/types";

import { PaymentCategoryCards, PaymentMetricCards } from "./PaymentSummary";

const line = (id: number | null, name: string, amount: string, count = 1) =>
  ({ id, name, is_active: true, amount, count, verified: "0", refunds: "0", refund_count: 0, net: amount });
const categories: PaymentCategoryTotal[] = [
  { ...line(1, "Cash", "3000.00"), code: "cash", icon: "cash", is_cash: true, requires_provider: false, providers: [], unassigned: 0 },
  { ...line(2, "Mobile Money", "5000.00", 4), code: "mobile-money", icon: "phone", is_cash: false, requires_provider: true, unassigned: 1,
    providers: [line(21, "M-PESA", "3000.00", 2), line(22, "Mixx by Yas", "1000.00"), line(null, "Provider not recorded", "1000.00")] },
  { ...line(3, "Bank", "2000.00", 2), code: "bank", icon: "bank", is_cash: false, requires_provider: true, unassigned: 0,
    providers: [line(31, "NMB", "1000.00"), line(32, "CRDB", "1000.00")] },
];
const metrics: PaymentMetrics = {
  sale_count: 5, voided_count: 0, payment_count: 8, refund_count: 0, gross_sales: "10000.00", discounts: "0.00", cancellations: "0.00",
  refunds: "0.00", adjustments: "0.00", net_sales: "10000.00", payments_collected: "10000.00", refunds_issued: "0.00", net_collections: "10000.00",
  outstanding_receivables: "0.00", expected_collections: "10000.00", reconciliation_difference: "0.00",
};
const query = { from: "2026-10-30", to: "2026-10-30", cashier: 4 };

describe("payment summary cards", () => {
  it("each category and provider opens exactly its own payments, keeping the other filters", () => {
    render(<PaymentCategoryCards categories={categories} query={query} palette={[1, 2, 3]} />);
    const href = (name: RegExp) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href(/^Cash: TZS 3,000/)).toBe("/payments/transactions?date_from=2026-10-30&date_to=2026-10-30&category=1&cashier=4");
    expect(href(/^Mobile Money: TZS 5,000/)).toBe("/payments/transactions?date_from=2026-10-30&date_to=2026-10-30&category=2&cashier=4");
    expect(href(/M-PESA: TZS 3,000/)).toBe("/payments/transactions?date_from=2026-10-30&date_to=2026-10-30&category=2&provider=21&cashier=4");
    expect(href(/NMB: TZS 1,000/)).toBe("/payments/transactions?date_from=2026-10-30&date_to=2026-10-30&category=3&provider=31&cashier=4");
    expect(href(/Provider not recorded/)).toContain("provider=none");
    expect(screen.getByText(/1 earlier payment have no provider recorded/)).toBeInTheDocument();
  });

  it("shows the headline figures from the server, and says when payments match the sales", () => {
    render(<PaymentMetricCards metrics={metrics} categories={categories} query={query} reportsHref={(k) => `/reports?key=${k}`} />);
    expect(screen.getByRole("link", { name: /Payments collected/ })).toHaveTextContent("TZS 10,000");
    expect(screen.getByRole("link", { name: /Mobile Money/ })).toHaveAttribute("href", expect.stringContaining("category=2"));
    expect(screen.getByRole("link", { name: /Refunds paid/ })).toHaveAttribute("href", expect.stringContaining("kind=refund"));
    expect(screen.getByRole("link", { name: /Reconciliation difference/ })).toHaveTextContent("Payments match sales");
    expect(screen.getByText("Outstanding credit").parentElement).toHaveTextContent("Credit sales are not switched on");
  });

  it("warns when payments and sales do not match", () => {
    render(<PaymentMetricCards metrics={{ ...metrics, reconciliation_difference: "-500.00" }} categories={categories} query={query} />);
    expect(screen.getByText(/Payments and sales do not match/)).toBeInTheDocument();
  });
});
