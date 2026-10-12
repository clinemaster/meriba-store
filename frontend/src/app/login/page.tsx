"use client";

import { useState } from "react";

import { Alert, Field } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setError("Enter your username and your password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4" noValidate>
        <div className="text-center">
          <h1 className="text-3xl font-bold text-brand-800">MERIBA STORE</h1>
          <p className="mt-1 text-slate-600">Sign in with your own username and password.</p>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Username">
          {(p) => <input {...p} className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />}
        </Field>
        <Field label="Password">
          {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="text-center text-sm text-slate-600">Forgot your password? Ask the Owner to give you a new one.</p>
      </form>
    </div>
  );
}
