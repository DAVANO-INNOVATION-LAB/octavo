/**
 * Round-trip sync between a space and a directory of Markdown files.
 *
 * Octavo writes files and reads them back; it does not run Git. The runtime
 * image has no git binary and gains one only at the cost of its dependency
 * surface, and the same rule that governs connectors applies here — Octavo
 * never executes anything itself. Point the directory at a working tree and
 * commit it with whatever already has credentials: a sidecar, a cron entry,
 * a CI job. That also means this works against any VCS, or none.
 *
 * The planner below is pure so it can be tested exhaustively. Sync bugs
 * destroy writing, and the failure is usually silent.
 */

/** What Octavo holds for one page. */
export type PageSide = {
  id: string;
  path: string;
  title: string;
  /** Hash of the Markdown Octavo would write. */
  hash: string;
};

/** What is on disk for one file. */
export type FileSide = {
  path: string;
  title: string;
  hash: string;
};

/** What the last successful sync recorded, so a change can be attributed. */
export type SyncState = {
  path: string;
  pageId: string;
  hash: string;
};

export type Action =
  | { kind: "write"; path: string; pageId: string; why: string }
  | { kind: "import"; path: string; pageId?: string; why: string }
  | { kind: "conflict"; path: string; pageId: string; why: string }
  | { kind: "delete-file"; path: string; why: string }
  | { kind: "orphan-page"; path: string; pageId: string; why: string };

export type Plan = {
  actions: Action[];
  unchanged: number;
};

/**
 * Decide what to do, given both sides and what was true last time.
 *
 * Attribution is the whole job: a side that differs from the last recorded
 * hash has changed, and a side that matches has not. When both changed, no
 * automatic resolution is safe, so the pair is reported and left alone.
 */
export function planSync(
  pages: PageSide[],
  files: FileSide[],
  state: SyncState[]
): Plan {
  const byPath = {
    page: new Map(pages.map((p) => [p.path, p])),
    file: new Map(files.map((f) => [f.path, f])),
    state: new Map(state.map((s) => [s.path, s])),
  };
  const paths = new Set([
    ...pages.map((p) => p.path),
    ...files.map((f) => f.path),
    ...state.map((s) => s.path),
  ]);

  const actions: Action[] = [];
  let unchanged = 0;

  for (const path of [...paths].sort()) {
    const page = byPath.page.get(path);
    const file = byPath.file.get(path);
    const prior = byPath.state.get(path);

    // Never synced before.
    if (!prior) {
      if (page && !file) {
        actions.push({ kind: "write", path, pageId: page.id, why: "new page" });
      } else if (!page && file) {
        actions.push({ kind: "import", path, why: "new file" });
      } else if (page && file) {
        if (page.hash === file.hash) {
          unchanged++;
        } else {
          // Both sides exist and differ with nothing to attribute the
          // difference to. Guessing here is how sync tools lose work.
          actions.push({
            kind: "conflict",
            path,
            pageId: page.id,
            why: "page and file both exist and differ, with no record of a previous sync",
          });
        }
      }
      continue;
    }

    const pageChanged = page ? page.hash !== prior.hash : false;
    const fileChanged = file ? file.hash !== prior.hash : false;

    // One side was removed.
    if (page && !file) {
      if (pageChanged) {
        actions.push({ kind: "write", path, pageId: page.id, why: "file deleted, page edited since" });
      } else {
        // The file was deleted and the page is untouched. Deleting the page
        // is the destructive reading; it is reported instead so a person can
        // decide, because a missing file is just as often a botched checkout.
        actions.push({
          kind: "orphan-page",
          path,
          pageId: page.id,
          why: "the file was removed; the page is untouched",
        });
      }
      continue;
    }
    if (!page && file) {
      if (fileChanged) {
        actions.push({ kind: "import", path, pageId: prior.pageId, why: "page deleted, file edited since" });
      } else {
        actions.push({ kind: "delete-file", path, why: "the page was deleted and the file is untouched" });
      }
      continue;
    }
    if (!page && !file) {
      // Both gone; the state row is stale and the caller drops it.
      actions.push({ kind: "delete-file", path, why: "both sides gone" });
      continue;
    }

    if (!pageChanged && !fileChanged) {
      unchanged++;
    } else if (pageChanged && !fileChanged) {
      actions.push({ kind: "write", path, pageId: page!.id, why: "edited in Octavo" });
    } else if (!pageChanged && fileChanged) {
      actions.push({ kind: "import", path, pageId: prior.pageId, why: "edited on disk" });
    } else if (page!.hash === file!.hash) {
      // Both moved and landed in the same place: nothing to do but record it.
      unchanged++;
    } else {
      actions.push({
        kind: "conflict",
        path,
        pageId: page!.id,
        why: "edited in Octavo and on disk since the last sync",
      });
    }
  }

  return { actions, unchanged };
}

export function summarize(plan: Plan): Record<string, number> {
  const out: Record<string, number> = {
    write: 0,
    import: 0,
    conflict: 0,
    "delete-file": 0,
    "orphan-page": 0,
    unchanged: plan.unchanged,
  };
  for (const a of plan.actions) out[a.kind]++;
  return out;
}

/** A file name for a page that is stable, readable, and safe to write. */
export function filePathFor(slugs: string[]): string {
  return (
    slugs
      .map((s) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[-.]+|[-.]+$/g, "")
          .slice(0, 80)
      )
      .filter(Boolean)
      .join("/") + ".md"
  );
}
