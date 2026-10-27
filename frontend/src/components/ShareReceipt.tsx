"use client";

import { useState } from "react";

import { Alert } from "./ui";
import { formatDate, formatQty, formatTime, formatTZS } from "@/lib/money";
import type { Sale, ShopSettings } from "@/lib/types";

function receiptText(sale: Sale, shop: ShopSettings | null): string {
  const lines = [
    shop?.receipt_header || "MERIBA STORE",
    shop?.branch_name,
    `Receipt: ${sale.receipt_number}`,
    `Date: ${formatDate(sale.created_at)} ${formatTime(sale.created_at)}`,
    `Served by: ${sale.cashier_name}`,
    "",
    ...sale.items.flatMap((item) => [
      item.product_name,
      `${formatQty(item.quantity)} ${item.unit_name} x ${formatTZS(item.unit_price).replace("TZS ", "")} = ${formatTZS(item.line_total).replace("TZS ", "")}`,
    ]),
    "",
    `TOTAL: ${formatTZS(sale.total)}`,
    `Paid by: ${[...new Set(sale.payments.map((payment) => payment.method_name))].join(", ")}`,
    ...(Number(sale.change_due) > 0 ? [`Change: ${formatTZS(sale.change_due)}`] : []),
    shop?.receipt_footer,
  ];
  return lines.filter((line) => line !== undefined && line !== "").join("\n");
}

export function ShareReceipt({ sale, shop }: { sale: Sale; shop: ShopSettings | null }) {
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function share() {
    const text = receiptText(sale, shop);
    setMessage(null);

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `Receipt ${sale.receipt_number}`, text });
        setMessage({ kind: "success", text: "Receipt shared." });
        return;
      } catch (err) {
        if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") return;
      }
    }

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(text);
      setMessage({ kind: "success", text: "Receipt details copied. Paste them into WhatsApp, a text message or another app." });
    } catch {
      setMessage({ kind: "error", text: "Could not share or copy the receipt here. You can still print the receipt." });
    }
  }

  return (
    <div className="no-print space-y-2">
      <button type="button" className="btn-secondary" onClick={share}>Share receipt</button>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
    </div>
  );
}
