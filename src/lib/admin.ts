import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDb, DATA_DIR, UPLOADS_DIR } from "./db";

export type InstanceStats = {
  users: number;
  spaces: number;
  pages: number;
  published: number;
  comments: number;
  versions: number;
  uploads: number;
  uploadsBytes: number;
  dbBytes: number;
  ftsRows: number;
  nodeVersion: string;
  uptimeSec: number;
  rssBytes: number;
  topSpaces: { name: string; slug: string; pages: number; updated_at: number }[];
  recentPages: { title: string; slug: string; space_slug: string; updated_at: number }[];
};

export function instanceStats(): InstanceStats {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  let uploads = 0;
  let uploadsBytes = 0;
  try {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      uploads++;
      uploadsBytes += fs.statSync(path.join(UPLOADS_DIR, f)).size;
    }
  } catch {
    /* empty */
  }
  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(path.join(DATA_DIR, "octavo.db")).size;
  } catch {
    /* empty */
  }
  return {
    users: one("SELECT COUNT(*) n FROM users"),
    spaces: one("SELECT COUNT(*) n FROM spaces"),
    pages: one("SELECT COUNT(*) n FROM pages"),
    published: one("SELECT COUNT(*) n FROM pages WHERE published = 1"),
    comments: one("SELECT COUNT(*) n FROM comments"),
    versions: one("SELECT COUNT(*) n FROM page_versions"),
    uploads,
    uploadsBytes,
    dbBytes,
    ftsRows: one("SELECT COUNT(*) n FROM pages_fts"),
    nodeVersion: process.version,
    uptimeSec: Math.floor(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    topSpaces: db
      .prepare(
        `SELECT s.name, s.slug, COUNT(p.id) AS pages, s.updated_at
         FROM spaces s LEFT JOIN pages p ON p.space_id = s.id
         GROUP BY s.id ORDER BY pages DESC LIMIT 6`
      )
      .all() as InstanceStats["topSpaces"],
    recentPages: db
      .prepare(
        `SELECT p.title, p.slug, s.slug AS space_slug, p.updated_at
         FROM pages p JOIN spaces s ON s.id = p.space_id
         ORDER BY p.updated_at DESC LIMIT 8`
      )
      .all() as InstanceStats["recentPages"],
  };
}
