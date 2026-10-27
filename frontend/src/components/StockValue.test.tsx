import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StockValue } from "./StockValue";

afterEach(cleanup);

const base = {
  date: "2026-10-20", source: "LIVE" as const, previous_date: "2026-10-16", previous_value: "72772500", price_changes: "0",
  opening_value: "72772500", deliveries: "0", sales: "45000", other: "0", closing_value: "72727500",
};

describe("stock value statement", () => {
  it("takes the day's sales off the previous day's stock value", () => {
    render(<StockValue value={base} />);
    const rows = screen.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual([
      expect.stringContaining("72,772,500"),
      expect.stringMatching(/Sales today so far.*− TZS 45,000/),
      expect.stringMatching(/Stock value now.*72,727,500/),
    ]);
  });

  it("shows a delivery and a price change on their own lines only when they happened", () => {
    render(<StockValue value={{ ...base, source: "CLOSED", deliveries: "187500", price_changes: "-5000", sales: "187500", closing_value: "72767500" }} />);
    expect(screen.getByText("Deliveries received").nextSibling).toHaveTextContent("+ TZS 187,500");
    expect(screen.getByText("Selling prices changed since then").nextSibling).toHaveTextContent("− TZS 5,000");
    expect(screen.queryByText("Returns, stock counts and breakages")).not.toBeInTheDocument();
    expect(screen.getByText(/Stock value at the close of Tue, 20 Oct/).nextSibling).toHaveTextContent("TZS 72,767,500");
  });
});
