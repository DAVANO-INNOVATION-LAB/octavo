import Link from "next/link";
import { Plus } from "lucide-react";
import { Monogram } from "./Monogram";
import type { Space, TreeNode } from "@/lib/data";
import { createPageAction } from "@/app/actions";

function NavList({
  nodes,
  space,
  activeId,
  depth,
  editing,
}: {
  nodes: TreeNode[];
  space: Space;
  activeId?: string;
  depth: number;
  editing: boolean;
}) {
  if (!nodes.length) return null;
  return (
    <ul className={depth > 0 ? "ml-3 border-l border-line pl-2" : ""}>
      {nodes.map((n) => (
        <li key={n.id}>
          <Link
            href={`/${space.slug}/${n.slug}${editing ? "/edit" : ""}`}
            className={`group flex items-center gap-2 rounded-md px-2 py-[5px] text-[13.5px] leading-snug transition-colors ${
              n.id === activeId
                ? "bg-accent-soft font-medium text-accent"
                : "text-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
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
        <NavList
          nodes={tree}
          space={space}
          activeId={activeId}
          depth={0}
          editing={editing}
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
