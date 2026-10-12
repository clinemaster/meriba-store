"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Field, PageTitle } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function ChangePasswordPage() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (next !== again) return setError("The two new passwords are not the same. Type them again.");
    setBusy(true);
    setError(null);
    try {
      await api("/auth/change-password/", { method: "POST", body: { current_password: current, new_password: next } });
      await refresh();
      router.replace("/");
    } catch (err) {
      const fieldErrors = err instanceof ApiError && err.errors ? Object.values(err.errors).flat().join(" ") : "";
      setError(fieldErrors || errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card max-w-lg space-y-4" noValidate>
      <PageTitle title="Change your password" help="Use at least 8 characters. Do not share your password with anyone." />
      {user?.must_change_password && <Alert kind="info">Your password was set by someone else. Please choose your own before you continue.</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <Field label="Current password">
        {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      </Field>
      <Field label="New password">
        {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
      </Field>
      <Field label="New password again">
        {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />}
      </Field>
      <button className="btn-primary" disabled={busy || !current || !next}>{busy ? "Saving…" : "Save new password"}</button>
    </form>
  );
}
