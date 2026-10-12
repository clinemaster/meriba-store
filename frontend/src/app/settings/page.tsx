"use client";

import { useEffect, useState } from "react";

import { Alert, Field, PageTitle, Spinner, StatusBadge } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { centsToApi, formatTZS, toCents } from "@/lib/money";
import type { PaymentMethod, ShopSettings } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

export default function SettingsPage() {
  const shop = useLoad<ShopSettings>("/settings/");
  const methods = useLoad<PaymentMethod[]>("/payment-methods/");
  const [form, setForm] = useState({ branch_name: "", receipt_header: "", receipt_footer: "", split: true, tolerance: "0" });
  const [newMethod, setNewMethod] = useState({ name: "", is_cash: false, reference_label: "" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (shop.data) {
      setForm({ branch_name: shop.data.branch_name, receipt_header: shop.data.receipt_header, receipt_footer: shop.data.receipt_footer,
                split: shop.data.split_payments_enabled, tolerance: String(Number(shop.data.cash_variance_tolerance)) });
    }
  }, [shop.data]);

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      await action();
      setSaved(done);
      shop.reload();
      methods.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if ((shop.loading && !shop.data) || (methods.loading && !methods.data)) return <Spinner />;
  if (shop.error) return <Alert kind="error">{shop.error}</Alert>;
  const activeCount = (methods.data ?? []).filter((m) => m.is_active).length;

  return (
    <div className="max-w-3xl space-y-6">
      <PageTitle title="Settings" help="Shop details, what is printed on receipts, and the payment methods you accept. Every change here is recorded in the audit history." />
      {saved && <Alert kind="success">{saved}</Alert>}
      {problem && <Alert kind="error">{problem}</Alert>}

      <form className="card space-y-4" noValidate onSubmit={(e) => {
        e.preventDefault();
        run(() => api("/settings/", { method: "PATCH", body: {
          branch_name: form.branch_name, receipt_header: form.receipt_header, receipt_footer: form.receipt_footer,
          split_payments_enabled: form.split, cash_variance_tolerance: centsToApi(toCents(form.tolerance)) } }), "Settings saved.");
      }}>
        <h2 className="text-xl font-bold">Shop and receipt</h2>
        <Field label="Branch name">{(p) => <input {...p} className="input" maxLength={120} value={form.branch_name} onChange={(e) => setForm({ ...form, branch_name: e.target.value })} />}</Field>
        <Field label="Top line of the receipt" hint="Usually the shop name.">{(p) => <input {...p} className="input" maxLength={200} value={form.receipt_header} onChange={(e) => setForm({ ...form, receipt_header: e.target.value })} />}</Field>
        <Field label="Bottom line of the receipt" hint="For example a thank-you message or phone number.">{(p) => <input {...p} className="input" maxLength={200} value={form.receipt_footer} onChange={(e) => setForm({ ...form, receipt_footer: e.target.value })} />}</Field>
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 h-6 w-6" checked={form.split} onChange={(e) => setForm({ ...form, split: e.target.checked })} />
          <span>Allow one sale to be paid with more than one method (for example part cash, part mobile money)</span>
        </label>
        <Field label="Cash difference allowed at closing (TZS)" hint={`A drawer that is short or over by up to this amount counts as balanced. Now: ${formatTZS(toCents(form.tolerance), true)}. Use 0 to have every difference reviewed.`}>
          {(p) => <input {...p} className="input max-w-xs" inputMode="numeric" value={form.tolerance} onChange={(e) => setForm({ ...form, tolerance: e.target.value })} />}
        </Field>
        <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
      </form>

      <section className="card space-y-4">
        <h2 className="text-xl font-bold">Payment methods</h2>
        <p className="text-slate-700">Cashiers see only the methods that are switched on. A method that has been used is never deleted; switch it off instead.</p>
        <table className="table">
          <thead><tr><th>Method</th><th>Counts as cash in the drawer?</th><th>Reference asked for</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(methods.data ?? []).map((m) => (
              <tr key={m.id}>
                <td className="font-semibold">{m.name}</td>
                <td>{m.is_cash ? "Yes" : "No"}</td>
                <td>{m.reference_label || "—"}</td>
                <td><StatusBadge status={m.is_active ? "OPEN" : "OFF"} label={m.is_active ? "Switched on" : "Switched off"} /></td>
                <td className="text-right">
                  <button className="btn-secondary min-h-[2.5rem]" disabled={busy || (m.is_active && activeCount === 1)}
                    title={m.is_active && activeCount === 1 ? "At least one payment method must stay on" : undefined}
                    onClick={() => run(() => api(`/payment-methods/${m.id}/`, { method: "PATCH", body: { is_active: !m.is_active } }), `${m.name} switched ${m.is_active ? "off" : "on"}.`)}>
                    {m.is_active ? "Switch off" : "Switch on"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-3" noValidate onSubmit={(e) => {
          e.preventDefault();
          const name = newMethod.name.trim();
          if (name.length < 2) return setProblem("Enter the name of the payment method.");
          const code = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
          run(async () => {
            await api("/payment-methods/", { method: "POST", body: { code, name, is_cash: newMethod.is_cash, reference_label: newMethod.reference_label, sort_order: (methods.data?.length ?? 0) + 1 } });
            setNewMethod({ name: "", is_cash: false, reference_label: "" });
          }, `${name} added.`);
        }}>
          <Field label="Add a payment method" hint="For example Airtel Money, Card.">{(p) => <input {...p} className="input" maxLength={40} value={newMethod.name} onChange={(e) => setNewMethod({ ...newMethod, name: e.target.value })} />}</Field>
          <Field label="Reference to ask for (optional)" hint="For example Transaction ID.">{(p) => <input {...p} className="input" maxLength={40} value={newMethod.reference_label} onChange={(e) => setNewMethod({ ...newMethod, reference_label: e.target.value })} />}</Field>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={newMethod.is_cash} onChange={(e) => setNewMethod({ ...newMethod, is_cash: e.target.checked })} /> It is cash kept in the drawer</label>
            <button className="btn-secondary" disabled={busy}>Add method</button>
          </div>
        </form>
      </section>
    </div>
  );
}
