"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/lib/auth";
import { recordVisit, replaceTo } from "@/lib/backNav";
import { canOpen } from "@/lib/nav";
import type { Role } from "@/lib/types";

import { SidebarNav } from "./SidebarNav";
import { StockAlerts } from "./StockAlerts";
import { Alert, Spinner } from "./ui";

const ROLE_LABEL = { OWNER: "Owner", ACCOUNTANT: "Accountant", CASHIER: "Cashier" } as const;

/** The page asked for before signing in, if it is a page of this system that this role may open; otherwise the dashboard. */
function pageAfterSignIn(role: Role): string {
  const next = new URLSearchParams(window.location.search).get("next") ?? "";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) return "/";
  return canOpen(role, next.split(/[?#]/)[0]) ? next : "/";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const onLogin = pathname === "/login";
  // On a phone the sidebar slides in from the Menu button; on a computer screen it is always showing.
  const [menuOpen, setMenuOpen] = useState(false);
  // The sidebar starts just under the top bar, whose height changes when it wraps on a narrow screen.
  const header = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(60);
  const hasShell = Boolean(user) && !onLogin;
  useEffect(() => {
    const el = header.current;
    if (!el) return;
    const measure = () => setHeaderHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasShell]);

  // The Back button's trail. This runs before the redirects below so a redirect's target is not mistaken for this page.
  useEffect(() => recordVisit(pathname), [pathname]);

  // Someone who opens a page while signed out (say /products) is taken back to it after signing in.
  // Signing out goes to a plain sign-in page, so the next person starts on the dashboard.
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (!user && !onLogin) replaceTo(router, wasSignedIn.current || pathname === "/" ? "/login" : `/login?next=${encodeURIComponent(pathname + window.location.search)}`);
    else if (user && onLogin) replaceTo(router, pageAfterSignIn(user.role));
    else if (user?.must_change_password && pathname !== "/change-password") replaceTo(router, "/change-password");
    wasSignedIn.current = Boolean(user);
  }, [loading, user, onLogin, pathname, router]);

  // Choosing a page closes the phone menu.
  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (loading) return <Spinner label="Opening MERIBA Store…" />;
  if (onLogin) return <>{children}</>;
  if (!user) return <Spinner label="Taking you to the sign-in page…" />;

  const allowed = canOpen(user.role, pathname);

  return (
    <div className="min-h-screen">
      <header ref={header} className="no-print sticky top-0 z-30 border-b border-primary-dark bg-primary text-white [--focus:251_191_36]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <button type="button" className="min-h-[2.5rem] rounded-lg border border-white/60 px-3 py-1.5 font-semibold hover:bg-primary-light lg:hidden"
              aria-expanded={menuOpen} aria-controls="main-menu" onClick={() => setMenuOpen((open) => !open)}>
              {menuOpen ? "✕ Close" : "☰ Menu"}
            </button>
            <Link href="/" className="text-xl font-bold tracking-wide">MERIBA STORE</Link>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span>
              <span className="font-semibold">{user.display_name}</span> · <span className="text-slate-200">{ROLE_LABEL[user.role]}</span>
            </span>
            <button onClick={() => signOut()} className="min-h-[2.5rem] rounded-lg border border-white/60 px-3 py-1.5 font-semibold hover:bg-primary-light">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {menuOpen && <button type="button" aria-label="Close the menu" className="no-print fixed inset-0 z-20 bg-slate-900/50 lg:hidden" onClick={() => setMenuOpen(false)} />}
        <nav id="main-menu" aria-label="Main menu" style={{ top: headerHeight, height: `calc(100vh - ${headerHeight}px)` }}
          className={`no-print fixed left-0 z-20 w-60 shrink-0 overflow-y-auto border-r border-primary-dark bg-primary py-2 shadow-xl [--focus:251_191_36]
            lg:sticky lg:z-10 lg:block lg:shadow-none ${menuOpen ? "block" : "hidden"}`}>
          <SidebarNav role={user.role} pathname={pathname} />
        </nav>

        <main className="min-w-0 flex-1 px-4 py-5">
          <div className="mx-auto max-w-7xl">
            {allowed ? (
              children
            ) : (
              <div className="card max-w-xl">
                <Alert kind="warning">This page is not available for your account.</Alert>
                <Link href="/" className="btn-primary mt-4">Go to Home</Link>
              </div>
            )}
          </div>
        </main>
      </div>
      {user.role !== "CASHIER" && !user.must_change_password && <StockAlerts userId={user.id} />}
    </div>
  );
}
