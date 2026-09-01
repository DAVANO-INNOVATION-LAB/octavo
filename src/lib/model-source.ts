import "server-only";
import { getDb } from "./db";
import fs from "node:fs";
import path from "node:path";
import { UPLOADS_DIR } from "./db";
import {
  architectureFromPages,
  parseDeclaredModel,
  pipelineFromRuns,
  pointsFromTable,
  type ModelScene,
} from "./model-data";

/**
 * Where a 3D block's data comes from, resolved on the server.
 *
 * The block itself stays a dumb renderer: it is handed a scene and draws it.
 * Deriving here means permissions, the database, and the page's own content
 * are all in scope, and the client never learns about pages it may not see.
 */

/** Pages in this space and the links among them — the space's own shape. */
export function architectureScene(spaceId: string): ModelScene {
  const db = getDb();
  const space = db.prepare("SELECT slug FROM spaces WHERE id = ?").get(spaceId) as
    | { slug: string }
    | undefined;
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.slug, (SELECT title FROM pages WHERE id = p.parent_id) AS parentTitle
         FROM pages p WHERE p.space_id = ? AND p.published = 1
        ORDER BY p.position LIMIT 300`
    )
    .all(spaceId) as { id: string; title: string; slug: string; parentTitle: string | null }[];
  // Each node is a page, so each node can be opened. Built here rather than
  // in the browser: the client is handed a link, never a way to enumerate.
  const pages = rows.map((p) => ({
    ...p,
    href: space ? `/${space.slug}/${p.slug}` : undefined,
  }));
  const ids = new Set(pages.map((p) => p.id));
  const links = (
    db.prepare("SELECT from_page, to_page FROM page_links").all() as {
      from_page: string;
      to_page: string;
    }[]
  )
    .filter((l) => ids.has(l.from_page) && ids.has(l.to_page))
    .map((l) => ({ from: l.from_page, to: l.to_page }));
  return architectureFromPages({ pages, links });
}

/** Connectors in this space and what their runs actually did. */
export function pipelineScene(spaceId: string): ModelScene {
  const db = getDb();
  const connectors = db
    .prepare("SELECT id, name, type FROM connectors WHERE space_id = ? ORDER BY type, name")
    .all(spaceId) as { id: string; name: string; type: string }[];
  if (connectors.length === 0) return pipelineFromRuns({ connectors: [], runs: [] });
  const holes = connectors.map(() => "?").join(",");
  const runs = (
    db
      .prepare(
        `SELECT connector_id, status, started FROM runs
          WHERE connector_id IN (${holes}) ORDER BY started DESC LIMIT 500`
      )
      .all(...connectors.map((c) => c.id)) as {
      connector_id: string;
      status: string;
      started: number;
    }[]
  ).map((r) => ({ connectorId: r.connector_id, status: r.status, at: r.started }));
  return pipelineFromRuns({ connectors, runs });
}

/**
 * Resolve the scene for one block. `declaration` is the block's own YAML,
 * used for the disciplines Octavo cannot infer — a network topology, an
 * electrode layout, a set of embedding points.
 */
/**
 * Points from a file someone uploaded.
 *
 * Only ever reads inside the uploads directory, and only a file named the way
 * the upload route names them. A model block is authored content, so its data
 * reference is untrusted input: "../../etc/passwd" must not be a data source.
 */
export function dataScene(url: string, caption: string): ModelScene | null {
  const name = url.replace(/^\/api\/files\//, "");
  if (!/^[A-Za-z0-9_-]+\.(csv|tsv|json|txt)$/.test(name)) return null;
  const full = path.join(UPLOADS_DIR, name);
  if (path.dirname(path.resolve(full)) !== path.resolve(UPLOADS_DIR)) return null;
  let text: string;
  try {
    const stat = fs.statSync(full);
    // A model is a picture, not a database import; a huge file here is a
    // mistake, and reading it would block the process for everyone.
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    text = fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
  return pointsFromTable(text, caption);
}

export function sceneFor(
  source: string,
  kind: string,
  spaceId: string,
  declaration: string,
  dataUrl = ""
): ModelScene | null {
  if (source === "declared") return parseDeclaredModel(declaration);
  if (source === "data") return dataUrl ? dataScene(dataUrl, "") : null;
  if (source === "space") {
    if (kind === "pipeline") return pipelineScene(spaceId);
    return architectureScene(spaceId);
  }
  return null; // "preset" — the block draws its built-in scene
}

/**
 * Resolve every 3D block in a document, keyed by block id.
 *
 * Done once per page rather than once per block: a page with six models of
 * the same space derives the space once. Blocks drawing a preset resolve to
 * nothing and keep their built-in scene.
 */
export function scenesForBlocks(
  blocks: { id?: string; type?: string; props?: Record<string, unknown>; children?: unknown[] }[],
  spaceId: string
): Map<string, ModelScene> {
  const out = new Map<string, ModelScene>();
  const derived = new Map<string, ModelScene>();
  const walk = (list: typeof blocks) => {
    for (const b of list ?? []) {
      if (b?.type === "model3d" && b.id) {
        const source = String(b.props?.source ?? "preset");
        const kind = String(b.props?.kind ?? "architecture");
        if (source === "declared") {
          const s = parseDeclaredModel(String(b.props?.declaration ?? ""));
          if (s) out.set(b.id, s);
        } else if (source === "data") {
          const s = dataScene(String(b.props?.dataUrl ?? ""), String(b.props?.title ?? ""));
          if (s) out.set(b.id, s);
        } else if (source === "space") {
          const key = kind === "pipeline" ? "pipeline" : "architecture";
          let s = derived.get(key);
          if (!s) {
            s = key === "pipeline" ? pipelineScene(spaceId) : architectureScene(spaceId);
            derived.set(key, s);
          }
          out.set(b.id, s);
        }
      }
      if (Array.isArray(b?.children)) walk(b.children as typeof blocks);
    }
  };
  walk(blocks);
  return out;
}
