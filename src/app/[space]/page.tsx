import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight, Download, Lock, Plus, Settings, Users, Zap } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { flattenTree, getSpaceBySlug, pageTree } from "@/lib/data";
import { createPageAction } from "@/app/actions";
import { SpaceShell } from "@/components/SpaceShell";
import { canAdminSpace } from "@/lib/roles";

const KIND_LABEL: Record<string, string> = {
  docs: "Documentation",
  cookbook: "Cookbook",
  articles: "Articles",
  wiki: "Wiki",
};

export const dynamic = "force-dynamic";

export default async function SpaceCover({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const { space: spaceSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const user = await currentUser();
  const editing = Boolean(user);
  if (space.visibility === "private" && !user) redirect("/login");
  const isSpaceAdmin = canAdminSpace(user, space.id);
  const tree = pageTree(space.id, !editing);
  const flat = flattenTree(tree);
  const first = flat.find((p) => p.published === 1) ?? flat[0];

  return (
    <SpaceShell space={space} tree={tree} editing={editing}>
      <div className="rise mx-auto max-w-2xl">
        <div className="border-b border-line-strong pb-10">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            {KIND_LABEL[space.kind] ?? space.kind}
            {space.visibility === "private" && (
              <span className="flex items-center gap-1 text-faint">
                <Lock size={10} />
                Private
              </span>
            )}
          </p>
          <h1
            className="wordmark mt-4 text-4xl leading-tight text-ink sm:text-5xl"
            style={{ fontVariationSettings: '"opsz" 72' }}
          >
            {space.name}
          </h1>
          {space.description && (
            <p className="mt-4 text-lg leading-relaxed text-muted">
              {space.description}
            </p>
          )}
          {space.visibility === "private" && (
            <p className="mt-3 text-sm text-faint">
              This space is sealed — only signed-in members of this library can
              open it, and it never appears in public search.
            </p>
          )}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {first && (
              <Link
                href={`/${space.slug}/${first.slug}`}
                className="flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px"
              >
                Start reading
                <ArrowRight size={15} />
              </Link>
            )}
            {editing && (
              <>
                <form action={createPageAction}>
                  <input type="hidden" name="space" value={space.slug} />
                  <button className="flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-4 text-sm font-medium text-ink shadow-card transition-colors hover:border-line-strong">
                    <Plus size={15} />
                    New page
                  </button>
                </form>
                <a
                  href={`/api/spaces/${space.slug}/export`}
                  className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <Download size={15} />
                  Export
                </a>
                {isSpaceAdmin && (
                  <>
                    <Link
                      href={`/${space.slug}/members`}
                      className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <Users size={15} />
                      Members
                    </Link>
                    <Link
                      href={`/${space.slug}/connectors`}
                      className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <Zap size={15} />
                      Connectors
                    </Link>
                  </>
                )}
                <Link
                  href={`/${space.slug}/settings`}
                  className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <Settings size={15} />
                  Settings
                </Link>
              </>
            )}
          </div>
        </div>

        {flat.length > 0 && (
          <div className="mt-10">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
              Table of contents
            </p>
            <ol className="space-y-1">
              {flat.map((p, i) => (
                <li key={p.id}>
                  <Link
                    href={`/${space.slug}/${p.slug}${
                      editing && p.published === 0 ? "/edit" : ""
                    }`}
                    className="group flex items-baseline gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2"
                  >
                    <span className="w-7 shrink-0 font-mono text-xs text-faint">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[15px] text-ink group-hover:text-accent">
                      {p.title}
                      {p.published === 0 && (
                        <span className="ml-2 align-middle text-[10px] uppercase tracking-wide text-faint">
                          draft
                        </span>
                      )}
                    </span>
                    <span className="hidden shrink-0 border-b border-dotted border-line-strong sm:block sm:flex-1" />
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </SpaceShell>
  );
}
