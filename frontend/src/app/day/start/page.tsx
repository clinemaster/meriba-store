"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Field, PageTitle, Spinner, Stat } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { centsToApi, formatDate, formatTZS, toCents } from "@/lib/money";
import type { CurrentDay } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

export default function StartDayPage() {
  const router = useRouter();
  const { data, error, loading } = useLoad<CurrentDay>("/day/current/");
  const [float, setFloat] = useState("0");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (data?.shift) router.replace("/sale");
  }, [data, router]);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error}</Alert>;

  const opening = data.day ? data.day.opening_cumulative_sales : data.next_opening_cumulative_sales;
  const floatCents = toCents(float);
  const floatInvalid = float.trim() === "" || floatCents < 0 || Number.isNaN(Number(float.replace(/,/g, "")));

  async function start() {
    if (busy || floatInvalid) return;
    setBusy(true);
    setProblem(null);
    try {
      await api("/day/start/", { method: "POST", body: { opening_float: centsToApi(floatCents) } });
      router.replace("/sale");
    } catch (err) {
      setProblem(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <PageTitle title="Start Day" help={`You are starting work for ${formatDate(data.today)}. Check the figures, enter the cash you were given for change, then press Start.`} />
      <div className="card space-y-5">
        {problem && <Alert kind="error">{problem}</Alert>}
        <Stat
          label="Opening cumulative sales balance"
          value={formatTZS(opening)}
          note="The running total of all sales up to the last closed day. This is not cash in the drawer."
        />
        <Field
          label="Cash float in the drawer (TZS)"
          hint="The money you were given to make change. Type 0 if there is none."
          error={floatInvalid ? "Enter an amount of 0 or more." : undefined}
        >
          {(p) => <input {...p} className="input max-w-xs text-xl" inputMode="numeric" value={float} onChange={(e) => setFloat(e.target.value)} onFocus={(e) => e.target.select()} />}
        </Field>
        <div className="flex flex-wrap gap-3">
          <button className="btn-primary" onClick={start} disabled={busy || floatInvalid || !data.is_live}>
            {busy ? "Starting…" : `Start Day with ${formatTZS(floatCents, true)} float`}
          </button>
          <Link href="/" className="btn-secondary">Cancel</Link>
        </div>
      </div>
    </div>
  );
}
