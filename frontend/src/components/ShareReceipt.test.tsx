import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Sale, ShopSettings } from "@/lib/types";

import { ShareReceipt } from "./ShareReceipt";

const sale = {
  id: 1, receipt_number: "MB-20261015-0001", status: "COMPLETED", status_label: "Completed", business_date: "2026-10-15",
  created_at: "2026-10-15T09:00:00Z", cashier_name: "Asha", subtotal: "2400.00", total: "2400.00", amount_tendered: "3000.00", change_due: "600.00",
  items: [{ id: 1, product_name: "Soda", unit_name: "Bottle", quantity: "2.000", unit_price: "1200.00", line_total: "2400.00" }],
  payments: [{ id: 1, method_name: "Mobile Money", is_cash: false, amount: "2400.00", tendered: "2400.00", reference: "SECRET-REF", status: "RECORDED" }],
  void_reason: "", voided_by_name: "",
} satisfies Sale;
const shop = { branch_name: "Main Branch", receipt_header: "MERIBA STORE", receipt_footer: "Thank you" } as ShopSettings;

beforeEach(() => { vi.stubGlobal("navigator", {}); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("share receipt", () => {
  it("shares receipt details through the native share sheet without payment references", async () => {
    const nativeShare = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share: nativeShare });
    render(<ShareReceipt sale={sale} shop={shop} />);
    fireEvent.click(screen.getByRole("button", { name: "Share receipt" }));

    await waitFor(() => expect(nativeShare).toHaveBeenCalledTimes(1));
    const shared = nativeShare.mock.calls[0][0] as ShareData;
    expect(shared.title).toBe("Receipt MB-20261015-0001");
    expect(shared.text).toContain("Soda");
    expect(shared.text).toContain("TOTAL: TZS 2,400");
    expect(shared.text).toContain("Paid by: Mobile Money");
    expect(shared.text).not.toContain("SECRET-REF");
    expect(await screen.findByText("Receipt shared.")).toBeInTheDocument();
  });

  it("does not copy or report an error when the customer cancels native sharing", async () => {
    const nativeShare = vi.fn().mockRejectedValue(new DOMException("Share dismissed", "AbortError"));
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { share: nativeShare, clipboard: { writeText } });
    render(<ShareReceipt sale={sale} shop={shop} />);
    fireEvent.click(screen.getByRole("button", { name: "Share receipt" }));

    await waitFor(() => expect(nativeShare).toHaveBeenCalledTimes(1));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("copies receipt details when native sharing is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ShareReceipt sale={sale} shop={shop} />);
    fireEvent.click(screen.getByRole("button", { name: "Share receipt" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("Receipt: MB-20261015-0001");
    expect(await screen.findByText(/Receipt details copied/)).toBeInTheDocument();
  });

  it("reports when sharing and copying are unavailable", async () => {
    render(<ShareReceipt sale={sale} shop={shop} />);
    fireEvent.click(screen.getByRole("button", { name: "Share receipt" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not share or copy the receipt here");
  });
});
