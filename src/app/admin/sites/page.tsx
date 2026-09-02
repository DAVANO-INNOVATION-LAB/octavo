import Link from "next/link";
import { redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { listSpaces } from "@/lib/data";
import { listSections, listSites, siteEntries } from "@/lib/sites";
import {
  addSiteSectionAction,
  createSiteAction,
  deleteSiteAction,
  removeSiteSectionAction,
  setSiteSpaceAction,
  updateSiteAction,
} from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sites" };

export default async function AdminSites({
  searchParams,
}: {
  searchParams: Promise<{ site?: string; saved?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { site: selected, saved } = await searchParams;

  const sites = listSites();
  const current = sites.find((s) => s.slug === selected) ?? sites[0] ?? null;
  const spaces = listSpaces("all");
  const sections = current ? listSections(current.id) : [];
  const entries = current ? siteEntries(current.id, "all") : [];
  const onSite = new Map(entries.map((e) => [e.space.id, e]));

  const field =
    "h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none placeholder:text-faint focus:border-accent";
  const label = "mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint";

  return (
    <AdminShell active="/admin/sites">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">Saved.</p>
      )}

      <h2 className="wordmark text-[1.4rem] text-ink">Published sites</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        One library, more than one front door. The same handbook can be the
        whole of a customer-facing site and one section of an internal one,
        under a different name and different dress, without being copied.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        A site decides what is <strong className="font-medium text-ink">presented</strong>,
        never who may read it. Adding a private space to a site grants nobody
        anything — it stays invisible to everyone who could not already open it.
      </p>

      <form action={createSiteAction} className="mt-6 flex max-w-2xl gap-2">
        <input name="name" placeholder="A new site's name" className={field} required />
        <button className="h-10 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink">
          Create
        </button>
      </form>

      {sites.length > 0 && (
        <div className="mt-8 flex flex-wrap gap-2">
          {sites.map((s) => (
            <Link
              key={s.id}
              href={`/admin/sites?site=${s.slug}`}
              className={`h-8 rounded-full border px-3 text-sm leading-8 transition-colors ${
                current?.id === s.id
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-line text-muted hover:text-ink"
              }`}
            >
              {s.name}
              {!s.published && " · draft"}
            </Link>
          ))}
        </div>
      )}

      {current && (
        <>
          <form action={updateSiteAction} className="mt-8 max-w-2xl space-y-4">
            <input type="hidden" name="id" value={current.id} />
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className={label}>Name</span>
                <input name="name" defaultValue={current.name} className={field} />
              </label>
              <label className="block w-44">
                <span className={label}>Palette</span>
                <select name="accent" defaultValue={current.accent} className={field}>
                  <option value="">Library default</option>
                  <option value="slate">Slate</option>
                  <option value="forest">Forest</option>
                  <option value="indigo">Indigo</option>
                  <option value="rosewood">Rosewood</option>
                  <option value="graphite">Graphite</option>
                </select>
              </label>
            </div>
            <label className="block">
              <span className={label}>Tagline</span>
              <input name="tagline" defaultValue={current.tagline} className={field} />
            </label>
            <label className="block">
              <span className={label}>Host</span>
              <input
                name="host"
                defaultValue={current.host}
                placeholder="docs.example.org — optional"
                className={`${field} font-mono text-xs`}
              />
              <span className="mt-1 block text-xs text-faint">
                A request arriving on this name is served this site instead of
                the library. One host belongs to one site; claiming a host
                takes it from whichever site had it.
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="published"
                defaultChecked={current.published === 1}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Published — an unpublished site is a draft only signed-in people can reach
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink">
                Save
              </button>
              <Link
                href={`/sites/${current.slug}`}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm text-muted hover:text-ink"
              >
                <ExternalLink size={14} />
                View
              </Link>
            </div>
          </form>

          <h3 className="mt-10 text-sm font-medium text-ink">Sections</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Headings the spaces are grouped under. Removing one keeps its
            spaces on the site; they simply stop being grouped.
          </p>
          <div className="mt-3 space-y-2">
            {sections.map((sec) => (
              <form
                key={sec.id}
                action={removeSiteSectionAction}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2"
              >
                <input type="hidden" name="id" value={sec.id} />
                <input type="hidden" name="site" value={current.slug} />
                <span className="flex-1 text-sm text-ink">{sec.title}</span>
                <button className="text-xs text-muted hover:text-accent">Remove</button>
              </form>
            ))}
          </div>
          <form action={addSiteSectionAction} className="mt-3 flex max-w-2xl gap-2">
            <input type="hidden" name="id" value={current.id} />
            <input type="hidden" name="site" value={current.slug} />
            <input name="title" placeholder="A new section" className={field} required />
            <button className="h-10 shrink-0 rounded-lg border border-line px-4 text-sm text-muted hover:text-ink">
              Add
            </button>
          </form>

          <h3 className="mt-10 text-sm font-medium text-ink">Spaces on this site</h3>
          <div className="mt-3 space-y-2">
            {spaces.map((sp) => {
              const entry = onSite.get(sp.id);
              return (
                <form
                  key={sp.id}
                  action={setSiteSpaceAction}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
                >
                  <input type="hidden" name="id" value={current.id} />
                  <input type="hidden" name="site" value={current.slug} />
                  <input type="hidden" name="space" value={sp.id} />
                  <label className="flex flex-1 items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      name="on"
                      defaultChecked={Boolean(entry)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    {sp.name}
                    {sp.visibility === "private" && (
                      <span className="text-[11px] uppercase tracking-[0.1em] text-faint">
                        private
                      </span>
                    )}
                  </label>
                  <input
                    name="label"
                    defaultValue={entry?.label === sp.name ? "" : (entry?.label ?? "")}
                    placeholder="Called this here (optional)"
                    className="h-8 w-52 rounded-md border border-line bg-bg px-2 text-xs text-ink"
                  />
                  <select
                    name="section"
                    defaultValue={entry?.sectionId ?? ""}
                    className="h-8 rounded-md border border-line bg-bg px-2 text-xs text-ink"
                  >
                    <option value="">No section</option>
                    {sections.map((sec) => (
                      <option key={sec.id} value={sec.id}>
                        {sec.title}
                      </option>
                    ))}
                  </select>
                  <button className="h-8 rounded-md border border-line px-3 text-xs text-muted hover:text-ink">
                    Apply
                  </button>
                </form>
              );
            })}
          </div>

          <form action={deleteSiteAction} className="mt-10">
            <input type="hidden" name="id" value={current.id} />
            <button className="h-9 rounded-lg border border-line px-4 text-sm text-muted hover:text-accent">
              Delete this site
            </button>
            <span className="ml-3 text-xs text-faint">
              Removes the site and its grouping. No space or page is touched.
            </span>
          </form>
        </>
      )}
    </AdminShell>
  );
}
