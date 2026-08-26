import Link from "next/link";
import { openCrCount } from "@/lib/change-requests";
import { may , readablePrivateSpaceIds , canReadSpaceAsVisitor, canEditSpace, canReadSpace } from "@/lib/roles";
import { variantSiblings } from "@/lib/data";
import { resolveVariants } from "@/lib/variants";
import { VariantSwitcher } from "@/components/VariantSwitcher";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, Download, GitPullRequest, PenLine,
  Footprints,
} from "lucide-react";
import { currentUser } from "@/lib/auth";
import {
  COMMENTABLE_KINDS,
  blockThreadCounts,
  backlinks,
  recordView,
  flattenTree,
  bylineFor,
  getPage,
  getPageBySlug,
  getSpace,
  getSpaceBySlug,
  pageTree,
} from "@/lib/data";
import Link2 from "next/link";
import { extractHeadings, parseBlocks } from "@/lib/blocks";
import { citationsIn, composeBlocks, linkCitations, parseVars } from "@/lib/page-compose";
import { bibliography } from "@/lib/bibliography";
import { orcidUrl } from "@/lib/orcid";
import { doiSettings, doisFor } from "@/lib/doi";
import { mintDoiAction } from "@/app/actions";
import { References } from "@/components/render/References";
import { getSetting } from "@/lib/settings";
import { readingEnabled } from "@/lib/reading";
import { ReadingObserver } from "@/components/render/ReadingObserver";
import { AutoExpand } from "@/components/render/AutoExpand";
import { Highlighter } from "@/components/render/Highlighter";
import { CoverPicker } from "@/components/render/CoverPicker";
import { saveCoverAction } from "@/app/actions";
import { connectorsForSpace, runsForPage } from "@/lib/connectors";
import { SpaceShell } from "@/components/SpaceShell";
import { Renderer } from "@/components/render/Renderer";
import { Toc } from "@/components/Toc";
import { PrintButton } from "@/components/PrintButton";
import { Discussion } from "@/components/Discussion";
import { Feedback } from "@/components/render/Feedback";

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
  const base = process.env.OCTAVO_BASE_URL?.replace(/\/$/, "") ?? "";
  const url = `${base}/${space.slug}/${page.slug}`;
  const description = page.content_text.slice(0, 160).replace(/\s+/g, " ").trim();
  return {
    title: `${page.title} · ${space.name}`,
    description,
    alternates: {
      canonical: url || undefined,
      types: { "text/markdown": `${url || `/${space.slug}/${page.slug}`}/raw` },
    },
    openGraph: {
      type: "article",
      title: page.title,
      description,
      siteName: space.name,
      url: url || undefined,
      modifiedTime: new Date(page.updated_at).toISOString(),
    },
    twitter: { card: "summary_large_image", title: page.title, description },
    robots: space.visibility === "private" ? { index: false, follow: false } : undefined,
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
  // Seeing drafts is a writer's privilege, not a side effect of signing in.
  const editing = canEditSpace(user, space.id);
  const mayWrite = may(user, space.id, "write");
  const mayPropose = may(user, space.id, "propose");
  const mayPublish = may(user, space.id, "publish");
  // Private means private from other members too, not merely from people
  // who are signed out: otherwise one account is the whole library.
  if (!(await canReadSpaceAsVisitor(user, space)))
    redirect(user ? "/" : "/login");
  if (page.published === 0 && !editing) notFound();

  const tree = pageTree(space.id, !editing);
  const flat = flattenTree(tree).filter((p) => p.published === 1 || editing);
  const idx = flat.findIndex((p) => p.id === page.id);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;

  // Composition: space variables land, audience blocks filter, embedded
  // pages resolve — with this reader's permissions deciding what resolves.
  const vars = parseVars(getSetting(`vars:${space.id}`));
  const blocks = composeBlocks(parseBlocks(page.content), vars, (pid) => {
    const target = getPage(pid);
    if (!target || target.published !== 1) return { state: "missing" as const };
    const tSpace = getSpace(target.space_id);
    if (!tSpace || !canReadSpace(user, tSpace)) return { state: "forbidden" as const };
    return {
      state: "ok" as const,
      title: target.title,
      href: `/${tSpace.slug}/${target.slug}`,
      blocks: parseBlocks(target.content),
    };
  });
  const readingOn = readingEnabled();
  const byline = bylineFor(page);
  const minted = doisFor("page", page.id);
  const doiReady = doiSettings() !== null;
  // Citations: collect the order first, then rewrite [@key] into numbered
  // links pointing at the References list below.
  const citedKeys = citationsIn(blocks);
  const rendered = linkCitations(blocks, citedKeys);
  const commentable = COMMENTABLE_KINDS.has(space.kind);
  const openChanges = openCrCount(page.id);
  const sib = variantSiblings(space);
  const variantLinks = resolveVariants(sib.spaces, space.id, page.slug, sib.slugs);
  // Ids still present on the page, so a thread whose passage was deleted can
  // say so rather than linking into nothing.
  const liveBlockIds = new Set<string>(
    blocks.map((b) => (b as { id?: string }).id ?? "").filter(Boolean)
  );
  const headings = extractHeadings(blocks);
  // Count the read before rendering — published pages only, so drafts and
  // previews never inflate the numbers.
  if (page.published === 1) recordView(page.id);
  const refs = backlinks(page.id, readablePrivateSpaceIds(user));

  // Runnable cookbooks: the play button appears only for signed-in members
  // on pages in a space that has connectors configured.
  const connectors = user ? connectorsForSpace(space.id) : [];
  const lastRuns: Record<string, {
    status: string; user_name: string; started: number; output: string; external_url: string;
  }> = {};
  if (connectors.length > 0) {
    for (const r of runsForPage(page.id, 50)) {
      if (!lastRuns[r.block_id])
        lastRuns[r.block_id] = {
          status: r.status,
          user_name: r.user_name,
          started: r.started,
          output: r.output,
          external_url: r.external_url,
        };
    }
  }

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
        {page.cover && (
          <div
            aria-hidden
            className={`mb-8 h-40 rounded-2xl border border-line shadow-card sm:h-52 ${
              page.cover.startsWith("preset:")
                ? `cover-wash cover-${page.cover.slice(7)}`
                : ""
            }`}
            style={
              page.cover.startsWith("/")
                ? { backgroundImage: `url(${page.cover})`, backgroundSize: "cover", backgroundPosition: "center" }
                : undefined
            }
          />
        )}
        {mayWrite && (
          <CoverPicker pageId={page.id} cover={page.cover} action={saveCoverAction} />
        )}
        <header className="mb-8">
          {idx >= 0 && (
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
              Chapter {String(idx + 1).padStart(2, "0")}
              <span className="mx-2 text-line-strong">—</span>
              {space.name}
            </p>
          )}
          {variantLinks.length > 1 && (
            <div className="mb-4">
              <VariantSwitcher links={variantLinks} />
            </div>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <h1
              className="wordmark min-w-0 text-[2rem] leading-[1.15] text-ink sm:text-[2.4rem]"
              style={{ fontVariationSettings: '"opsz" 60' }}
            >
              {page.title}
            </h1>
            <span className="order-first flex flex-wrap items-center gap-1.5 print:hidden sm:order-none sm:mt-2 sm:flex-nowrap sm:shrink-0">
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
                <>
                  <Link
                    href={`/${space.slug}/${page.slug}/changes`}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-ink"
                    title="Proposed edits awaiting review"
                  >
                    <GitPullRequest size={13} />
                    Changes
                    {openChanges > 0 && (
                      <span className="rounded-full bg-accent-soft px-1.5 font-mono text-[10px] text-accent">
                        {openChanges}
                      </span>
                    )}
                  </Link>
                  {mayPropose && (
                  <Link
                    href={`/${space.slug}/${page.slug}/propose`}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-ink"
                  >
                    <PenLine size={13} />
                    Propose
                  </Link>
                  )}
                  {mayWrite && (
                  <Link
                    href={`/${space.slug}/${page.slug}/edit`}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-ink"
                  >
                    <PenLine size={13} />
                    Edit
                  </Link>
                  )}
                </>
              )}
            </span>
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
            {byline.author && (
              <span>
                By {byline.author.name}
                {byline.author.orcid && (
                  <>
                    {" "}
                    <a
                      href={orcidUrl(byline.author.orcid)}
                      rel="noopener noreferrer"
                      title={`ORCID ${byline.author.orcid}`}
                      className="font-mono text-[11px] text-accent no-underline hover:underline"
                    >
                      {byline.author.orcid}
                    </a>
                  </>
                )}
              </span>
            )}
            {byline.editor && <span>· revised by {byline.editor.name}</span>}
            <span>
              {byline.author ? "· " : ""}Last updated{" "}
              {new Date(page.updated_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
          </p>
        </header>

        <AutoExpand />
        {/* Signed-in readers keep their own highlights; see the API — every
            query is scoped to the reader, there is no path to anyone else's. */}
        {user && page.published === 1 && <Highlighter pageId={page.id} />}
        {/* Passive and aggregate — see ReadingObserver for what leaves. */}
        {readingOn && page.published === 1 && (
          <ReadingObserver pageId={page.id} />
        )}

        <Renderer
          blocks={rendered}
          threads={commentable ? blockThreadCounts(page.id) : undefined}
          dropCap
          run={
            connectors.length > 0
              ? {
                  pageId: page.id,
                  connectors: connectors.map((c) => ({
                    id: c.id,
                    name: c.name,
                    type: c.type,
                  })),
                  lastRuns,
                }
              : undefined
          }
        />

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

        {/* A page's DOIs: what it has been cited as. Minting is offered only
            to people who can publish, and only when a provider is set up. */}
        {(minted.length > 0 || (doiReady && mayPublish && page.published === 1)) && (
          <section className="mt-12 rounded-xl border border-line px-4 py-3">
            {minted.length > 0 && (
              <p className="text-xs text-faint">
                Cite this page as{" "}
                <a
                  href={minted[0].url}
                  rel="noopener noreferrer"
                  className="font-mono text-accent no-underline hover:underline"
                >
                  {minted[0].doi}
                </a>
                {minted.length > 1 && (
                  <span className="ml-2 text-faint">
                    (+{minted.length - 1} earlier {minted.length === 2 ? "version" : "versions"})
                  </span>
                )}
              </p>
            )}
            {doiReady && mayPublish && page.published === 1 && (
              <form action={mintDoiAction} className="mt-2">
                <input type="hidden" name="page" value={page.id} />
                <button className="text-xs text-accent underline">
                  {minted.length > 0
                    ? "Mint a DOI for the current revision"
                    : "Mint a DOI for this page"}
                </button>
                <span className="ml-2 text-xs text-faint">
                  Permanent once minted.
                </span>
              </form>
            )}
          </section>
        )}

        {/* Citations resolve against the space's bibliography, in the order
            the page cites them. */}
        <References keys={citedKeys} refs={bibliography(space.id)} />

        {page.published === 1 && <Feedback pageId={page.id} />}

        {/* Deliberately down here rather than in the action row: it is a
            quiet writer's tool, and the row is already full at 375px. */}
        {mayWrite && readingOn && page.published === 1 && (
          <p className="mt-6 text-center text-xs print:hidden">
            <Link
              href={`/${space.slug}/${page.slug}/reading`}
              className="inline-flex items-center gap-1.5 text-faint no-underline hover:text-accent"
            >
              <Footprints size={13} />
              Where readers stumble
            </Link>
          </p>
        )}

        {commentable && (
          <Discussion
            pageId={page.id}
            spaceSlug={space.slug}
            pageSlug={page.slug}
            user={user}
            liveBlockIds={liveBlockIds}
          />
        )}
      </article>
    </SpaceShell>
  );
}
