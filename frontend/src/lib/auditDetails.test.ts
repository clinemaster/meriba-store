import { describe, expect, it } from "vitest";

import { type AuditEntry, changeRows, plainValue, recordLabel } from "./auditDetails";

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1, created_at: "2026-10-22T00:45:00Z", actor_username: "mwombeki", action: "shift.approved", entity_type: "CashierShift",
  entity_id: "3", summary: "", reason: "Approved", before: null, after: null, product_names: {}, status_labels: {}, ...over,
});

describe("audit details", () => {
  it("explains an approved cashier shift in words", () => {
    const e = entry({
      before: { status: "PENDING" }, after: { status: "APPROVED", cash_variance: "0.00" },
      status_labels: { PENDING: "Waiting for payment checks", APPROVED: "Reviewed and approved" },
    });
    expect(recordLabel(e)).toBe("Cashier shift no. 3");
    const { rows, both } = changeRows(e);
    expect(both).toBe(true);
    expect(rows.map((r) => [r.label, r.changed])).toEqual([["Status", true], ["Cash difference", true]]);
    expect(plainValue("status", "PENDING", e)).toBe("Waiting for payment checks");
    expect(plainValue("status", "APPROVED", e)).toBe("Reviewed and approved");
    expect(plainValue("cash_variance", "0.00", e)).toBe("None: the cash matched");
    expect(plainValue("cash_variance", "-1500.00", e)).toBe("TZS 1,500 short");
  });

  it("formats money, yes/no, dates and unknown codes", () => {
    const e = entry({});
    expect(plainValue("selling_price", "13000.00", e)).toBe("TZS 13,000");
    expect(plainValue("is_active", true, e)).toBe("Yes");
    expect(plainValue("as_of", null, e)).toBe("—");
    expect(plainValue("resolution", "DATA_ENTRY_ERROR", e)).toBe("Data entry error");
    expect(plainValue("reorder_point", "9.000", e)).toBe("9");
    expect(plainValue("payments", { cash: "1.00" }, e)).toBe("");
  });

  it("groups a stock count's product quantities under one row, by product name", () => {
    const e = entry({ entity_type: "OpeningCount", after: { "4": "30.000", "7": "20.000" }, product_names: { "4": "Henken ndogo 330ml" } });
    const { rows, both, side } = changeRows(e);
    expect(both).toBe(false);
    expect(side).toBe("Recorded");
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Quantities");
    expect(rows[0].after).toEqual({ "4": "30.000", "7": "20.000" });
  });

  it("leaves technical fields out of the table", () => {
    const { rows } = changeRows(entry({ after: { file: "a.xlsx", file_hash: "abc", batch: "x" } }));
    expect(rows.map((r) => r.key)).toEqual(["file"]);
  });
});
