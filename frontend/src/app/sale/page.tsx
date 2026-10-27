"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Spinner } from "@/components/ui";
import { replaceTo } from "@/lib/backNav";

/** Sales are entered on the Daily Sheet only (owner's decision, 13 Oct 2026). This old address leads there. */
export default function NewSaleMoved() {
  const router = useRouter();
  useEffect(() => {
    replaceTo(router, "/sheet");
  }, [router]);
  return <Spinner label="Opening the Daily Sheet…" />;
}
