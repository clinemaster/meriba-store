import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatusBadge, statusKind } from "@/components/ui";

afterEach(cleanup);

describe("status colours keep one meaning everywhere", () => {
  it("groups the shop's states by meaning", () => {
    expect(["COMPLETED", "BALANCED", "APPROVED", "OPEN"].map(statusKind)).toEqual(["success", "success", "success", "success"]);
    expect(["PENDING", "PENDING_REVIEW", "NOT_STARTED"].map(statusKind)).toEqual(["warning", "warning", "warning"]);
    expect(["VOIDED", "DISCREPANCY", "REJECTED", "REVERSED"].map(statusKind)).toEqual(["danger", "danger", "danger", "danger"]);
  });

  it("shows switched-off and closed things in grey, not as a warning", () => {
    expect(statusKind("OFF")).toBe("neutral");
    expect(statusKind("CLOSED")).toBe("neutral");
  });

  it("tells refunds apart from cancellations", () => {
    expect(statusKind("REFUNDED")).toBe("refund");
    expect(statusKind("REFUNDED")).not.toBe(statusKind("VOIDED"));
  });

  it("treats an unknown status as needing attention, so it is never missed", () => {
    expect(statusKind("SOMETHING_NEW")).toBe("warning");
  });

  it("never rests on colour alone: an icon and the word are always shown", () => {
    render(<StatusBadge status="VOIDED" label="Cancelled" />);
    const badge = screen.getByText("Cancelled");
    expect(badge).toHaveTextContent("✕Cancelled");
    expect(badge.className).toContain("bg-danger-soft");
  });
});
