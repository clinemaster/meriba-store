import { describe, expect, it } from "vitest";

import { allocationProblem, duplicateAllocation, newAllocation, paymentLabel, paymentQuery, periodPresets, readPaymentQuery, usableCategories } from "./payments";
import type { PaymentMethod } from "./types";

const provider = (id: number, category: number, name: string, is_active = true) =>
  ({ id, category, category_name: "", code: name, name, description: "", is_active, sort_order: id, created_at: "", updated_at: "", in_use: false });
const methods: PaymentMethod[] = [
  { id: 1, code: "cash", name: "Cash", is_cash: true, requires_provider: false, reference_label: "", is_active: true, providers: [] },
  { id: 2, code: "mobile-money", name: "Mobile Money", is_cash: false, requires_provider: true, reference_label: "", is_active: true,
    providers: [provider(21, 2, "M-PESA"), provider(22, 2, "Old Pesa", false)] },
  { id: 3, code: "bank", name: "Bank", is_cash: false, requires_provider: true, reference_label: "", is_active: true, providers: [provider(31, 3, "NMB", false)] },
  { id: 4, code: "cheque", name: "Cheque", is_cash: false, requires_provider: false, reference_label: "", is_active: false, providers: [] },
];

describe("payment helpers", () => {
  it("offers only categories that can actually be used", () => {
    // Bank has no provider switched on and Cheque is off: a cashier could not complete either.
    expect(usableCategories(methods).map((m) => m.name)).toEqual(["Cash", "Mobile Money"]);
  });

  it("needs a provider that is switched on when the category requires one", () => {
    const line = { ...newAllocation(2), amount: "1000" };
    expect(allocationProblem(line, methods)).toMatch(/Choose the Mobile Money provider \(M-PESA\)/);
    expect(allocationProblem({ ...line, providerId: 22 }, methods)).not.toBeNull(); // switched off
    expect(allocationProblem({ ...line, providerId: 21 }, methods)).toBeNull();
    expect(allocationProblem(newAllocation(1), methods)).toBeNull(); // cash: no provider
    expect(allocationProblem(newAllocation(null), methods)).toMatch(/Choose how/);
  });

  it("spots the same category and provider twice", () => {
    const a = { ...newAllocation(2), providerId: 21 };
    expect(duplicateAllocation([a, { ...newAllocation(2), providerId: 21 }])).toBe(true);
    expect(duplicateAllocation([a, { ...newAllocation(2), providerId: 22 }, newAllocation(1)])).toBe(false);
  });

  it("labels a payment with its provider", () => {
    expect(paymentLabel("Mobile Money", "M-PESA")).toBe("Mobile Money · M-PESA");
    expect(paymentLabel("Cash", "")).toBe("Cash");
  });

  it("writes and reads the same filters, so a card, its list and the download agree", () => {
    const q = { from: "2026-10-01", to: "2026-10-30", category: 2, provider: 21, cashier: 5, kind: "payment" as const,
                status: "collected", search: "QX", ordering: "-amount", page: 3 };
    const text = paymentQuery(q);
    expect(text).toBe("date_from=2026-10-01&date_to=2026-10-30&category=2&provider=21&cashier=5&search=QX&ordering=-amount&page=3");
    expect(readPaymentQuery(new URLSearchParams(text), "2026-10-30")).toEqual({ ...q, branch: null });
    expect(paymentQuery({ from: "2026-10-30", to: "2026-10-30", category: 2, provider: "none" })).toContain("provider=none");
    expect(readPaymentQuery(new URLSearchParams("date_from=bad&category=x"), "2026-10-30")).toMatchObject({ from: "2026-10-30", to: "2026-10-30", category: null });
  });

  it("works out the usual periods from the shop's date", () => {
    const p = Object.fromEntries(periodPresets("2026-10-30").map((x) => [x.key, [x.from, x.to]]));
    expect(p.today).toEqual(["2026-10-30", "2026-10-30"]);
    expect(p.week).toEqual(["2026-10-26", "2026-10-30"]); // Monday to today
    expect(p.month).toEqual(["2026-10-01", "2026-10-30"]);
    expect(p["last-month"]).toEqual(["2026-09-01", "2026-09-30"]);
  });
});
