import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR =
  process.env.OCTAVO_DATA_DIR || path.join(process.cwd(), "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'docs',
  accent TEXT NOT NULL DEFAULT 'vermilion',
  position REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '[]',
  content_text TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(space_id, slug)
);
CREATE INDEX IF NOT EXISTS pages_space ON pages(space_id, parent_id, position);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_text TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS page_versions_page ON page_versions(page_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS page_links (
  from_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  PRIMARY KEY (from_page, to_page)
);
CREATE INDEX IF NOT EXISTS page_links_to ON page_links(to_page);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_page ON comments(page_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  page_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);
`;

declare global {
  // Survives Next.js dev-server module reloads.
  var __octavoDb: Database.Database | undefined;
}

function open(): Database.Database {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "octavo.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db: Database.Database) {
  const cols = (
    db.prepare("PRAGMA table_info(spaces)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!cols.includes("visibility")) {
    db.exec(
      "ALTER TABLE spaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'"
    );
  }
  if (!cols.includes("shelf")) {
    db.exec("ALTER TABLE spaces ADD COLUMN shelf TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes("typeface")) {
    db.exec("ALTER TABLE spaces ADD COLUMN typeface TEXT NOT NULL DEFAULT 'classic'");
    db.exec("ALTER TABLE spaces ADD COLUMN corners TEXT NOT NULL DEFAULT 'rounded'");
  }
  const userCols = (
    db.prepare("PRAGMA table_info(users)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!userCols.includes("totp_secret")) {
    db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT");
  }
  if (!userCols.includes("oidc_issuer")) {
    db.exec("ALTER TABLE users ADD COLUMN oidc_issuer TEXT");
    db.exec("ALTER TABLE users ADD COLUMN oidc_sub TEXT");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS users_oidc ON users(oidc_issuer, oidc_sub) WHERE oidc_issuer IS NOT NULL"
    );
  }
}

export function getDb(): Database.Database {
  if (!globalThis.__octavoDb) globalThis.__octavoDb = open();
  return globalThis.__octavoDb;
}
