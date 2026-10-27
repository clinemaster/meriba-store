"use client";

import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth";
import { parentOf, previousPage, replaceTo } from "@/lib/backNav";

/**
 * Back to the page the user came from. When there is no earlier page in the app (opened from its address, a new tab,
 * or the earlier page is not allowed for this role), it goes to the page's parent instead, replacing this one so
 * Back can never bounce between two pages. It never leaves the app.
 */
export function BackButton() {
  const { user } = useAuth();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  if (!user || pathname === "/" || user.must_change_password) return null;

  const goBack = () => {
    if (previousPage(user.role, pathname)) router.back();
    else replaceTo(router, parentOf(pathname, user.role));
  };

  return (
    <button type="button" onClick={goBack}
      className="no-print mb-2 inline-flex min-h-[2.5rem] items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 font-semibold text-brand-700
        hover:bg-brand-50 hover:text-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">
      <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
        <path d="M20 12H5M11 5l-7 7 7 7" />
      </svg>
      Back
    </button>
  );
}
