import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardInsights, productColor } from "./DashboardInsights";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard sales trend", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const rows = url.includes("daily-sales")
        ? [
            { date: "2026-10-13", net_sales: "874500" },
            { date: "2026-10-14", net_sales: "954500" },
          ]
        : [];
      return Promise.resolve(new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
  });

  it("uses a distinct, stable color for each weekday's sales bar", async () => {
    render(<DashboardInsights today="2026-10-16" />);
    const trend = await screen.findByLabelText("Net sales for the last seven days");

    await waitFor(() => expect(trend.querySelectorAll('[aria-hidden="true"] > div')).toHaveLength(2));
    const bars = trend.querySelectorAll('[aria-hidden="true"] > div');

    expect(bars[0]).toHaveClass("bg-amber-500");
    expect(bars[1]).toHaveClass("bg-emerald-600");
    expect(bars[0].className).not.toBe(bars[1].className);
    expect(trend).toHaveTextContent("Tue");
    expect(trend).toHaveTextContent("Wed");
  });
});

describe("dashboard gross profit by product", () => {
  const profitRows = [
    { code: "P1", product: "Kilimanjaro lite", gross_profit: "30000" },
    { code: "P2", product: "kaswagara", gross_profit: "50000" },
    { code: "P3", product: "Konyagi ndogo 200 mls", gross_profit: "40500" },
    { code: "P4", product: "captain mogan kubwa 750mls", gross_profit: "30000" },
    { code: "P5", product: "Maji Makubwa afya", gross_profit: "29500" },
    { code: "P6", product: "Safari lager", gross_profit: "12000" },
    { code: "P7", product: "Coca-Cola 500ml", gross_profit: "8000" },
    { code: "P8", product: "Unknown cost item", gross_profit: null },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const rows = String(input).includes("sales-by-product") ? profitRows : [];
      return Promise.resolve(new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
  });

  const namesIn = (chart: HTMLElement) => Array.from(chart.querySelectorAll("span.truncate")).map((el) => el.textContent);

  it("shows the top five first, then every product with a known cost on Show all", async () => {
    render(<DashboardInsights today="2026-10-16" />);
    const chart = await screen.findByLabelText("Gross profit by product, known costs only");

    expect(namesIn(chart)).toEqual([
      "kaswagara",
      "Konyagi ndogo 200 mls",
      "Kilimanjaro lite",
      "captain mogan kubwa 750mls",
      "Maji Makubwa afya",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Show all 7 products" }));
    expect(namesIn(chart)).toEqual([
      "kaswagara",
      "Konyagi ndogo 200 mls",
      "Kilimanjaro lite",
      "captain mogan kubwa 750mls",
      "Maji Makubwa afya",
      "Safari lager",
      "Coca-Cola 500ml",
    ]);
    expect(chart).not.toHaveTextContent("Unknown cost item");

    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(namesIn(chart)).toHaveLength(5);
  });

  it("gives each product its own color, tied to the product rather than its rank", async () => {
    render(<DashboardInsights today="2026-10-16" />);
    const chart = await screen.findByLabelText("Gross profit by product, known costs only");
    fireEvent.click(screen.getByRole("button", { name: "Show all 7 products" }));

    const bars = Array.from(chart.querySelectorAll('[aria-hidden="true"] > div'));
    const order = ["P2", "P3", "P1", "P4", "P5", "P6", "P7"];
    bars.forEach((bar, i) => expect(bar).toHaveClass(productColor(order[i])));
    expect(new Set(bars.map((bar) => bar.className)).size).toBe(bars.length);
    expect(productColor("P2")).toBe(productColor("P2"));
  });

  it("grows each bar from empty to its value when the dashboard opens", async () => {
    render(<DashboardInsights today="2026-10-16" />);
    const chart = await screen.findByLabelText("Gross profit by product, known costs only");
    const bars = () => chart.querySelectorAll<HTMLElement>('[aria-hidden="true"] > div');

    expect(bars()[0]).toHaveClass("transition-[width]");
    await waitFor(() => expect(bars()[0].style.width).toBe("100%"));
    expect(bars()[1].style.width).toBe("81%");
  });
});
