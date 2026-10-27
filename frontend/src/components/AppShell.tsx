"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/lib/auth";
import { recordVisit, replaceTo } from "@/lib/backNav";
import { canOpen } from "@/lib/nav";

import { SidebarNav } from "./SidebarNav";
import { StockAlerts } from "./StockAlerts";
import { Alert, Spinner } from "./ui";

const ROLE_LABEL = { OWNER: "Owner", ACCOUNTANT: "Accountant", CASHIER: "Cashier" } as const;

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

  useEffect(() => {
    if (loading) return;
    if (!user && !onLogin) replaceTo(router, "/login");
    else if (user && onLogin) replaceTo(router, "/");
    else if (user?.must_change_password && pathname !== "/change-password") replaceTo(router, "/change-password");
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
      <header ref={header} className="no-print sticky top-0 z-30 bg-brand-800 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <button type="button" className="rounded-lg border border-white/60 px-3 py-1.5 font-semibold hover:bg-white/10 lg:hidden"
              aria-expanded={menuOpen} aria-controls="main-menu" onClick={() => setMenuOpen((open) => !open)}>
              {menuOpen ? "✕ Close" : "☰ Menu"}
            </button>
            <Link href="/" className="text-xl font-bold tracking-wide">MERIBA STORE</Link>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span>
              <span className="font-semibold">{user.display_name}</span> · {ROLE_LABEL[user.role]}
            </span>
            <button onClick={() => signOut()} className="rounded-lg border border-white/60 px-3 py-1.5 font-semibold hover:bg-white/10">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {menuOpen && <button type="button" aria-label="Close the menu" className="no-print fixed inset-0 z-20 bg-slate-900/50 lg:hidden" onClick={() => setMenuOpen(false)} />}
        <nav id="main-menu" aria-label="Main menu" style={{ top: headerHeight, height: `calc(100vh - ${headerHeight}px)` }}
          className={`no-print fixed left-0 z-20 w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white py-3 shadow-xl
            lg:sticky lg:z-10 lg:block lg:shadow-none ${menuOpen ? "block" : "hidden"}`}>
          <SidebarNav role={user.role} pathname={pathname} />
        </nav>

        <main className="min-w-0 flex-1 px-4 py-6">
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
