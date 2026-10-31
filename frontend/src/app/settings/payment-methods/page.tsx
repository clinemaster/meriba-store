"use client";

import { useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner, StatusBadge, useConfirm } from "@/components/ui";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatTime } from "@/lib/money";
import { CATEGORY_ICONS, iconFor } from "@/lib/payments";
import type { PaymentMethod, PaymentProvider } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

type CategoryForm = { id?: number; name: string; description: string; icon: string; is_cash: boolean; requires_provider: boolean; reference_label: string };
type ProviderForm = { id?: number; category: number; name: string; description: string };
type HistoryEntry = { id: number; created_at: string; actor_username: string; action: string; summary: string; before: unknown; after: unknown };

const EMPTY_CATEGORY: CategoryForm = { name: "", description: "", icon: "other", is_cash: false, requires_provider: true, reference_label: "" };

/** Moves one item to a new place in a list (for drag-and-drop and the ↑ ↓ buttons). */
function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Settings → Payment methods. The Owner adds and changes categories and providers here, with no new version of the
 * system needed; cashiers' sale windows read the new list the next time they open. The Accountant can look but not change.
 */
export default function PaymentMethodsPage() {
  const { user } = useAuth();
  const owner = user?.role === "OWNER";
  const methods = useLoad<PaymentMethod[]>("/payment-methods/");
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"all" | "on" | "off">("all");
  const [editing, setEditing] = useState<CategoryForm | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ list: string; index: number } | null>(null);
  const { confirm, confirmation, asking } = useConfirm();

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return false;
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      await action();
      setSaved(done);
      methods.reload();
      return true;
    } catch (err) {
      setProblem(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (methods.loading && !methods.data) return <Spinner />;
  if (methods.error) return <Alert kind="error">{methods.error}</Alert>;
  const all = methods.data ?? [];
  const needle = search.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const visible = all.filter((m) => (show === "all" || (show === "on") === m.is_active)
    && (matches(m.name) || matches(m.description ?? "") || (m.providers ?? []).some((p) => matches(p.name))));
  const reorderable = owner && !needle && show === "all";

  function reorder(path: string, ids: number[], label: string) {
    return run(() => api(`/${path}/reorder/`, { method: "POST", body: { ids } }), `New order of ${label} saved.`);
  }
  function toggle(kind: "category" | "provider", item: PaymentMethod | PaymentProvider, extra = "") {
    const path = kind === "category" ? "payment-methods" : "payment-providers";
    confirm({
      message: item.is_active
        ? `Switch off ${item.name}? Cashiers will no longer be able to choose it for new sales. Past payments and receipts keep it.${extra}`
        : `Switch on ${item.name}? Cashiers will be able to choose it the next time they open the sale window.`,
      yes: item.is_active ? "Yes, switch off" : "Yes, switch on",
      run: () => run(() => api(`/${path}/${item.id}/`, { method: "PATCH", body: { is_active: !item.is_active } }), `${item.name} switched ${item.is_active ? "off" : "on"}.`),
    });
  }
  function remove(kind: "category" | "provider", item: PaymentMethod | PaymentProvider) {
    const path = kind === "category" ? "payment-methods" : "payment-providers";
    confirm({
      message: `Delete ${item.name}? It has never been used, so nothing else changes. This is recorded in the history.`,
      yes: "Yes, delete", danger: true,
      run: () => run(() => api(`/${path}/${item.id}/`, { method: "DELETE" }), `${item.name} deleted.`),
    });
  }

  /** Drag handlers for one list. Dropping saves the new order at once; ↑ ↓ do the same from the keyboard. */
  function dragProps(list: string, index: number, ids: number[], path: string, label: string) {
    if (!reorderable) return {};
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = "move"; setDrag({ list, index }); },
      onDragOver: (e: React.DragEvent) => { if (drag?.list === list) e.preventDefault(); },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (drag?.list === list && drag.index !== index) reorder(path, moved(ids, drag.index, index), label);
        setDrag(null);
      },
      onDragEnd: () => setDrag(null),
    };
  }
  function MoveButtons({ ids, index, path, label, name }: { ids: number[]; index: number; path: string; label: string; name: string }) {
    if (!reorderable) return null;
    return (
      <span className="inline-flex gap-1">
        <button type="button" className="btn-secondary min-h-[2.25rem] px-2" aria-label={`Move ${name} up`} disabled={busy || index === 0}
          onClick={() => reorder(path, moved(ids, index, index - 1), label)}>↑</button>
        <button type="button" className="btn-secondary min-h-[2.25rem] px-2" aria-label={`Move ${name} down`} disabled={busy || index === ids.length - 1}
          onClick={() => reorder(path, moved(ids, index, index + 1), label)}>↓</button>
      </span>
    );
  }

  const categoryIds = all.map((m) => m.id);
  return (
    <div className="max-w-5xl space-y-5">
      <PageTitle title="Payment methods" help={owner
        ? "Payment categories (Cash, Mobile Money, Bank, …) and their providers (M-PESA, NMB, …). Changes reach the cashiers' sale window the next time it opens. Anything already used in a payment is kept; switch it off instead."
        : "The payment categories and providers in use. Only the Owner can change them."}
        action={<div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => setHistoryOpen(true)}>Change history</button>
          {owner && <button className="btn-primary" onClick={() => setEditing({ ...EMPTY_CATEGORY })}>+ Add category</button>}
        </div>} />
      {saved && <Alert kind="success">{saved}</Alert>}
      {problem && <Alert kind="error">{problem}</Alert>}

      <div className="card no-print flex flex-wrap items-end gap-3">
        <label className="block min-w-[16rem] flex-1"><span className="mb-1 block font-semibold">Search categories and providers</span>
          <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="For example M-PESA or Bank" /></label>
        <label className="block"><span className="mb-1 block font-semibold">Show</span>
          <select className="input" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
            <option value="all">All</option><option value="on">Switched on</option><option value="off">Switched off</option>
          </select></label>
        {owner && !reorderable && <p className="text-sm text-slate-600">Clear the search and show “All” to change the order.</p>}
        {reorderable && <p className="text-sm text-slate-600">Drag a card or a provider to change the order, or use ↑ ↓.</p>}
      </div>

      {visible.length === 0 && <p className="text-slate-600">Nothing matches “{search}”.</p>}
      <ol className="space-y-4">
        {visible.map((m) => {
          const index = categoryIds.indexOf(m.id);
          const providers = (m.providers ?? []).filter((p) => !needle || matches(p.name) || matches(m.name));
          const providerIds = (m.providers ?? []).map((p) => p.id);
          const onCount = (m.providers ?? []).filter((p) => p.is_active).length;
          return (
            <li key={m.id} className={`card ${drag?.list === "categories" && drag.index === index ? "opacity-50" : ""}`}
              {...dragProps("categories", index, categoryIds, "payment-methods", "payment categories")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  {reorderable && <span aria-hidden className="mt-1 cursor-grab select-none text-slate-400" title="Drag to reorder">⠿</span>}
                  <span aria-hidden className="text-3xl">{iconFor(m.icon)}</span>
                  <div>
                    <h2 className="text-xl font-bold">{m.name} <span className="text-sm font-normal text-slate-500">({m.code})</span></h2>
                    {m.description && <p className="text-slate-700">{m.description}</p>}
                    <p className="text-sm text-slate-600">
                      {m.is_cash ? "Cash kept in the drawer, counted at closing" : m.requires_provider ? "A provider must be chosen for every payment" : "No provider needed"}
                      {m.reference_label ? ` · asks for “${m.reference_label}”` : ""}
                    </p>
                    {m.requires_provider && m.is_active && onCount === 0 && (
                      <p className="mt-1 text-sm font-semibold text-amber-900">⚠ No provider is switched on, so cashiers cannot choose {m.name}.</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={m.is_active ? "OPEN" : "OFF"} label={m.is_active ? "Switched on" : "Switched off"} />
                  <MoveButtons ids={categoryIds} index={index} path="payment-methods" label="payment categories" name={m.name} />
                  {owner && <>
                    <button className="btn-secondary min-h-[2.25rem]" disabled={busy || asking} onClick={() => setEditing({
                      id: m.id, name: m.name, description: m.description ?? "", icon: m.icon ?? "other", is_cash: m.is_cash,
                      requires_provider: !!m.requires_provider, reference_label: m.reference_label })}>Edit</button>
                    <button className="btn-secondary min-h-[2.25rem]" disabled={busy || asking} onClick={() => toggle("category", m)}>{m.is_active ? "Switch off" : "Switch on"}</button>
                    {!m.in_use && <button className="btn-secondary min-h-[2.25rem] text-red-800" disabled={busy || asking} onClick={() => remove("category", m)}>Delete</button>}
                  </>}
                </div>
              </div>

              {!m.is_cash && (
                <div className="mt-4 border-t border-slate-200 pt-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-bold">Providers <span className="font-normal text-slate-600">({onCount} switched on)</span></h3>
                    {owner && <button className="btn-secondary min-h-[2.25rem]" onClick={() => setProviderForm({ category: m.id, name: "", description: "" })}>+ Add provider</button>}
                  </div>
                  {providers.length === 0 ? <p className="text-sm text-slate-600">No providers{needle ? " match the search" : " yet"}.</p> : (
                    <ol className="divide-y divide-slate-200 rounded-lg border border-slate-200">
                      {providers.map((p) => {
                        const at = providerIds.indexOf(p.id);
                        const list = `providers-${m.id}`;
                        return (
                          <li key={p.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 ${drag?.list === list && drag.index === at ? "opacity-50" : ""}`}
                            {...dragProps(list, at, providerIds, "payment-providers", `${m.name} providers`)}
                            onDragStart={reorderable ? (e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; setDrag({ list, index: at }); } : undefined}>
                            <div className="flex items-center gap-2">
                              {reorderable && <span aria-hidden className="cursor-grab select-none text-slate-400">⠿</span>}
                              <span className={`font-semibold ${p.is_active ? "" : "text-slate-500 line-through"}`}>{p.name}</span>
                              {p.description && <span className="text-sm text-slate-600">· {p.description}</span>}
                              {!p.is_active && <span className="text-sm text-slate-600">(switched off)</span>}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <MoveButtons ids={providerIds} index={at} path="payment-providers" label={`${m.name} providers`} name={p.name} />
                              {owner && <>
                                <button className="btn-secondary min-h-[2.25rem]" disabled={busy || asking} onClick={() => setProviderForm({ id: p.id, category: m.id, name: p.name, description: p.description })}>Edit</button>
                                <button className="btn-secondary min-h-[2.25rem]" disabled={busy || asking} onClick={() => toggle("provider", p)}>{p.is_active ? "Switch off" : "Switch on"}</button>
                                {!p.in_use && <button className="btn-secondary min-h-[2.25rem] text-red-800" disabled={busy || asking} onClick={() => remove("provider", p)}>Delete</button>}
                              </>}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {editing && (
        <CategoryEditor form={editing} busy={busy} problem={problem} onClose={() => { setEditing(null); setProblem(null); }}
          onSave={async (form) => {
            const body = { name: form.name, description: form.description, icon: form.icon, is_cash: form.is_cash,
                           requires_provider: form.is_cash ? false : form.requires_provider, reference_label: form.reference_label };
            const ok = await run(() => api(form.id ? `/payment-methods/${form.id}/` : "/payment-methods/", { method: form.id ? "PATCH" : "POST", body }),
              form.id ? `${form.name} saved.` : `${form.name} added.${body.requires_provider ? " Now add its providers." : ""}`);
            if (ok) setEditing(null);
          }} />
      )}
      {providerForm && (
        <Modal title={providerForm.id ? `Edit ${providerForm.name}` : `Add a ${all.find((m) => m.id === providerForm.category)?.name} provider`} onClose={() => { setProviderForm(null); setProblem(null); }}>
          <div className="space-y-3">
            <Field label="Name" hint="As cashiers should see it, e.g. M-PESA or NMB. Names must be different within a category.">
              {(p) => <input {...p} className="input" maxLength={60} autoFocus value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} />}
            </Field>
            <Field label="Description (optional)">
              {(p) => <input {...p} className="input" maxLength={200} value={providerForm.description} onChange={(e) => setProviderForm({ ...providerForm, description: e.target.value })} />}
            </Field>
            {providerForm.id && <p className="text-sm text-slate-600">Renaming changes how it appears from now on. Receipts already printed keep the old name.</p>}
          </div>
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" disabled={busy || providerForm.name.trim().length < 2} onClick={async () => {
              const body = { category: providerForm.category, name: providerForm.name, description: providerForm.description };
              const ok = await run(() => api(providerForm.id ? `/payment-providers/${providerForm.id}/` : "/payment-providers/", {
                method: providerForm.id ? "PATCH" : "POST", body: providerForm.id ? { name: body.name, description: body.description } : body }),
              `${providerForm.name.trim()} saved.`);
              if (ok) setProviderForm(null);
            }}>{busy ? "Saving…" : "Save provider"}</button>
            <button className="btn-secondary" onClick={() => setProviderForm(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {historyOpen && <ConfigHistory onClose={() => setHistoryOpen(false)} />}
      {confirmation}
    </div>
  );
}

function CategoryEditor({ form: initial, busy, problem, onClose, onSave }: {
  form: CategoryForm; busy: boolean; problem: string | null; onClose: () => void; onSave: (form: CategoryForm) => void;
}) {
  const [form, setForm] = useState(initial);
  return (
    <Modal title={form.id ? `Edit ${initial.name}` : "Add a payment category"} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="For example Card or Cheque.">
          {(p) => <input {...p} className="input" maxLength={40} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
        <Field label="Reference to ask for (optional)" hint="For example Transaction ID.">
          {(p) => <input {...p} className="input" maxLength={40} value={form.reference_label} onChange={(e) => setForm({ ...form, reference_label: e.target.value })} />}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description (optional)">
            {(p) => <input {...p} className="input" maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
          </Field>
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1 font-semibold">Icon</legend>
          <div className="flex flex-wrap gap-2">
            {Object.entries(CATEGORY_ICONS).map(([key, icon]) => (
              <button key={key} type="button" role="radio" aria-checked={form.icon === key} aria-label={icon.label} onClick={() => setForm({ ...form, icon: key })}
                className={`btn min-h-[2.75rem] border-2 px-3 text-xl ${form.icon === key ? "border-brand-700 bg-brand-50" : "border-slate-300 bg-white"}`}>
                <span aria-hidden>{icon.glyph}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex items-start gap-3 sm:col-span-2">
          <input type="checkbox" className="mt-1 h-6 w-6" checked={form.is_cash} disabled={!!initial.id}
            onChange={(e) => setForm({ ...form, is_cash: e.target.checked, requires_provider: e.target.checked ? false : form.requires_provider })} />
          <span>It is cash kept in the drawer (counted at closing){initial.id ? <span className="block text-sm text-slate-600">Fixed once the category exists.</span> : null}</span>
        </label>
        <label className="flex items-start gap-3 sm:col-span-2">
          <input type="checkbox" className="mt-1 h-6 w-6" checked={form.requires_provider && !form.is_cash} disabled={form.is_cash}
            onChange={(e) => setForm({ ...form, requires_provider: e.target.checked })} />
          <span>Cashiers must choose a provider for every payment (like M-PESA for Mobile Money, or NMB for Bank)</span>
        </label>
      </div>
      {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
      <div className="mt-4 flex gap-3">
        <button className="btn-primary" disabled={busy || form.name.trim().length < 2} onClick={() => onSave(form)}>{busy ? "Saving…" : "Save category"}</button>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function ConfigHistory({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(1);
  const history = useLoad<Page<HistoryEntry>>(`/payment-methods/history/?page=${page}`);
  const pages = Math.max(1, Math.ceil((history.data?.count ?? 0) / 25));
  return (
    <Modal title="Payment method change history" onClose={onClose} wide>
      {history.loading && !history.data ? <Spinner /> : history.error ? <Alert kind="error">{history.error}</Alert> : (history.data?.results.length ?? 0) === 0 ? (
        <p className="text-slate-600">No changes recorded yet.</p>
      ) : (
        <>
          <ol className="max-h-[60vh] space-y-2 overflow-y-auto">
            {history.data!.results.map((h) => (
              <li key={h.id} className="rounded border border-slate-200 p-2 text-sm">
                <div className="font-semibold">{h.summary}</div>
                <div className="text-slate-600">{formatDate(h.created_at)} {formatTime(h.created_at)} · {h.actor_username || "system"}</div>
                {h.before != null && h.after != null && <ChangeLines before={h.before} after={h.after} />}
              </li>
            ))}
          </ol>
          {pages > 1 && (
            <div className="mt-3 flex items-center gap-3">
              <button className="btn-secondary min-h-[2.25rem]" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</button>
              <span>Page {page} of {pages}</span>
              <button className="btn-secondary min-h-[2.25rem]" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older →</button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function ChangeLines({ before, after }: { before: unknown; after: unknown }) {
  const b = (before ?? {}) as Record<string, unknown>, a = (after ?? {}) as Record<string, unknown>;
  const keys = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (keys.length === 0) return null;
  const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === true ? "yes" : v === false ? "no" : v === "" || v == null ? "—" : String(v));
  return <ul className="mt-1 text-slate-700">{keys.map((k) => <li key={k}>{k.replace(/_/g, " ")}: {show(b[k])} → {show(a[k])}</li>)}</ul>;
}
