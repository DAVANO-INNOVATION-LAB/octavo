import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { readablePrivateSpaceIds } from "@/lib/roles";
import { listSections, siteEntries, type Site } from "@/lib/sites";
import { SiteHeader } from "@/components/SiteHeader";
import { SpaceCard } from "@/components/SpaceCard";

/**
 * A site's front page. Shared by the /sites/<slug> route and by the root when
 * a request arrives on a site's own host, so there is one implementation of
 * what a site looks like rather than two that drift.
 */
export async function SiteCover({ site }: { site: Site }) {
  const user = await currentUser();
  // Visibility is applied inside siteEntries. A site groups and renames; it
  // never widens what anyone may read.
  const entries = siteEntries(site.id, readablePrivateSpaceIds(user));
  const sections = listSections(site.id);
  const loose = entries.filter((e) => !e.sectionId);

  return (
    <div
      className="flex min-h-screen flex-col"
      data-palette={site.accent || undefined}
      data-typeface={site.typeface || undefined}
    >
      <SiteHeader />
      <main id="main" className="mx-auto w-full min-w-0 max-w-5xl flex-1 px-4 py-12 sm:px-6">
        {!site.published && (
          <p className="mb-6 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted">
            This site is a draft. Only signed-in people can reach it.
          </p>
        )}
        <h1 className="wordmark text-[2.6rem] leading-[1.1] text-ink">{site.name}</h1>
        {site.tagline && (
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">{site.tagline}</p>
        )}

        {entries.length === 0 && (
          <p className="mt-10 text-sm text-muted">Nothing has been added to this site yet.</p>
        )}

        {sections.map((section) => {
          const mine = entries.filter((e) => e.sectionId === section.id);
          if (mine.length === 0) return null;
          return (
            <section key={section.id} className="mt-12">
              <h2 className="wordmark text-[1.5rem] text-ink">{section.title}</h2>
              {section.blurb && (
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
                  {section.blurb}
                </p>
              )}
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {mine.map((e) => (
                  <SpaceCard key={e.space.id} space={e.space} label={e.label} />
                ))}
              </div>
            </section>
          );
        })}

        {loose.length > 0 && (
          <section className="mt-12">
            {sections.length > 0 && <h2 className="wordmark text-[1.5rem] text-ink">More</h2>}
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {loose.map((e) => (
                <SpaceCard key={e.space.id} space={e.space} label={e.label} />
              ))}
            </div>
          </section>
        )}

        <p className="mt-14 text-sm text-muted">
          <Link href="/" className="text-accent hover:underline">
            The whole library
          </Link>
        </p>
      </main>
    </div>
  );
}
