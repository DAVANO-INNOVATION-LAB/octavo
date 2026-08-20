import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { flattenTree, getPage, getSpaceBySlug, pageTree } from "@/lib/data";
import { parseBlocks } from "@/lib/blocks";
import { Renderer } from "@/components/render/Renderer";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const { space: slug } = await params;
  const space = getSpaceBySlug(slug);
  return { title: space ? `${space.name} — the whole book` : "Print" };
}

/**
 * The entire space as one continuous document: a title page, a table of
 * contents, then every published page in reading order. Printing this is how
 * a space becomes a PDF book rather than a stack of separate pages.
 */
export default async function SpacePrint({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const { space: slug } = await params;
  const space = getSpaceBySlug(slug);
  if (!space) notFound();
  const user = await currentUser();
  if (space.visibility === "private" && !user) redirect("/login");

  const pages = flattenTree(pageTree(space.id, !user)).filter(
    (p) => p.published === 1 || Boolean(user)
  );

  return (
    <div
      className="mx-auto max-w-2xl px-4 py-10 sm:px-6"
      data-typeface={space.typeface}
      data-corners={space.corners}
    >
      <div className="mb-8 flex items-center justify-between gap-4 print:hidden">
        <p className="text-sm text-muted">
          {pages.length} {pages.length === 1 ? "chapter" : "chapters"} in one
          document — print or save as PDF.
        </p>
        <PrintButton />
      </div>

      <header className="border-b border-line-strong pb-10 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
          {space.kind}
        </p>
        <h1
          className="wordmark mt-4 text-[2.8rem] leading-tight text-ink"
          style={{ fontVariationSettings: '"opsz" 72' }}
        >
          {space.name}
        </h1>
        {space.description && (
          <p className="mt-4 text-lg leading-relaxed text-muted">
            {space.description}
          </p>
        )}
        <p className="mt-6 text-xs text-faint">
          {new Date().toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </header>

      <nav className="mt-10" style={{ breakAfter: "page" }}>
        <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
          Contents
        </p>
        <ol className="space-y-1">
          {pages.map((p, i) => (
            <li key={p.id} className="flex items-baseline gap-4 py-1">
              <span className="w-7 shrink-0 font-mono text-xs text-faint">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1 text-[15px] text-ink">
                {p.title}
              </span>
              <span className="hidden flex-1 border-b border-dotted border-line-strong sm:block" />
            </li>
          ))}
        </ol>
      </nav>

      {pages.map((meta, i) => {
        const page = getPage(meta.id);
        if (!page) return null;
        return (
          <article
            key={page.id}
            className="mt-16"
            style={{ breakBefore: i === 0 ? "auto" : "page" }}
          >
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
              Chapter {String(i + 1).padStart(2, "0")}
            </p>
            <h2
              className="wordmark mb-8 text-[2rem] leading-[1.15] text-ink"
              style={{ fontVariationSettings: '"opsz" 60' }}
            >
              {page.title}
            </h2>
            <Renderer blocks={parseBlocks(page.content)} dropCap />
          </article>
        );
      })}

      <p
        aria-hidden
        className="wordmark mt-16 select-none text-center text-lg tracking-[0.5em] text-line-strong"
      >
        ⁂
      </p>
    </div>
  );
}
