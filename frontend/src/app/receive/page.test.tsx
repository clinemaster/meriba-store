import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReceiveStockPage from "./page";

const auth = vi.hoisted(() => ({ role: "OWNER" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, role: auth.role } }) }));
vi.mock("@/components/BackButton", () => ({ BackButton: () => null }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const body = String(input).includes("/suppliers/") ? [] : { count: 0, next: null, previous: null, results: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Receive Stock", () => {
  it("offers Upload Received Stock to the Owner", async () => {
    auth.role = "OWNER";
    render(<ReceiveStockPage />);
    expect(await screen.findByRole("button", { name: "Upload Received Stock" })).toBeInTheDocument();
  });

  it("does not offer it to the Accountant, who still receives deliveries by typing them", async () => {
    auth.role = "ACCOUNTANT";
    render(<ReceiveStockPage />);
    expect(await screen.findByText("Latest deliveries")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload Received Stock" })).not.toBeInTheDocument();
  });
});
