import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, Download, PenLine } from "lucide-react";
import { currentUser } from "@/lib/auth";
import {
  COMMENTABLE_KINDS,
  backlinks,
  flattenTree,
  getPageBySlug,
  getSpaceBySlug,
  pageTree,
} from "@/lib/data";
import Link2 from "next/link";
import { extractHeadings, parseBlocks } from "@/lib/blocks";
import { SpaceShell } from "@/components/SpaceShell";
import { Renderer } from "@/components/render/Renderer";
import { Toc } from "@/components/Toc";
import { PrintButton } from "@/components/PrintButton";
import { Discussion } from "@/components/Discussion";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ space: string; page: string }>;
}) {
  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  const page = space && getPageBySlug(space.id, pageSlug);
  if (!space || !page) return {};
  return {
    title: `${page.title} · ${space.name}`,
    description: page.content_text.slice(0, 160),
  };
}

export default async function ReaderPage({
  params,
}: {
  params: Promise<{ space: string; page: string }>;
}) {
  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const page = getPageBySlug(space.id, pageSlug);
  if (!page) notFound();

  const user = await currentUser();
  const editing = Boolean(user);
  if (space.visibility === "private" && !user) redirect("/login");
  if (page.published === 0 && !editing) notFound();

  const tree = pageTree(space.id, !editing);
  const flat = flattenTree(tree).filter((p) => p.published === 1 || editing);
  const idx = flat.findIndex((p) => p.id === page.id);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;

  const blocks = parseBlocks(page.content);
  const headings = extractHeadings(blocks);
  const refs = backlinks(page.id, editing);

  return (
    <SpaceShell
      space={space}
      tree={tree}
      activeId={page.id}
      editing={editing}
      rail={
        <>
          <Toc headings={headings} />
          {refs.length > 0 && (
            <div className={headings.length ? "mt-8" : ""}>
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
                Referenced by
              </p>
              <ul className="space-y-1.5 border-l border-line pl-3.5">
                {refs.map((r) => (
                  <li key={r.page_id}>
                    <Link2
                      href={`/${r.space_slug}/${r.page_slug}`}
                      className="block text-[13px] leading-snug text-muted transition-colors hover:text-accent"
                    >
                      {r.title}
                      {r.space_slug !== space.slug && (
                        <span className="block text-[11px] text-faint">
                          {r.space_name}
                        </span>
                      )}
                    </Link2>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      }
    >
      <article className="rise mx-auto max-w-2xl">
        {page.published === 0 && (
          <p className="mb-6 inline-block rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
            Draft — only signed-in writers can see this page
          </p>
        )}
        <header className="mb-8">
          {idx >= 0 && (
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
              Chapter {String(idx + 1).padStart(2, "0")}
              <span className="mx-2 text-line-strong">—</span>
              {space.name}
            </p>
          )}
          <div className="flex items-start justify-between gap-4">
            <h1
              className="wordmark text-[2.4rem] leading-[1.15] text-ink"
              style={{ fontVariationSettings: '"opsz" 60' }}
            >
              {page.title}
            </h1>
            <span className="mt-2 flex shrink-0 items-center gap-1.5 print:hidden">
              <PrintButton />
              <a
                href={`/api/pages/${page.id}/export`}
                title="Download this page as Markdown"
                className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-ink"
              >
                <Download size={13} />
                .md
              </a>
              {editing && (
                <Link
                  href={`/${space.slug}/${page.slug}/edit`}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-ink"
                >
                  <PenLine size={13} />
                  Edit
                </Link>
              )}
            </span>
          </div>
          <p className="mt-3 text-xs text-faint">
            Last updated{" "}
            {new Date(page.updated_at).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </header>

        <Renderer blocks={blocks} dropCap />

        <p
          aria-hidden
          className="wordmark mt-14 select-none text-center text-lg tracking-[0.5em] text-line-strong"
        >
          ⁂
        </p>

        <nav className="mt-10 grid gap-3 sm:grid-cols-2">
          {prev ? (
            <Link
              href={`/${space.slug}/${prev.slug}`}
              className="group rounded-xl border border-line bg-surface p-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-pop"
            >
              <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
                <ArrowLeft size={12} />
                Previous
              </span>
              <span className="mt-1 block truncate text-sm font-medium text-ink group-hover:text-accent">
                {prev.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link
              href={`/${space.slug}/${next.slug}`}
              className="group rounded-xl border border-line bg-surface p-4 text-right shadow-card transition-all hover:-translate-y-0.5 hover:shadow-pop"
            >
              <span className="flex items-center justify-end gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
                Next
                <ArrowRight size={12} />
              </span>
              <span className="mt-1 block truncate text-sm font-medium text-ink group-hover:text-accent">
                {next.title}
              </span>
            </Link>
          )}
        </nav>

        {COMMENTABLE_KINDS.has(space.kind) && (
          <Discussion
            pageId={page.id}
            spaceSlug={space.slug}
            pageSlug={page.slug}
            user={user}
          />
        )}
      </article>
    </SpaceShell>
  );
}
