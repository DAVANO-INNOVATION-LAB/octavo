import Link from "next/link";
import { Plus } from "lucide-react";
import { Monogram } from "./Monogram";
import type { Space, TreeNode } from "@/lib/data";
import { createPageAction } from "@/app/actions";

// Books read as chapters; article collections read as a flat stack of pages.
const BOOK_KINDS = new Set(["docs", "cookbook"]);
const SECTION_LABEL: Record<string, string> = {
  docs: "Chapters",
  cookbook: "Recipes",
  articles: "Articles",
  wiki: "Pages",
};

function NavList({
  nodes,
  space,
  activeId,
  depth,
  editing,
  numbered,
}: {
  nodes: TreeNode[];
  space: Space;
  activeId?: string;
  depth: number;
  editing: boolean;
  numbered: boolean;
}) {
  if (!nodes.length) return null;
  return (
    <ul className={depth > 0 ? "ml-[1.35rem] border-l border-line pl-2" : "space-y-px"}>
      {nodes.map((n, i) => (
        <li key={n.id}>
          <Link
            href={`/${space.slug}/${n.slug}${editing ? "/edit" : ""}`}
            className={`group flex items-baseline gap-2 rounded-md px-2 py-[5px] text-[13.5px] leading-snug transition-colors ${
              n.id === activeId
                ? "bg-accent-soft font-medium text-accent"
                : "text-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {depth === 0 && numbered && (
              <span
                className={`shrink-0 font-mono text-[10px] ${
                  n.id === activeId ? "text-accent" : "text-faint"
                }`}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
            )}
            <span className="min-w-0 truncate">
              {n.title}
              {editing && n.published === 0 && (
                <span className="ml-1.5 align-middle text-[10px] uppercase tracking-wide text-faint">
                  draft
                </span>
              )}
            </span>
          </Link>
          <NavList
            nodes={n.children}
            space={space}
            activeId={activeId}
            depth={depth + 1}
            editing={editing}
            numbered={numbered}
          />
        </li>
      ))}
    </ul>
  );
}

export function SpaceNav({
  space,
  tree,
  activeId,
  editing,
}: {
  space: Space;
  tree: TreeNode[];
  activeId?: string;
  editing: boolean;
}) {
  const numbered = BOOK_KINDS.has(space.kind);
  return (
    <nav className="flex h-full flex-col gap-4">
      <Link href={`/${space.slug}`} className="flex items-center gap-2.5 px-2">
        <Monogram name={space.name} size="sm" />
        <span className="min-w-0">
          <span className="wordmark block truncate text-[1.05rem] leading-tight text-ink">
            {space.name}
          </span>
        </span>
      </Link>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
          {SECTION_LABEL[space.kind] ?? "Pages"}
        </p>
        <NavList
          nodes={tree}
          space={space}
          activeId={activeId}
          depth={0}
          editing={editing}
          numbered={numbered}
        />
        {editing && (
          <form action={createPageAction} className="mt-2">
            <input type="hidden" name="space" value={space.slug} />
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-[13.5px] text-faint transition-colors hover:bg-surface-2 hover:text-ink">
              <Plus size={14} />
              New page
            </button>
          </form>
        )}
      </div>
    </nav>
  );
}
