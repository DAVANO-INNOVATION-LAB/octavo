import Link from "next/link";
import type { ReactNode } from "react";
import { SiteHeader } from "./SiteHeader";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/insights", label: "Insights" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/groups", label: "Groups" },
  { href: "/admin/policy", label: "Policy" },
  { href: "/admin/backups", label: "Backups" },
  { href: "/admin/links", label: "Broken links" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/notifications", label: "Notifications" },
  { href: "/admin/reading", label: "Reading signals" },
  { href: "/admin/sites", label: "Sites" },
  { href: "/admin/tenants", label: "Tenants" },
  { href: "/admin/doi", label: "DOIs" },
  { href: "/admin/ask", label: "Ask" },
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
      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="wordmark text-2xl text-ink">The binder’s office</h1>
        <p className="mt-1 text-sm text-muted">
          Instance administration — visible to admins only.
        </p>
        {/* These wrap rather than scroll. As a single scrolling row with its
            scrollbar hidden, the sections past the fold had no affordance at
            all: a trackpad could swipe to them and a mouse could not reach
            them. Fifteen sections is not a tab strip, and pretending it is
            cost people the second half of the settings. */}
        <nav
          aria-label="Admin sections"
          className="mt-6 flex flex-wrap gap-1.5 border-b border-line pb-3"
        >
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active === t.href ? "page" : undefined}
              className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors ${
                active === t.href
                  ? "border-accent bg-accent font-medium text-accent-ink"
                  : "border-line text-muted hover:border-line-strong hover:text-ink"
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
