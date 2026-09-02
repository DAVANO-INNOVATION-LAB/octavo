import "server-only";
import { getDb } from "./db";
import { newId, now, slugify } from "./util";
import type { Space } from "./data";

/**
 * Published sites.
 *
 * One library, more than one front door. The same handbook can be the whole
 * of a customer-facing site and one section of an internal one, under a
 * different name and different dress, without being copied.
 *
 * The rule that makes this safe to build at all: a site decides what is
 * PRESENTED and how, never who may read it. Every page reached through a site
 * goes through exactly the same visibility check it would anywhere else, so a
 * site cannot be used to expose a private space and adding a space to a site
 * grants nobody anything.
 */

export type Site = {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  host: string;
  accent: string;
  typeface: string;
  published: number;
  position: number;
  created_at: number;
  updated_at: number;
};

export type SiteSection = {
  id: string;
  site_id: string;
  title: string;
  blurb: string;
  position: number;
};

export type SiteEntry = {
  space: Space;
  sectionId: string | null;
  /** What the space is called here, falling back to its own name. */
  label: string;
  position: number;
};

export function listSites(): Site[] {
  return getDb()
    .prepare("SELECT * FROM sites ORDER BY position, name")
    .all() as Site[];
}

export function getSite(id: string): Site | null {
  return (getDb().prepare("SELECT * FROM sites WHERE id = ?").get(id) as Site) ?? null;
}

export function getSiteBySlug(slug: string): Site | null {
  return (getDb().prepare("SELECT * FROM sites WHERE slug = ?").get(slug) as Site) ?? null;
}

/**
 * The site a request belongs to, by Host.
 *
 * Compared without the port, and case-insensitively, because "Docs.Example.org"
 * and "docs.example.org:8443" are the same site to everyone except a string
 * comparison. An unpublished site never answers on its host — otherwise
 * "published" would mean nothing.
 */
export function siteForHost(host: string): Site | null {
  const clean = host.toLowerCase().split(":")[0].trim();
  if (!clean) return null;
  return (
    (getDb()
      .prepare("SELECT * FROM sites WHERE lower(host) = ? AND published = 1")
      .get(clean) as Site) ?? null
  );
}

export function createSite(input: { name: string; tagline?: string }): Site {
  const db = getDb();
  const id = newId();
  let slug = slugify(input.name) || "site";
  if (db.prepare("SELECT 1 FROM sites WHERE slug = ?").get(slug))
    slug = `${slug}-${id.slice(0, 4)}`;
  const t = now();
  const pos = (
    db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM sites").get() as { p: number }
  ).p;
  db.prepare(
    `INSERT INTO sites (id, slug, name, tagline, host, accent, typeface, published, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '', '', 0, ?, ?, ?)`
  ).run(id, slug, input.name.trim(), input.tagline?.trim() ?? "", pos + 1, t, t);
  return getSite(id)!;
}

export function updateSite(
  id: string,
  fields: Partial<Pick<Site, "name" | "tagline" | "host" | "accent" | "typeface" | "published">>
): void {
  const db = getDb();
  const site = getSite(id);
  if (!site) return;
  // A host belongs to one site. Two sites answering the same name is a
  // coin toss at request time, so the newer claim wins and the older is
  // cleared rather than both being left half-wired.
  const host = fields.host !== undefined ? fields.host.toLowerCase().trim().split(":")[0] : site.host;
  if (host && host !== site.host)
    db.prepare("UPDATE sites SET host = '' WHERE lower(host) = ? AND id <> ?").run(host, id);
  db.prepare(
    `UPDATE sites SET name = ?, tagline = ?, host = ?, accent = ?, typeface = ?, published = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    fields.name?.trim() || site.name,
    fields.tagline !== undefined ? fields.tagline.trim() : site.tagline,
    host,
    fields.accent !== undefined ? fields.accent : site.accent,
    fields.typeface !== undefined ? fields.typeface : site.typeface,
    fields.published !== undefined ? (fields.published ? 1 : 0) : site.published,
    now(),
    id
  );
}

export function deleteSite(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM site_spaces WHERE site_id = ?").run(id);
  db.prepare("DELETE FROM site_sections WHERE site_id = ?").run(id);
  db.prepare("DELETE FROM sites WHERE id = ?").run(id);
}

/* ---- sections ---- */

export function listSections(siteId: string): SiteSection[] {
  return getDb()
    .prepare("SELECT * FROM site_sections WHERE site_id = ? ORDER BY position, title")
    .all(siteId) as SiteSection[];
}

export function addSection(siteId: string, title: string, blurb = ""): SiteSection {
  const db = getDb();
  const id = newId();
  const pos = (
    db
      .prepare("SELECT COALESCE(MAX(position), 0) AS p FROM site_sections WHERE site_id = ?")
      .get(siteId) as { p: number }
  ).p;
  db.prepare(
    "INSERT INTO site_sections (id, site_id, title, blurb, position) VALUES (?, ?, ?, ?, ?)"
  ).run(id, siteId, title.trim() || "Section", blurb.trim(), pos + 1);
  return getDb().prepare("SELECT * FROM site_sections WHERE id = ?").get(id) as SiteSection;
}

export function removeSection(id: string): void {
  const db = getDb();
  // The spaces stay on the site, they just stop being grouped — deleting a
  // heading should not delete what was under it.
  db.prepare("UPDATE site_spaces SET section_id = NULL WHERE section_id = ?").run(id);
  db.prepare("DELETE FROM site_sections WHERE id = ?").run(id);
}

/* ---- membership ---- */

export function putSpace(
  siteId: string,
  spaceId: string,
  opts: { sectionId?: string | null; label?: string } = {}
): void {
  const db = getDb();
  const pos = (
    db
      .prepare("SELECT COALESCE(MAX(position), 0) AS p FROM site_spaces WHERE site_id = ?")
      .get(siteId) as { p: number }
  ).p;
  db.prepare(
    `INSERT INTO site_spaces (site_id, space_id, section_id, label, position)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site_id, space_id) DO UPDATE SET
       section_id = excluded.section_id, label = excluded.label`
  ).run(siteId, spaceId, opts.sectionId ?? null, opts.label?.trim() ?? "", pos + 1);
}

export function removeSpace(siteId: string, spaceId: string): void {
  getDb()
    .prepare("DELETE FROM site_spaces WHERE site_id = ? AND space_id = ?")
    .run(siteId, spaceId);
}

/**
 * What this site shows, for a reader who may see `readableIds`.
 *
 * The visibility filter lives here rather than in the page, because every
 * caller wants it and a caller that forgets it is a private space on a public
 * site. A site never widens what someone may read.
 */
export function siteEntries(
  siteId: string,
  /** "all" for an instance admin, otherwise the private spaces they may read. */
  readableIds: "all" | string[]
): SiteEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ss.section_id, ss.label, ss.position, s.*
         FROM site_spaces ss JOIN spaces s ON s.id = ss.space_id
        WHERE ss.site_id = ?
        ORDER BY ss.position`
    )
    .all(siteId) as (Space & { section_id: string | null; label: string; position: number })[];

  const allowed = readableIds === "all" ? null : new Set(readableIds);
  return rows
    .filter((r) => r.visibility === "public" || allowed === null || allowed.has(r.id))
    .map((r) => ({
      space: r as Space,
      sectionId: r.section_id,
      label: r.label || r.name,
      position: r.position,
    }));
}

/** Which sites a space appears on — shown where the space is administered. */
export function sitesForSpace(spaceId: string): Site[] {
  return getDb()
    .prepare(
      `SELECT si.* FROM sites si JOIN site_spaces ss ON ss.site_id = si.id
        WHERE ss.space_id = ? ORDER BY si.name`
    )
    .all(spaceId) as Site[];
}
