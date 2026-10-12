import type { Metadata } from "next";

import { AppShell } from "@/components/AppShell";
import { AuthProvider } from "@/lib/auth";

import "./globals.css";

export const metadata: Metadata = { title: "MERIBA Store", description: "MERIBA Liquor Store Management System" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
