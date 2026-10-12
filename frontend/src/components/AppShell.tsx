"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/lib/auth";
import { canOpen, navFor } from "@/lib/nav";

import { Alert, Spinner } from "./ui";

const ROLE_LABEL = { OWNER: "Owner", ACCOUNTANT: "Accountant", CASHIER: "Cashier" } as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const onLogin = pathname === "/login";

  useEffect(() => {
    if (loading) return;
    if (!user && !onLogin) router.replace("/login");
    else if (user && onLogin) router.replace("/");
    else if (user?.must_change_password && pathname !== "/change-password") router.replace("/change-password");
  }, [loading, user, onLogin, pathname, router]);

  if (loading) return <Spinner label="Opening MERIBA Store…" />;
  if (onLogin) return <>{children}</>;
  if (!user) return <Spinner label="Taking you to the sign-in page…" />;

  const allowed = canOpen(user.role, pathname);

  return (
    <div className="min-h-screen">
      <header className="no-print bg-brand-800 text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="text-xl font-bold tracking-wide">MERIBA STORE</Link>
          <div className="flex items-center gap-3 text-sm">
            <span>
              <span className="font-semibold">{user.display_name}</span> · {ROLE_LABEL[user.role]}
            </span>
            <Link href="/change-password" className="underline">Change password</Link>
            <button onClick={() => signOut()} className="rounded-lg border border-white/60 px-3 py-1.5 font-semibold hover:bg-white/10">
              Sign out
            </button>
          </div>
        </div>
        <nav aria-label="Main menu" className="mx-auto max-w-7xl overflow-x-auto px-2">
          <ul className="flex gap-1">
            {navFor(user.role).map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`block whitespace-nowrap rounded-t-lg px-4 py-2.5 font-semibold ${
                      active ? "bg-slate-100 text-brand-800" : "text-white hover:bg-white/10"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        {allowed ? (
          children
        ) : (
          <div className="card max-w-xl">
            <Alert kind="warning">This page is not available for your account.</Alert>
            <Link href="/" className="btn-primary mt-4">Go to Home</Link>
          </div>
        )}
      </main>
    </div>
  );
}
