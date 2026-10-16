import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canRestoreSpace } from "@/lib/roles";
import { restoreSpaceAction } from "@/app/actions";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";

export default async function Trash({ searchParams }: { searchParams: Promise<{ deleted?: string; restored?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const query = await searchParams;
  const spaces = (getDb().prepare(`SELECT s.id, s.name, d.deleted_at,
    (SELECT COUNT(*) FROM pages p WHERE p.space_id = s.id) AS pages
    FROM deleted_spaces d JOIN spaces s ON s.id = d.space_id ORDER BY d.deleted_at DESC`)
    .all() as { id: string; name: string; deleted_at: number; pages: number }[])
    .filter(s => canRestoreSpace(user, s.id));
  return <div className="min-h-screen"><SiteHeader /><main id="main" className="mx-auto max-w-3xl px-4 py-10">
    <Link href="/" className="text-sm text-accent">Back to library</Link>
    <h1 className="mt-4 text-3xl font-semibold">Trash</h1>
    <p className="mt-3 text-sm text-muted">Deleted spaces stay here until restored. Nothing is automatically erased. Restoring brings back the original pages, files, history, links, and permissions.</p>
    {query.deleted && <p role="status" className="mt-4 rounded-lg border border-line p-3">Space moved to Trash. You can undo the deletion with Restore.</p>}
    {query.restored && <p role="status" className="mt-4 rounded-lg border border-line p-3">Space restored. It is available in the library again.</p>}
    <ul className="mt-6 space-y-3">{spaces.map(s => <li key={s.id} className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface p-4">
      <div><h2 className="font-medium">{s.name}</h2><p className="mt-1 text-xs text-muted">{s.pages} pages · Deleted {new Date(s.deleted_at).toLocaleDateString("en-US", { timeZone: "UTC" })}</p></div>
      <form action={restoreSpaceAction}><input type="hidden" name="spaceId" value={s.id} /><button className="rounded-lg border border-line px-4 py-2 text-sm text-accent">Restore</button></form>
    </li>)}</ul>
    {!spaces.length && <p className="mt-6 text-muted">No deleted spaces you can restore.</p>}
  </main></div>;
}
