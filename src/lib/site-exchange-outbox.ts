/** Disabled/unconnected, bounded durable delivery queue. Caller invokes one tick; no scheduler. */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { stageAtPeer, type StagingDestination } from './site-exchange-transport';
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const validId = (s: string) => /^[A-Za-z0-9_-]{1,128}$/.test(s);
export type DeliveryState = 'pending' | 'inflight' | 'staged' | 'held' | 'cancelled';
export type DeliverySummary = { id: string; peer: string; lineage: string; sha256: string; state: DeliveryState; attempts: number; nextAt: number; outcome: 'none' | 'unknown' | 'staged'; reason: string | null };
type Row = DeliverySummary & { bytes: Buffer; enrollment: string; token: string | null; leaseUntil: number | null };
export type OutboxOptions = {
  enabled: boolean;
  maxItems: number;
  maxBytes: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  preflightTimeoutMs?: number;
  /** Resolve current explicit enrollment. Credentials remain memory-only. */
  resolvePeer: (peer: string) => StagingDestination | Promise<StagingDestination>;
  /** Validate current lineage/origin trust, signatures and assets without applying pages. */
  verifyBundle: (bytes: Buffer, lineage: string) => void | Promise<void>;
  /** Clock injection is for deterministic tests, not peer-provided timestamps. */
  now?: () => number;
};
const columns = 'id,peer,lineage,sha256,state,attempts,next_at AS nextAt,outcome,reason';
function enrollment(c: StagingDestination): string {
  // Public enrollment only; never serialize the client private key or bundle contents.
  return hash(JSON.stringify([c.endpoint,c.address,c.serverCertificateSha256,c.lineage,hash(c.ca),hash(c.clientCertificate)]));
}
function snapshot(c: StagingDestination): StagingDestination {
  return {...c, ca:Buffer.isBuffer(c.ca)?Buffer.from(c.ca):c.ca, clientCertificate:Buffer.isBuffer(c.clientCertificate)?Buffer.from(c.clientCertificate):c.clientCertificate, clientKey:Buffer.isBuffer(c.clientKey)?Buffer.from(c.clientKey):c.clientKey};
}
function scope(bytes: Buffer, lineage: string) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 32*1024*1024) throw new Error('Invalid queued bundle');
  const value = JSON.parse(bytes.toString('utf8'));
  if (!validId(lineage) || value?.payload?.lineage !== lineage || !['octavo-exchange-v1','octavo-exchange-delta-v1'].includes(value?.payload?.format)) throw new Error('Invalid queued scope');
}
export class DeliveryOutbox {
  constructor(private readonly db: Database.Database, private readonly options: OutboxOptions) {
    if (!options.enabled) throw new Error('Outbox disabled');
    if (![options.maxItems,options.maxBytes,options.maxAttempts,options.baseDelayMs,options.maxDelayMs].every(Number.isSafeInteger) ||
        options.maxItems < 1 || options.maxItems > 1000 || options.maxBytes < 1 || options.maxBytes > 256*1024*1024 ||
        options.maxAttempts < 1 || options.maxAttempts > 8 || options.baseDelayMs < 100 || options.maxDelayMs < options.baseDelayMs || options.maxDelayMs > 3600000 ||
        (options.preflightTimeoutMs !== undefined && (!Number.isSafeInteger(options.preflightTimeoutMs) || options.preflightTimeoutMs < 1 || options.preflightTimeoutMs > 30000)) ||
        typeof options.resolvePeer !== 'function' || typeof options.verifyBundle !== 'function') throw new Error('Invalid outbox limits');
    if (db.readonly || db.inTransaction) throw new Error('Dedicated writable outbox required');
    db.pragma('synchronous=FULL'); this.durable();
    db.exec(`CREATE TABLE IF NOT EXISTS exchange_delivery_outbox (
      id TEXT PRIMARY KEY,peer TEXT NOT NULL,lineage TEXT NOT NULL,sha256 TEXT NOT NULL,enrollment TEXT NOT NULL,bytes BLOB NOT NULL,
      state TEXT NOT NULL,attempts INTEGER NOT NULL,next_at INTEGER NOT NULL,outcome TEXT NOT NULL,reason TEXT,token TEXT,lease_until INTEGER,
      UNIQUE(peer,enrollment,sha256)
    )`);
  }
  private async preflight<T>(fn:()=>Promise<T>):Promise<T> {
    let timer:ReturnType<typeof setTimeout>;
    try {return await Promise.race([Promise.resolve().then(fn),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Preflight deadline exceeded')),this.options.preflightTimeoutMs??30000);})]);}
    finally {clearTimeout(timer!);}
  }
  private now() {const n=(this.options.now??Date.now)();if(!Number.isSafeInteger(n)||n<0||n>Number.MAX_SAFE_INTEGER-7200000)throw new Error('Invalid queue clock');return n;}
  private durable() {
    if(this.db.inTransaction)throw new Error('Outbox cannot acknowledge an outer transaction');
    if(this.db.pragma('synchronous',{simple:true})!==2||!['delete','truncate','persist','wal'].includes(String(this.db.pragma('journal_mode',{simple:true})).toLowerCase()))throw new Error('Durable outbox requires FULL disk journaling');
  }
  private atomic<T>(fn:()=>T):T {this.durable();return this.db.transaction(fn).immediate();}
  private enabled() {if(!this.options.enabled)throw new Error('Outbox disabled');}
  private get(id:string):Row|undefined {return this.db.prepare(`SELECT ${columns},bytes,enrollment,token,lease_until AS leaseUntil FROM exchange_delivery_outbox WHERE id=?`).get(id) as Row|undefined;}
  async enqueue(peer:string,lineage:string,input:Buffer):Promise<DeliverySummary> {
    this.enabled();if(!validId(peer))throw new Error('Invalid peer identity');scope(input,lineage);const bytes=Buffer.from(input),sha256=hash(bytes);
    const config=await this.preflight(async()=>{await this.options.verifyBundle(Buffer.from(bytes),lineage);return snapshot(await this.options.resolvePeer(peer));});
    if(!config.enabled||config.lineage!==lineage)throw new Error('Peer is not enrolled for lineage');
    const enrolled=enrollment(config);this.enabled();
    const id=this.atomic(()=>{
      const existing=this.db.prepare('SELECT id FROM exchange_delivery_outbox WHERE peer=? AND enrollment=? AND sha256=?').get(peer,enrolled,sha256) as {id:string}|undefined;
      if(existing)return existing.id;
      const used=this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(bytes)),0) AS bytes FROM exchange_delivery_outbox').get() as {count:number;bytes:number};
      if(used.count>=this.options.maxItems||used.bytes+bytes.length>this.options.maxBytes)throw new Error('Outbox quota exceeded');
      const id=randomUUID();this.db.prepare('INSERT INTO exchange_delivery_outbox VALUES(?,?,?,?,?,?,?,0,?,?,NULL,NULL,NULL)').run(id,peer,lineage,sha256,enrolled,bytes,'pending',this.now(),'none');return id;
    });return this.summary(id)!;
  }
  summary(id:string):DeliverySummary|undefined {return this.db.prepare(`SELECT ${columns} FROM exchange_delivery_outbox WHERE id=?`).get(id) as DeliverySummary|undefined;}
  /** Keyset pagination by immutable random ID; output contains no payload/credential data. */
  list(limit=50,after=''):DeliverySummary[] {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||(after!==''&&!/^[a-f0-9-]{36}$/.test(after)))throw new Error('Invalid queue listing');
    return this.db.prepare(`SELECT ${columns} FROM exchange_delivery_outbox WHERE id>? ORDER BY id LIMIT ?`).all(after,limit) as DeliverySummary[];
  }
  /** Stops future attempts only. An in-flight request may already have reached the peer. */
  cancel(id:string):DeliverySummary|undefined {
    this.atomic(()=>this.db.prepare("UPDATE exchange_delivery_outbox SET state='cancelled', outcome=CASE WHEN state='inflight' THEN 'unknown' ELSE outcome END,reason='operator_cancelled',token=NULL,lease_until=NULL WHERE id=? AND state IN ('pending','inflight','held')").run(id));return this.summary(id);
  }
  private owned(id:string,token:string) {const row=this.get(id);return row?.state==='inflight'&&row.token===token&&row.leaseUntil!>this.now();}
  /** One bounded network attempt. Restart recovery occurs on ticks after a 60s lease expires.
   * Completion of staging is not application/import confirmation. Ambiguous retries are at-least-once.
   */
  async tick():Promise<DeliverySummary|undefined> {
    this.enabled();
    const row=this.atomic(()=>{
      const now=this.now();
      this.db.prepare("UPDATE exchange_delivery_outbox SET state=CASE WHEN attempts>=? THEN 'held' ELSE 'pending' END,reason='interrupted_delivery',outcome='unknown',token=NULL,lease_until=NULL WHERE state='inflight' AND lease_until<=?").run(this.options.maxAttempts,now);
      this.db.prepare("UPDATE exchange_delivery_outbox SET state='held',reason='attempt_limit' WHERE state='pending' AND attempts>=?").run(this.options.maxAttempts);
      const selected=this.db.prepare("SELECT id FROM exchange_delivery_outbox WHERE state='pending' AND next_at<=? ORDER BY next_at,id LIMIT 1").get(now) as {id:string}|undefined;
      if(!selected)return undefined;
      this.db.prepare("UPDATE exchange_delivery_outbox SET state='inflight',attempts=attempts+1,token=?,lease_until=?,reason=NULL WHERE id=?").run(randomUUID(),now+60000,selected.id);
      return this.get(selected.id)!;
    });if(!row)return undefined;
    const token=row.token!;
    let config:StagingDestination;
    try {
      if(hash(row.bytes)!==row.sha256)throw new Error('Corrupt queued bytes');scope(row.bytes,row.lineage);
      config=await this.preflight(async()=>{await this.options.verifyBundle(Buffer.from(row.bytes),row.lineage);return snapshot(await this.options.resolvePeer(row.peer));});
      if(!config.enabled||config.lineage!==row.lineage||enrollment(config)!==row.enrollment)throw new Error('Enrollment changed');
    } catch {
      this.atomic(()=>this.db.prepare("UPDATE exchange_delivery_outbox SET state='held',reason='verification_or_enrollment_changed',token=NULL,lease_until=NULL WHERE id=? AND token=? AND state='inflight'").run(row.id,token));return this.summary(row.id);
    }
    const canSend=this.atomic(()=>{
      if(!this.owned(row.id,token))return false;
      if(!this.options.enabled){this.db.prepare("UPDATE exchange_delivery_outbox SET state='pending',attempts=attempts-1,token=NULL,lease_until=NULL,reason='disabled_before_send' WHERE id=? AND token=?").run(row.id,token);return false;}
      this.db.prepare('UPDATE exchange_delivery_outbox SET lease_until=? WHERE id=? AND token=?').run(this.now()+60000,row.id,token);return true;
    });if(!canSend)return this.summary(row.id);
    let acknowledged=false;
    try {await stageAtPeer(config,Buffer.from(row.bytes));acknowledged=true;}catch {/* No exception text, endpoint, payload or credential is persisted. */}
    this.atomic(()=>{
      if(!this.owned(row.id,token))return;
      const delay=Math.min(this.options.maxDelayMs,this.options.baseDelayMs*2**Math.max(0,row.attempts-1));
      this.db.prepare('UPDATE exchange_delivery_outbox SET state=?,outcome=?,reason=?,next_at=?,token=NULL,lease_until=NULL WHERE id=? AND token=?')
        .run(acknowledged?'staged':row.attempts>=this.options.maxAttempts?'held':'pending',acknowledged?'staged':'unknown',acknowledged?null:'delivery_not_acknowledged',this.now()+delay,row.id,token);
    });return this.summary(row.id);
  }
}
