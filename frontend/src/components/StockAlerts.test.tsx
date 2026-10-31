import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { announceDataChanged, STOCK_LEVELS } from "@/lib/stockLevels";

import { StockAlerts } from "./StockAlerts";
import { StockBadge } from "./ui";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const alert = (id: number, status = "LOW_STOCK", current = status) => ({
  id, created_at: "2026-10-20T10:00:00Z", product: id, product_name: `Product ${id}`, unit: "Bottle",
  status_before: "IN_STOCK", status, status_label: status, quantity: "8.000", current_status: current,
});

describe("stock badge", () => {
  it("never rests on colour alone: icon, word and the quantity", () => {
    render(<StockBadge status="CRITICAL" quantity="5.000" unit="Bottle" />);
    expect(screen.getByText("Critical stock")).toBeInTheDocument();
    expect(screen.getByText(STOCK_LEVELS.CRITICAL.icon)).toHaveAttribute("aria-hidden");
    expect(screen.getByText("5 Bottle")).toBeInTheDocument();
    expect(screen.getByText("Critical stock").className).toContain("bg-danger-soft");
  });

  it("has a distinct label for each level", () => {
    render(<>{(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"] as const).map((s) => <StockBadge key={s} status={s} />)}</>);
    for (const word of ["Healthy", "Low stock", "Out of stock"]) expect(screen.getByText(word)).toBeInTheDocument();
  });
});

describe("stock warnings", () => {
  let feed: { latest_id: number; results: ReturnType<typeof alert>[] };
  let calls: string[];

  beforeEach(() => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, String(v)),
      removeItem: (k: string) => void saved.delete(k), clear: () => saved.clear(),
    });
    calls = [];
    feed = { latest_id: 0, results: [] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify(feed), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts from now on a first visit instead of announcing old alerts", async () => {
    feed = { latest_id: 7, results: [alert(7)] };
    render(<StockAlerts userId={1} />);
    await waitFor(() => expect(localStorage.getItem("meriba.stockAlerts.seen.1")).toBe("7"));
    expect(screen.queryByLabelText("Stock warnings")).not.toBeInTheDocument();
  });

  it("shows a new alert once, straight after a change is saved, and not again on the next check", async () => {
    localStorage.setItem("meriba.stockAlerts.seen.1", "3");
    feed = { latest_id: 4, results: [alert(4, "OUT_OF_STOCK")] };
    render(<StockAlerts userId={1} />);
    const box = await screen.findByLabelText("Stock warnings");
    expect(box).toHaveTextContent("Product 4");
    expect(box).toHaveTextContent("Out of stock");
    expect(calls[0]).toContain("/stock/alerts/?after=3");
    expect(screen.getByRole("link", { name: "See the products" })).toHaveAttribute("href", "/products?stock=ATTENTION");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByLabelText("Stock warnings")).not.toBeInTheDocument();

    feed = { latest_id: 4, results: [] };
    announceDataChanged();
    await waitFor(() => expect(calls.at(-1)).toContain("?after=4"));
    expect(screen.queryByLabelText("Stock warnings")).not.toBeInTheDocument();
  });

  it("skips an alert that a delivery has already put right", async () => {
    localStorage.setItem("meriba.stockAlerts.seen.1", "0");
    feed = { latest_id: 2, results: [alert(2, "LOW_STOCK", "IN_STOCK")] };
    render(<StockAlerts userId={1} />);
    await waitFor(() => expect(localStorage.getItem("meriba.stockAlerts.seen.1")).toBe("2"));
    expect(screen.queryByLabelText("Stock warnings")).not.toBeInTheDocument();
  });
});
