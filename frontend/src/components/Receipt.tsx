import { formatDate, formatQty, formatTime, formatTZS } from "@/lib/money";
import type { Sale, ShopSettings } from "@/lib/types";

export function Receipt({ sale, shop }: { sale: Sale; shop: ShopSettings | null }) {
  return (
    <div className="print-area mx-auto w-full max-w-sm rounded-lg border border-slate-300 bg-white p-4 font-mono text-sm">
      <div className="text-center">
        <div className="text-base font-bold">{shop?.receipt_header || "MERIBA STORE"}</div>
        <div>{shop?.branch_name}</div>
      </div>
      <div className="my-2 border-t border-dashed border-slate-400" />
      <div>Receipt: {sale.receipt_number}</div>
      <div>Date: {formatDate(sale.created_at)} {formatTime(sale.created_at)}</div>
      <div>Served by: {sale.cashier_name}</div>
      {sale.status === "VOIDED" && <div className="mt-1 text-center font-bold">*** CANCELLED ***</div>}
      <div className="my-2 border-t border-dashed border-slate-400" />
      {sale.items.map((item) => (
        <div key={item.id} className="mb-1">
          <div>{item.product_name}</div>
          <div className="flex justify-between">
            <span>{formatQty(item.quantity)} {item.unit_name} x {formatTZS(item.unit_price).replace("TZS ", "")}</span>
            <span>{formatTZS(item.line_total).replace("TZS ", "")}</span>
          </div>
        </div>
      ))}
      <div className="my-2 border-t border-dashed border-slate-400" />
      <div className="flex justify-between text-base font-bold"><span>TOTAL</span><span>{formatTZS(sale.total)}</span></div>
      {sale.payments.map((p) => (
        <div key={p.id} className="flex justify-between">
          <span>{p.method_name}{p.reference ? ` (${p.reference})` : ""}</span>
          <span>{formatTZS(p.is_cash ? p.tendered : p.amount).replace("TZS ", "")}</span>
        </div>
      ))}
      {Number(sale.change_due) > 0 && (
        <div className="flex justify-between font-bold"><span>Change</span><span>{formatTZS(sale.change_due).replace("TZS ", "")}</span></div>
      )}
      <div className="my-2 border-t border-dashed border-slate-400" />
      <div className="text-center">{shop?.receipt_footer}</div>
    </div>
  );
}
