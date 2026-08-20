import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { instanceStats } from "@/lib/admin";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Admin" };

function bytes(n: number): string {
  if (n > 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

function duration(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export default async function AdminOverview() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const s = instanceStats();

  const cards: [string, string][] = [
    ["Users", String(s.users)],
    ["Spaces", String(s.spaces)],
    ["Pages", `${s.pages} (${s.published} published)`],
    ["Comments", String(s.comments)],
    ["Versions kept", String(s.versions)],
    ["Search index", `${s.ftsRows} documents`],
    ["Database", bytes(s.dbBytes)],
    ["Uploads", `${s.uploads} files · ${bytes(s.uploadsBytes)}`],
    ["Process memory", bytes(s.rssBytes)],
    ["Uptime", duration(s.uptimeSec)],
    ["Node", s.nodeVersion],
  ];

  return (
    <AdminShell active="/admin">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {cards.map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-line bg-surface p-4 shadow-card"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
              {label}
            </p>
            <p className="mt-1 truncate text-lg text-ink" title={value}>
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-2 [&>section]:min-w-0">
        <section>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
            Largest spaces
          </p>
          <ul className="space-y-1.5">
            {s.topSpaces.map((t) => (
              <li key={t.slug} className="flex min-w-0 items-baseline gap-2 text-sm">
                <Link href={`/${t.slug}`} className="min-w-0 truncate text-ink hover:text-accent">
                  {t.name}
                </Link>
                <span className="ml-auto shrink-0 font-mono text-xs text-faint">
                  {t.pages} pages
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
            Recently edited
          </p>
          <ul className="space-y-1.5">
            {s.recentPages.map((p) => (
              <li key={`${p.space_slug}/${p.slug}`} className="min-w-0 text-sm">
                <Link
                  href={`/${p.space_slug}/${p.slug}`}
                  className="block truncate text-ink hover:text-accent"
                >
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AdminShell>
  );
}
