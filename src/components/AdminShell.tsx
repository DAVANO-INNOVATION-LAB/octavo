import Link from "next/link";
import type { ReactNode } from "react";
import { SiteHeader } from "./SiteHeader";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/backups", label: "Backups" },
  { href: "/admin/connectors", label: "Connectors" },
  { href: "/admin/sso", label: "Single sign-on" },
];

export function AdminShell({
  active,
  children,
}: {
  active: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="wordmark text-2xl text-ink">The binder’s office</h1>
        <p className="mt-1 text-sm text-muted">
          Instance administration — visible to admins only.
        </p>
        <nav className="mt-6 flex gap-1 border-b border-line">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                active === t.href
                  ? "border-accent font-medium text-accent"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="py-8">{children}</div>
      </main>
    </div>
  );
}
