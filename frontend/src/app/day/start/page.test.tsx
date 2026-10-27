import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CurrentDay, Role } from "@/lib/types";

import StartDayPage from "./page";

const auth = vi.hoisted(() => ({ role: "OWNER" as Role }));
const load = vi.hoisted(() => ({ data: null as unknown }));
const api = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: () => "/day/start", useRouter: () => ({ replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: auth.role, must_change_password: false } }) }));
vi.mock("@/lib/useLoad", () => ({ useLoad: () => ({ data: load.data, error: null, loading: false, reload: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ api, errorMessage: (e: unknown) => String(e) }));

function today(day: CurrentDay["day"] = null): CurrentDay {
  return {
    is_live: true, today: "2026-11-02", day, shift: null, shift_figures: null, day_needs_closing: false,
    closed_shift_today: null, next_opening_cumulative_sales: "1250000.00",
  };
}

const change = () => screen.queryByRole("button", { name: "Change the opening balance…" });
const startButton = () => screen.getByRole("button", { name: /^Start Day with/ });

beforeEach(() => {
  auth.role = "OWNER";
  load.data = today();
  api.mockReset().mockResolvedValue({});
});

describe("Start Day", () => {
  it("starts with just the float when the Owner keeps the carried balance", async () => {
    render(<StartDayPage />);
    await userEvent.clear(screen.getByLabelText("Cash float in the drawer (TZS)"));
    await userEvent.type(screen.getByLabelText("Cash float in the drawer (TZS)"), "20000");
    await userEvent.click(startButton());
    await userEvent.click(screen.getByRole("button", { name: "Yes, start the day" }));
    expect(api).toHaveBeenCalledWith("/day/start/", { method: "POST", body: { opening_float: "20000.00" } });
  });

  it("lets the Owner start from a different opening balance, with a reason", async () => {
    render(<StartDayPage />);
    await userEvent.click(change()!);
    const amount = screen.getByLabelText("New opening cumulative sales balance (TZS)");
    expect(amount).toHaveValue("1250000");
    await userEvent.clear(amount);
    await userEvent.type(amount, "1300000");
    expect(startButton()).toBeDisabled(); // no reason yet
    await userEvent.type(screen.getByLabelText("Reason for the change"), "Checked against the bank book");
    expect(startButton()).toBeEnabled();
    await userEvent.click(startButton());
    expect(screen.getByRole("alertdialog")).toHaveTextContent("opening balance of TZS 1,300,000 instead of TZS 1,250,000");
    await userEvent.click(screen.getByRole("button", { name: "Yes, start the day" }));
    expect(api).toHaveBeenCalledWith("/day/start/", { method: "POST", body: {
      opening_float: "0.00", opening_cumulative_sales: "1300000.00", opening_reason: "Checked against the bank book",
    } });
  });

  it("sends no change when the Owner leaves the carried figure as it is, or presses Keep", async () => {
    render(<StartDayPage />);
    await userEvent.click(change()!);
    expect(screen.queryByLabelText("Reason for the change")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Keep the carried balance" }));
    expect(change()).toBeInTheDocument();
    await userEvent.click(startButton());
    await userEvent.click(screen.getByRole("button", { name: "Yes, start the day" }));
    expect(api).toHaveBeenCalledWith("/day/start/", { method: "POST", body: { opening_float: "0.00" } });
  });

  it("does not offer the change to an Accountant or a Cashier", () => {
    for (const role of ["ACCOUNTANT", "CASHIER"] as Role[]) {
      auth.role = role;
      const { unmount } = render(<StartDayPage />);
      expect(change()).toBeNull();
      unmount();
    }
  });

  it("once the day is open, points the Owner to Daily Closing instead", () => {
    load.data = today({ id: 1, date: "2026-11-02", status: "OPEN", opening_cumulative_sales: "1250000.00" } as CurrentDay["day"]);
    render(<StartDayPage />);
    expect(change()).toBeNull();
    expect(screen.getByRole("link", { name: "Daily Closing" })).toHaveAttribute("href", "/closing");
  });
});
