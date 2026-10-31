import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardInsights } from "./DashboardInsights";

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
            { date: "2026-10-15", net_sales: "-12000" },
          ]
        : [];
      return Promise.resolve(new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
  });

  it("draws each day in its own colour and highlights negative sales", async () => {
    render(<DashboardInsights today="2026-10-16" />);
    const trend = await screen.findByLabelText("Net sales for the last seven days");

    await waitFor(() => expect(trend.querySelectorAll('[aria-hidden="true"] > div')).toHaveLength(3));
    const bars = trend.querySelectorAll('[aria-hidden="true"] > div');

    const colors = Array.from(bars, (bar) => bar.style.backgroundColor);
    expect(colors.every(Boolean)).toBe(true);
    expect(new Set(colors).size).toBe(bars.length);
    expect(trend).toHaveTextContent("-TZS 12,000");
    expect(screen.getByText("-TZS 12,000")).toHaveClass("text-danger");
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
    { code: "P9", product: "Sold below cost", gross_profit: "-1500" },
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

    fireEvent.click(screen.getByRole("button", { name: "Show all 8 products" }));
    expect(namesIn(chart)).toEqual([
      "kaswagara",
      "Konyagi ndogo 200 mls",
      "Kilimanjaro lite",
      "captain mogan kubwa 750mls",
      "Maji Makubwa afya",
      "Safari lager",
      "Coca-Cola 500ml",
      "Sold below cost",
    ]);
    expect(chart).not.toHaveTextContent("Unknown cost item");

    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(namesIn(chart)).toHaveLength(5);
  });

  it("draws every product in its own colour and labels a loss", async () => {
    render(<DashboardInsights today="2026-10-16" />);
    const chart = await screen.findByLabelText("Gross profit by product, known costs only");
    fireEvent.click(screen.getByRole("button", { name: "Show all 8 products" }));

    const bars = Array.from(chart.querySelectorAll('[aria-hidden="true"] > div'));
    expect(bars).toHaveLength(8);
    const colors = bars.map((bar) => (bar as HTMLElement).style.backgroundColor);
    expect(colors.every(Boolean)).toBe(true);
    expect(new Set(colors).size).toBe(bars.length);
    expect(chart).toHaveTextContent("-TZS 1,500 (loss)");
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
