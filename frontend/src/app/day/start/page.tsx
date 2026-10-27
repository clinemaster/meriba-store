"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Field, PageTitle, Spinner, Stat, useConfirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { centsToApi, formatDate, formatTZS, toCents } from "@/lib/money";
import type { CurrentDay } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";
import { replaceTo } from "@/lib/backNav";

export default function StartDayPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { data, error, loading } = useLoad<CurrentDay>("/day/current/");
  const [float, setFloat] = useState("0");
  // Owner only, when this opens the day: start from a different opening balance, with a reason.
  const [editOpening, setEditOpening] = useState(false);
  const [newOpening, setNewOpening] = useState("");
  const [openingReason, setOpeningReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { confirm, confirmation, asking } = useConfirm();

  useEffect(() => {
    if (data?.shift) replaceTo(router, "/sheet");
  }, [data, router]);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error}</Alert>;

  const opening = data.day ? data.day.opening_cumulative_sales : data.next_opening_cumulative_sales;
  const floatCents = toCents(float);
  const floatInvalid = float.trim() === "" || floatCents < 0 || Number.isNaN(Number(float.replace(/,/g, "")));
  const canEditOpening = user?.role === "OWNER" && !data.day;
  const changingOpening = canEditOpening && editOpening;
  const newOpeningCents = toCents(newOpening);
  const openingInvalid = changingOpening && (newOpening.trim() === "" || newOpeningCents < 0 || Number.isNaN(Number(newOpening.replace(/,/g, ""))));
  const openingUnchanged = changingOpening && !openingInvalid && newOpeningCents === toCents(opening ?? "0");
  const reasonMissing = changingOpening && !openingUnchanged && openingReason.trim().length < 10;
  const blocked = floatInvalid || openingInvalid || reasonMissing;

  async function start() {
    if (busy || blocked) return;
    setBusy(true);
    setProblem(null);
    const body: Record<string, string> = { opening_float: centsToApi(floatCents) };
    if (changingOpening && !openingUnchanged) {
      body.opening_cumulative_sales = centsToApi(newOpeningCents);
      body.opening_reason = openingReason.trim();
    }
    try {
      await api("/day/start/", { method: "POST", body });
      replaceTo(router, "/sheet");
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
        {canEditOpening && !editOpening && (
          <button type="button" className="btn-secondary min-h-[2.5rem]" onClick={() => { setEditOpening(true); setNewOpening(String(Math.round(toCents(opening ?? "0") / 100))); }}>
            Change the opening balance…
          </button>
        )}
        {changingOpening && (
          <div className="space-y-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
            <p className="font-semibold">Owner only: start today from a different opening balance. The carried figure and your reason are recorded.</p>
            <Field label="New opening cumulative sales balance (TZS)" error={openingInvalid ? "Enter an amount of 0 or more." : undefined}
              hint={openingUnchanged ? "This is the same as the carried balance, so nothing will be changed." : undefined}>
              {(p) => <input {...p} className="input max-w-xs text-xl" inputMode="numeric" value={newOpening} onChange={(e) => setNewOpening(e.target.value)} onFocus={(e) => e.target.select()} />}
            </Field>
            {!openingUnchanged && (
              <Field label="Reason for the change" hint="At least 10 characters, for example how the correct figure was checked."
                error={reasonMissing && openingReason.trim() !== "" ? "Write a little more about why." : undefined}>
                {(p) => <textarea {...p} className="input" rows={2} value={openingReason} onChange={(e) => setOpeningReason(e.target.value)} />}
              </Field>
            )}
            <button type="button" className="btn-secondary min-h-[2.5rem]" onClick={() => { setEditOpening(false); setOpeningReason(""); }}>
              Keep the carried balance
            </button>
          </div>
        )}
        {user?.role === "OWNER" && data.day && (
          <p className="text-sm text-slate-600">The day is already open. To change its opening balance, use <Link href="/closing" className="font-semibold underline">Daily Closing</Link>.</p>
        )}
        <Field
          label="Cash float in the drawer (TZS)"
          hint="The money you were given to make change. Type 0 if there is none."
          error={floatInvalid ? "Enter an amount of 0 or more." : undefined}
        >
          {(p) => <input {...p} className="input max-w-xs text-xl" inputMode="numeric" value={float} onChange={(e) => setFloat(e.target.value)} onFocus={(e) => e.target.select()} />}
        </Field>
        <div className="flex flex-wrap gap-3">
          <button className="btn-primary" disabled={busy || asking || blocked || !data.is_live}
            onClick={() => confirm({
              message: `Start the day with ${formatTZS(floatCents, true)} in the drawer${changingOpening && !openingUnchanged ? ` and an opening balance of ${formatTZS(newOpeningCents, true)} instead of ${formatTZS(opening)}` : ""}? After the day has started, only the Owner can change the float or the opening balance.`,
              yes: "Yes, start the day", run: start,
            })}>
            {busy ? "Starting…" : `Start Day with ${formatTZS(floatCents, true)} float`}
          </button>
          <Link href="/" className="btn-secondary">Cancel</Link>
        </div>
      </div>
      {confirmation}
    </div>
  );
}
