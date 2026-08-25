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
  variant_group TEXT NOT NULL DEFAULT '',
  variant_label TEXT NOT NULL DEFAULT '',
  variant_kind TEXT NOT NULL DEFAULT 'version',
  variant_position REAL NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS space_members_user ON space_members(user_id);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential TEXT NOT NULL DEFAULT '',
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connectors_space ON connectors(space_id);

CREATE TABLE IF NOT EXISTS collab_docs (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  state BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  page_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, path)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  space_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL DEFAULT '',
  object_label TEXT NOT NULL DEFAULT '',
  space_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log(actor_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_space ON audit_log(space_id, at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  connector_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  page_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  external_url TEXT NOT NULL DEFAULT '',
  started INTEGER NOT NULL,
  finished INTEGER
);
CREATE INDEX IF NOT EXISTS runs_page ON runs(page_id, started DESC);

CREATE TABLE IF NOT EXISTS page_views (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, day)
);

CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  hits INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS searches_at ON searches(at DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  helpful INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_page ON feedback(page_id, at DESC);

CREATE TABLE IF NOT EXISTS page_links (
  from_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  PRIMARY KEY (from_page, to_page)
);
CREATE INDEX IF NOT EXISTS page_links_to ON page_links(to_page);

-- Reading signals: where readers slow down, double back, and give up.
--
-- Deliberately shaped so it CANNOT answer "did this person read this page".
-- There is no user id, no session id, no address, and no event stream — only
-- counters summed per passage per day. That is not a policy we promise to
-- keep, it is the only thing the table is able to hold. A writer learns which
-- sentences fail; nobody learns who failed at them.
-- Groups: a set of people granted a role in a space all at once.
--
-- A group can be maintained by hand or carried by an OIDC claim. When the
-- identity provider owns it, membership is replaced on every sign-in rather
-- than merged — an account removed from a group upstream must lose the
-- access here too, and a merge would silently keep it.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  claim_value TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_claim INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_space_roles (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'reader',
  PRIMARY KEY (group_id, space_id)
);

-- Visitor tokens: a link that opens one private space to someone outside the
-- library, for a while, revocably.
--
-- Only the hash is stored. A stolen database yields no working links, and an
-- operator who loses the link cannot recover it — they issue another, which
-- is the correct trade for a credential.
CREATE TABLE IF NOT EXISTS visitor_tokens (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS visitor_space ON visitor_tokens(space_id);

-- Failed sign-ins, for lockout. Pruned as they age out of the window.
CREATE TABLE IF NOT EXISTS signin_failures (
  email TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS signin_failures_email ON signin_failures(email, at);

CREATE TABLE IF NOT EXISTS reading_signals (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  revisits INTEGER NOT NULL DEFAULT 0,
  exits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, block_id, day)
);
CREATE INDEX IF NOT EXISTS reading_day ON reading_signals(day);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  block_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at INTEGER,
  anchor_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS comments_page ON comments(page_id, created_at);
CREATE INDEX IF NOT EXISTS comments_thread ON comments(page_id, parent_id, created_at);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  proposed_title TEXT NOT NULL,
  proposed_content TEXT NOT NULL,
  base_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  merged_at INTEGER,
  merged_by TEXT
);
CREATE INDEX IF NOT EXISTS crs_page ON change_requests(page_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS cr_reviews (
  id TEXT PRIMARY KEY,
  cr_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cr_reviews_cr ON cr_reviews(cr_id, at DESC);

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
  const commentCols = (
    db.prepare("PRAGMA table_info(comments)").all() as { name: string }[]
  ).map((c) => c.name);
  if (commentCols.length && !commentCols.includes("block_id")) {
    db.exec("ALTER TABLE comments ADD COLUMN block_id TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE comments ADD COLUMN parent_id TEXT");
    db.exec("ALTER TABLE comments ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE comments ADD COLUMN resolved_by TEXT");
    db.exec("ALTER TABLE comments ADD COLUMN resolved_at INTEGER");
  }
  // The passage a thread was started on, copied at the time. A block can be
  // rewritten or deleted after the fact; without this the thread survives as
  // a reply to something nobody can read any more.
  if (commentCols.length && !commentCols.includes("anchor_text")) {
    db.exec("ALTER TABLE comments ADD COLUMN anchor_text TEXT NOT NULL DEFAULT ''");
  }
  const spaceCols = (
    db.prepare("PRAGMA table_info(spaces)").all() as { name: string }[]
  ).map((c) => c.name);
  if (spaceCols.length && !spaceCols.includes("variant_group")) {
    db.exec("ALTER TABLE spaces ADD COLUMN variant_group TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE spaces ADD COLUMN variant_label TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE spaces ADD COLUMN variant_kind TEXT NOT NULL DEFAULT 'version'");
    db.exec("ALTER TABLE spaces ADD COLUMN variant_position REAL NOT NULL DEFAULT 0");
  }
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
