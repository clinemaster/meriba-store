"use client";

import { useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner, StatusBadge, useConfirm } from "@/components/ui";
import { ColumnPicker } from "@/components/ColumnPicker";
import type { ColumnDef } from "@/lib/columns";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { api, ApiError, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/money";
import type { Role, User } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const ROLES: { value: Role; label: string; help: string }[] = [
  { value: "CASHIER", label: "Cashier", help: "Sells, prints receipts and closes their own day. Sees nothing else." },
  { value: "ACCOUNTANT", label: "Accountant", help: "Sees all sales, stock and closings, and makes corrections. Cannot manage users or settings." },
  { value: "OWNER", label: "Owner", help: "Can do everything, including managing users and settings." },
];

const COLUMNS: ColumnDef[] = [
  { key: "name", label: "Name", essential: true }, { key: "username", label: "Username" }, { key: "role", label: "Role" },
  { key: "status", label: "Status" }, { key: "login", label: "Last signed in" },
];

export default function UsersPage() {
  const cols = useColumnVisibility("users", COLUMNS);
  const { user: me } = useAuth();
  const list = useLoad<Page<User>>("/users/?page_size=200");
  const [mode, setMode] = useState<{ kind: "new" } | { kind: "edit" | "password"; user: User } | null>(null);
  const [form, setForm] = useState({ username: "", full_name: "", role: "CASHIER" as Role, password: "", is_active: true });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmation, asking } = useConfirm();

  function open(next: typeof mode) {
    setMode(next);
    setProblem(null);
    setForm(next && next.kind !== "new"
      ? { username: next.user.username, full_name: next.user.full_name, role: next.user.role, password: "", is_active: next.user.is_active }
      : { username: "", full_name: "", role: "CASHIER", password: "", is_active: true });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !mode) return;
    const changes: string[] = [];
    if (mode.kind === "edit") {
      const name = mode.user.display_name;
      if (mode.user.role !== form.role) changes.push(`Change ${name}'s role to ${form.role.toLowerCase()}? This changes what they can see and do.`);
      if (mode.user.is_active && !form.is_active) changes.push(`Switch off ${name}'s account? They will no longer be able to sign in.`);
      if (!mode.user.is_active && form.is_active) changes.push(`Switch ${name}'s account back on? They will be able to sign in again.`);
    }
    if (mode.kind === "password") changes.push(`Give ${mode.user.display_name} a new password? Their old password stops working at once.`);
    if (changes.length === 0) return persist();
    confirm({ message: changes.join(" "), yes: "Yes, save", run: persist });
  }

  async function persist() {
    if (busy || !mode) return;
    setBusy(true);
    setProblem(null);
    try {
      if (mode.kind === "new") await api("/users/", { method: "POST", body: { username: form.username.trim(), full_name: form.full_name.trim(), role: form.role, password: form.password } });
      else if (mode.kind === "edit") await api(`/users/${mode.user.id}/`, { method: "PATCH", body: { full_name: form.full_name.trim(), role: form.role, is_active: form.is_active } });
      else await api(`/users/${mode.user.id}/reset-password/`, { method: "POST", body: { password: form.password } });
      setMode(null);
      list.reload();
    } catch (err) {
      const fields = err instanceof ApiError && err.errors ? Object.values(err.errors).flat().join(" ") : "";
      setProblem(fields || errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle title="Users" help="Each person signs in with their own account, so every sale and change carries their name. Accounts are switched off, never deleted."
        action={<button className="btn-primary" onClick={() => open({ kind: "new" })}>+ Add User</button>} />
      <div className="card overflow-x-auto">
        {(list.data?.results.length ?? 0) > 0 && <div className="mb-3 flex justify-end"><ColumnPicker visibility={cols} /></div>}
        {list.loading && !list.data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : (
          <table className="table">
            <thead><tr>{cols.show("name") && <th>Name</th>}{cols.show("username") && <th>Username</th>}{cols.show("role") && <th>Role</th>}{cols.show("status") && <th>Status</th>}{cols.show("login") && <th>Last signed in</th>}<th /></tr></thead>
            <tbody>
              {list.data!.results.map((u) => (
                <tr key={u.id} className={u.is_active ? "" : "text-slate-500"}>
                  {cols.show("name") && <td className="font-semibold">{u.display_name}{u.id === me?.id && " (you)"}</td>}
                  {cols.show("username") && <td>{u.username}</td>}
                  {cols.show("role") && <td>{ROLES.find((r) => r.value === u.role)?.label}</td>}
                  {cols.show("status") && <td><StatusBadge status={u.is_active ? "OPEN" : "OFF"} label={u.is_active ? "Active" : "Switched off"} /></td>}
                  {cols.show("login") && <td>{u.last_login ? formatDate(u.last_login) : "Never"}</td>}
                  <td className="space-x-2 whitespace-nowrap text-right">
                    <button className="btn-secondary min-h-[2.5rem]" onClick={() => open({ kind: "edit", user: u })}>Edit</button>
                    <button className="btn-secondary min-h-[2.5rem]" onClick={() => open({ kind: "password", user: u })}>New password</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {mode && (
        <Modal title={mode.kind === "new" ? "Add User" : mode.kind === "edit" ? `Edit ${mode.user.display_name}` : `New password for ${mode.user.display_name}`} onClose={() => setMode(null)}>
          <form onSubmit={save} className="space-y-3" noValidate>
            {problem && <Alert kind="error">{problem}</Alert>}
            {mode.kind === "new" && (
              <Field label="Username" hint="What they type to sign in. No spaces, e.g. asha">{(p) => <input {...p} className="input" value={form.username} autoFocus onChange={(e) => setForm({ ...form, username: e.target.value })} />}</Field>
            )}
            {mode.kind !== "password" && (
              <>
                <Field label="Full name" hint="Shown on receipts and reports.">{(p) => <input {...p} className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />}</Field>
                <fieldset>
                  <legend className="mb-1 font-semibold">Role</legend>
                  {ROLES.map((r) => (
                    <label key={r.value} className="flex items-start gap-3 py-1">
                      <input type="radio" name="role" className="mt-1 h-5 w-5" checked={form.role === r.value} onChange={() => setForm({ ...form, role: r.value })} />
                      <span><span className="font-semibold">{r.label}</span> — <span className="text-slate-600">{r.help}</span></span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {mode.kind === "edit" && (
              <label className="flex items-center gap-3">
                <input type="checkbox" className="h-6 w-6" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                <span>Active (untick to stop this person signing in)</span>
              </label>
            )}
            {mode.kind !== "edit" && (
              <Field label={mode.kind === "new" ? "First password" : "New password"} hint="At least 8 characters. They will be asked to choose their own when they sign in.">
                {(p) => <input {...p} className="input" type="text" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
              </Field>
            )}
            <div className="flex gap-3 pt-2">
              <button className="btn-primary" disabled={busy || asking}>{busy ? "Saving…" : "Save"}</button>
              <button type="button" className="btn-secondary" onClick={() => setMode(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
      {confirmation}
    </div>
  );
}
