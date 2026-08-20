import type { ReactNode } from "react";
import type { Space, TreeNode } from "@/lib/data";
import { SiteHeader } from "./SiteHeader";
import { SpaceNav } from "./SpaceNav";
import { SiteFooter } from "./SiteFooter";

export function SpaceShell({
  space,
  tree,
  activeId,
  editing,
  rail,
  children,
}: {
  space: Space;
  tree: TreeNode[];
  activeId?: string;
  editing: boolean;
  rail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="mx-auto flex w-full max-w-7xl flex-1 items-start gap-8 px-4 sm:px-6">
        <aside className="sticky top-14 hidden max-h-[calc(100vh-3.5rem)] w-64 shrink-0 overflow-y-auto py-8 pr-2 md:block">
          <SpaceNav
            space={space}
            tree={tree}
            activeId={activeId}
            editing={editing}
          />
        </aside>
        <main className="min-w-0 flex-1 py-10">{children}</main>
        {rail !== undefined && (
          <aside className="sticky top-14 hidden max-h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto py-10 xl:block">
            {rail}
          </aside>
        )}
      </div>
      <SiteFooter />
    </div>
  );
}
