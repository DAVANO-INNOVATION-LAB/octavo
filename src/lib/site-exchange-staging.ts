/** Opt-in durable inbox for the unconnected transport prototype. Never applies pages. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

const HARD_BYTES = 32 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
export type StagingItem = { sha256: string; lineage: string; bytes: Buffer };
export type InboxOptions = {
  enabled: boolean;
  /** Synchronous request authority, rechecked after asynchronous verification. */
  authorize?: () => void;
  maxItems: number;
  maxBytes: number;
  maxBundleBytes: number;
  /** Must check current lineage/origin trust, all signatures and assets, without applying pages. */
  verifyBundle: (bytes: Buffer, lineage: string) => void | Promise<void>;
};
export type StagedSummary = { sha256: string; lineage: string; size: number; receivedAt: number };
/** Caller must supply a dedicated, privately protected local SQLite database.
 * FULL synchronous transactions are required; these are logical inbox quotas,
 * not a bound on SQLite file/WAL size. No key material is stored here.
 */
export class StagingInbox {
  constructor(private readonly db: Database.Database, private readonly options: InboxOptions) {
    if (!options.enabled) throw new Error('Staging inbox is disabled');
    if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1 || options.maxItems > 1000 ||
        !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 256 * 1024 * 1024 ||
        !Number.isSafeInteger(options.maxBundleBytes) || options.maxBundleBytes < 1 || options.maxBundleBytes > HARD_BYTES ||
        options.maxBundleBytes > options.maxBytes || typeof options.verifyBundle !== 'function') throw new Error('Invalid inbox limits');
    if (db.inTransaction || db.readonly) throw new Error('Dedicated writable inbox required');
    if (!['delete', 'truncate', 'persist', 'wal'].includes(String(db.pragma('journal_mode', { simple: true })).toLowerCase())) throw new Error('Durable inbox requires on-disk journaling');
    db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS exchange_staging_inbox (
      sha256 TEXT PRIMARY KEY NOT NULL,
      lineage TEXT NOT NULL,
      bytes BLOB NOT NULL,
      received_at INTEGER NOT NULL
    )`);
  }
  /** Signature validation happens even for duplicates so revoked peers cannot reuse receipts. */
  async stage(item: StagingItem): Promise<void> {
    if (!this.options.enabled) throw new Error('Staging inbox is disabled');
    if (!identifier(item.lineage) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Buffer.isBuffer(item.bytes) ||
        item.bytes.length < 1 || item.bytes.length > this.options.maxBundleBytes) throw new Error('Invalid staging item');
    // Copy before the await: callers cannot mutate retained bytes during verification.
    const bytes = Buffer.from(item.bytes), lineage = item.lineage, sha256 = item.sha256;
    if (digest(bytes) !== sha256) throw new Error('Staging digest mismatch');
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed?.payload?.lineage !== lineage || !['octavo-exchange-v1', 'octavo-exchange-delta-v1'].includes(parsed?.payload?.format)) throw new Error('Invalid staging scope');
    await this.options.verifyBundle(Buffer.from(bytes), lineage);
    // The owner may disable admission while asynchronous validation runs.
    if (!this.options.enabled) throw new Error('Staging inbox is disabled');
    if (this.db.inTransaction) throw new Error('Staging cannot acknowledge an outer transaction');
    this.db.transaction(() => {
      this.options.authorize?.();
      if (!['delete', 'truncate', 'persist', 'wal'].includes(String(this.db.pragma('journal_mode', { simple: true })).toLowerCase())) throw new Error('Durable inbox requires on-disk journaling');
      if (this.db.pragma('synchronous', { simple: true }) !== 2) throw new Error('Durable inbox requires synchronous FULL');
      const existing = this.db.prepare('SELECT lineage, bytes FROM exchange_staging_inbox WHERE sha256=?').get(sha256) as { lineage: string; bytes: Buffer } | undefined;
      if (existing) {
        if (existing.lineage !== lineage || !existing.bytes.equals(bytes)) throw new Error('Staging identity mismatch');
        return;
      }
      const used = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(bytes)),0) AS bytes FROM exchange_staging_inbox').get() as { count: number; bytes: number };
      if (used.count >= this.options.maxItems || used.bytes + bytes.length > this.options.maxBytes) throw new Error('Staging inbox quota exceeded');
      this.db.prepare('INSERT INTO exchange_staging_inbox VALUES (?,?,?,?)').run(sha256, lineage, bytes, Date.now());
    }).immediate();
  }
  /** Metadata only. The UI must still enforce administrator and lineage access. */
  list(lineage: string, limit = 50): StagedSummary[] {
    if (!identifier(lineage) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid inbox listing');
    return this.db.prepare('SELECT sha256, lineage, length(bytes) AS size, received_at AS receivedAt FROM exchange_staging_inbox WHERE lineage=? ORDER BY received_at, sha256 LIMIT ?').all(lineage, limit) as StagedSummary[];
  }
  listPage(lineage:string,after="",limit=50):{items:StagedSummary[];next:string|null} {
    if(!identifier(lineage)||!Number.isSafeInteger(limit)||limit<1||limit>100||(after!==""&&!/^[a-f0-9]{64}$/.test(after)))throw new Error('Invalid inbox cursor');
    const rows=this.db.prepare('SELECT sha256,lineage,length(bytes) AS size,received_at AS receivedAt FROM exchange_staging_inbox WHERE lineage=? AND sha256>? ORDER BY sha256 LIMIT ?').all(lineage,after,limit+1) as StagedSummary[];
    return {items:rows.slice(0,limit),next:rows.length>limit?rows[limit-1].sha256:null};
  }
  /** Review reads revalidate current trust; staging itself never authorizes application. */
  async readVerified(lineage: string, sha256: string): Promise<Buffer> {
    if (!identifier(lineage) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid inbox identity');
    const row = this.db.prepare('SELECT bytes FROM exchange_staging_inbox WHERE lineage=? AND sha256=?').get(lineage, sha256) as { bytes: Buffer } | undefined;
    if (!row || digest(row.bytes) !== sha256) throw new Error('Staged bundle missing or corrupt');
    const bytes = Buffer.from(row.bytes);
    await this.options.verifyBundle(Buffer.from(bytes), lineage);
    this.options.authorize?.();
    return bytes;
  }
}
