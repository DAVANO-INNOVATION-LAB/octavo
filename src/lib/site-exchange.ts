import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export type ExchangeBody = { title: string; content: string; parentDocId: string | null; deleted: boolean; attachments: string[] };
export type ExchangeIdentity = { siteId: string; publicKey: string; privateKey: string };
export type ExchangeRevision = { id: string; lineage: string; docId: string; author: string; parents: string[]; body: ExchangeBody; signature: string };
// Database dependency is injected to permit independent sites in one test process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExchangeDb = any;
const MAX_BUNDLE = 32 * 1024 * 1024, MAX_ASSET = 8 * 1024 * 1024, MAX_REVISIONS = 5000;
export const MAX_EXCHANGE_RESOLUTION_HEADS = MAX_REVISIONS;
const MAX_REVISION_PARENTS = 100;
export const MAX_EXCHANGE_INVENTORY_REVISIONS = 50000;
export const MAX_EXCHANGE_INVENTORY_BYTES = 4 * 1024 * 1024;
export const MAX_EXCHANGE_DELTA_GRAPH_BYTES = 128 * 1024 * 1024;
type ExchangeInventory = {payload:{format:'octavo-exchange-inventory-v1';lineage:string;holder:string;revisions:string[]};signature:string};

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const exchangeHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fingerprint = (publicKey: string) => exchangeHash(publicKey);
function signatureBytes(value: unknown): Buffer { if(typeof value!=='string')throw new Error('Invalid signature'); const bytes=Buffer.from(value,'base64');if(bytes.length!==64||bytes.toString('base64')!==value)throw new Error('Invalid signature');return bytes; }
function ed25519(publicKey:string) { if(typeof publicKey!=='string'||publicKey.length>2000||createPublicKey(publicKey).asymmetricKeyType!=='ed25519')throw new Error('Only Ed25519 keys are supported'); }
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const digest = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function validateBody(value: unknown): asserts value is ExchangeBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid document body');
  const b = value as ExchangeBody;
  if (Object.keys(b).sort().join(',') !== 'attachments,content,deleted,parentDocId,title' || typeof b.title !== 'string' || b.title.length > 1000 || typeof b.content !== 'string' || Buffer.byteLength(b.content) > 1024*1024 || typeof b.deleted !== 'boolean' || (b.parentDocId !== null && !identifier(b.parentDocId)) || !Array.isArray(b.attachments) || b.attachments.length > 200 || !b.attachments.every(digest) || new Set(b.attachments).size !== b.attachments.length) throw new Error('Invalid document body');
  const blocks = JSON.parse(b.content); if (!Array.isArray(blocks)) throw new Error('Content must be a block array');
}
function unsigned(r: ExchangeRevision) { return {lineage:r.lineage,docId:r.docId,author:r.author,parents:r.parents,body:r.body}; }
function validateInventory(value:unknown,lineage:string,publicKey:string):ExchangeInventory {
  if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(canonical(value))>MAX_EXCHANGE_INVENTORY_BYTES)throw new Error('Invalid or oversized inventory');
  const inventory=value as ExchangeInventory,p=inventory.payload;
  if(Object.keys(inventory).sort().join(',')!=='payload,signature'||!p||Object.keys(p).sort().join(',')!=='format,holder,lineage,revisions'||p.format!=='octavo-exchange-inventory-v1'||p.lineage!==lineage||p.holder!==fingerprint(publicKey)||!Array.isArray(p.revisions)||p.revisions.length>MAX_EXCHANGE_INVENTORY_REVISIONS||!p.revisions.every(digest)||new Set(p.revisions).size!==p.revisions.length||canonical(p.revisions)!==canonical([...p.revisions].sort()))throw new Error('Invalid inventory purpose, scope or revision set');
  if(!verify(null,Buffer.from(canonical(p)),publicKey,signatureBytes(inventory.signature)))throw new Error('Invalid inventory signature');
  return inventory;
}
function frontier(revisions:ExchangeRevision[]):string[] {const parents=new Set(revisions.flatMap(r=>r.parents));return revisions.filter(r=>!parents.has(r.id)).map(r=>r.id).sort();}

export class SiteExchange {
  constructor(readonly db: ExchangeDb, readonly identity: ExchangeIdentity) {
    ed25519(identity.publicKey);
    if (identity.siteId !== fingerprint(identity.publicKey)) throw new Error('Invalid site identity');
    db.exec(`CREATE TABLE IF NOT EXISTS exchange_scopes(local_space TEXT PRIMARY KEY,lineage TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS exchange_trust(lineage TEXT NOT NULL,site TEXT NOT NULL,public_key TEXT NOT NULL,PRIMARY KEY(lineage,site));
      CREATE TABLE IF NOT EXISTS exchange_revisions(id TEXT PRIMARY KEY,lineage TEXT NOT NULL,doc TEXT NOT NULL,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS exchange_revision_doc ON exchange_revisions(lineage,doc);
      CREATE TABLE IF NOT EXISTS exchange_applied(lineage TEXT NOT NULL,doc TEXT NOT NULL,revision TEXT,PRIMARY KEY(lineage,doc));
      CREATE TABLE IF NOT EXISTS exchange_assets(hash TEXT PRIMARY KEY,bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS exchange_receipts(hash TEXT PRIMARY KEY,lineage TEXT NOT NULL,received_at INTEGER NOT NULL);`);
  }
  static createIdentity(): ExchangeIdentity { const pair=generateKeyPairSync('ed25519'); const publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString(); return {siteId:fingerprint(publicKey),publicKey,privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString()}; }
  bindScope(localSpace: string,lineage: string) { if(!identifier(localSpace)||!identifier(lineage))throw new Error('Invalid scope'); const old=this.db.prepare('SELECT lineage FROM exchange_scopes WHERE local_space=?').get(localSpace); if(old && old.lineage!==lineage)throw new Error('Scope rebinding requires migration'); this.db.prepare('INSERT OR IGNORE INTO exchange_scopes VALUES(?,?)').run(localSpace,lineage); this.trust(lineage,this.identity.publicKey); }
  trust(lineage:string,publicKey:string) { this.requireScope(lineage); const site=fingerprint(publicKey); // Verify this is a usable Ed25519 public key before accepting it.
    ed25519(publicKey);
    this.db.prepare('INSERT OR REPLACE INTO exchange_trust VALUES(?,?,?)').run(lineage,site,publicKey); return site; }
  revoke(lineage:string,site:string) {this.db.prepare('DELETE FROM exchange_trust WHERE lineage=? AND site=?').run(lineage,site);}
  private requireScope(lineage:string) {if(!this.db.prepare('SELECT 1 FROM exchange_scopes WHERE lineage=?').get(lineage))throw new Error('Unbound exchange scope');}
  revisions(lineage:string,docId?:string):ExchangeRevision[] { return (docId ? this.db.prepare('SELECT record FROM exchange_revisions WHERE lineage=? AND doc=? ORDER BY id').all(lineage,docId) : this.db.prepare('SELECT record FROM exchange_revisions WHERE lineage=? ORDER BY id').all(lineage)).map((r:{record:string})=>JSON.parse(r.record)); }
  heads(lineage:string,docId:string):ExchangeRevision[] { const all=this.revisions(lineage,docId), parents=new Set(all.flatMap(r=>r.parents));return all.filter(r=>!parents.has(r.id)); }
  applied(lineage:string,docId:string):string|null {return this.db.prepare('SELECT revision FROM exchange_applied WHERE lineage=? AND doc=?').get(lineage,docId)?.revision??null;}
  setApplied(lineage:string,docId:string,revision:string|null) { if(revision && !this.revisions(lineage,docId).some(r=>r.id===revision))throw new Error('Unknown applied revision'); this.db.prepare('INSERT INTO exchange_applied VALUES(?,?,?) ON CONFLICT(lineage,doc) DO UPDATE SET revision=excluded.revision').run(lineage,docId,revision); }
  putAsset(bytes:Buffer):string {if(bytes.length>MAX_ASSET)throw new Error('Attachment exceeds limit');const hash=exchangeHash(bytes);this.db.prepare('INSERT OR IGNORE INTO exchange_assets VALUES(?,?)').run(hash,bytes);return hash;}
  getAsset(hash:string):Buffer {const r=this.db.prepare('SELECT bytes FROM exchange_assets WHERE hash=?').get(hash);if(!r)throw new Error('Missing attachment');return Buffer.from(r.bytes);}
  capture(lineage:string,docId:string,body:ExchangeBody,parents?:string[]):string {
    this.requireScope(lineage);if(!identifier(docId))throw new Error('Invalid document identity');validateBody(body);
    return this.db.transaction(()=>{const applied=this.applied(lineage,docId),records=this.revisions(lineage,docId),known=new Set(records.map(r=>r.id));const previous=applied?records.find(r=>r.id===applied):undefined;
      if(parents===undefined && previous && canonical(previous.body)===canonical(body))return previous.id;
      const ancestry=parents??(applied?[applied]:[]); if(ancestry.length>MAX_REVISION_PARENTS || new Set(ancestry).size!==ancestry.length)throw new Error('Invalid revision parents');for(const parent of ancestry)if(!known.has(parent))throw new Error('Unknown revision parent');
      for(const hash of body.attachments)this.getAsset(hash);
      const raw={lineage,docId,author:this.identity.siteId,parents:[...ancestry].sort(),body};const id=exchangeHash(canonical(raw));const signature=sign(null,Buffer.from(id),this.identity.privateKey).toString('base64');const revision={...raw,id,signature};
      this.db.prepare('INSERT OR IGNORE INTO exchange_revisions VALUES(?,?,?,?)').run(id,lineage,docId,canonical(revision)); this.setApplied(lineage,docId,id);return id;
    })();
  }
  resolve(lineage:string,docId:string,body:ExchangeBody,expectedHeads:string[]):string {
    if(!Array.isArray(expectedHeads)||expectedHeads.length>MAX_EXCHANGE_RESOLUTION_HEADS||!expectedHeads.every(digest)||new Set(expectedHeads).size!==expectedHeads.length)throw new Error('Invalid resolution heads');
    return this.db.transaction(()=>{
      this.requireScope(lineage);if(!identifier(docId))throw new Error('Invalid document identity');validateBody(body);
      const actual=this.heads(lineage,docId).map(r=>r.id).sort();
      if(canonical(actual)!==canonical([...expectedHeads].sort()))throw new Error('Conflict heads changed');
      // One exact-head decision may need several signed merge nodes. Every node
      // retains the chosen body and at most 100 parents; all original histories
      // remain ancestors of the final node. No intermediate node is committed or
      // externally visible unless the complete decision succeeds.
      const pending=[...actual];
      while(pending.length>MAX_REVISION_PARENTS){const parents=pending.splice(0,MAX_REVISION_PARENTS);pending.push(this.capture(lineage,docId,body,parents));}
      const result=this.capture(lineage,docId,body,pending);
      // Merging must not strand a previously transportable graph beyond its
      // unchanged full-history limits. Export checks and all merges share the
      // transaction, so count/byte/signing failure leaves heads/applied intact.
      this.exportBundle(lineage);
      return result;
    }).immediate();
  }
  exportBundle(lineage:string):string {
    this.requireScope(lineage);const revisions=this.revisions(lineage);if(revisions.length>MAX_REVISIONS)throw new Error('Revision export exceeds limit');
    const assets=Object.fromEntries([...new Set(revisions.flatMap(r=>r.body.attachments))].sort().map(hash=>[hash,this.getAsset(hash).toString('base64')]));
    const payload={format:'octavo-exchange-v1',lineage,sender:this.identity.siteId,revisions,assets};const signature=sign(null,Buffer.from(canonical(payload)),this.identity.privateKey).toString('base64');const raw=canonical({payload,signature});if(Buffer.byteLength(raw)>MAX_BUNDLE)throw new Error('Bundle exceeds limit');return raw;
  }
  private deltaGraphBounds(lineage:string):number {
    const count=this.db.prepare('SELECT count(*) n FROM exchange_revisions WHERE lineage=?').get(lineage).n;
    if(count>MAX_EXCHANGE_INVENTORY_REVISIONS)throw new Error('Delta local graph revision limit exceeded');
    const bytes=this.db.prepare('SELECT coalesce(sum(length(CAST(record AS BLOB))),0) n FROM exchange_revisions WHERE lineage=?').get(lineage).n;
    if(bytes>MAX_EXCHANGE_DELTA_GRAPH_BYTES)throw new Error('Delta local graph byte limit exceeded');return bytes;
  }
  /** Manual receiver inventory: a claim about retained IDs, not a permission grant. */
  exportInventory(lineage:string):string {
    this.requireScope(lineage);const count=this.db.prepare('SELECT count(*) n FROM exchange_revisions WHERE lineage=?').get(lineage).n;
    if(count>MAX_EXCHANGE_INVENTORY_REVISIONS)throw new Error('Inventory revision limit exceeded');
    const revisions=(this.db.prepare('SELECT id FROM exchange_revisions WHERE lineage=? ORDER BY id').all(lineage) as {id:string}[]).map(r=>r.id);
    const payload={format:'octavo-exchange-inventory-v1',lineage,holder:this.identity.siteId,revisions};
    const raw=canonical({payload,signature:sign(null,Buffer.from(canonical(payload)),this.identity.privateKey).toString('base64')});
    if(Buffer.byteLength(raw)>MAX_EXCHANGE_INVENTORY_BYTES)throw new Error('Inventory byte limit exceeded');return raw;
  }
  /** One bounded, complete delta. Never exports or applies a partial prefix. */
  exportDeltaBundle(lineage:string,inventoryRaw:string):string {
    if(typeof inventoryRaw!=='string'||Buffer.byteLength(inventoryRaw)>MAX_EXCHANGE_INVENTORY_BYTES)throw new Error('Inventory byte limit exceeded');
    return this.db.transaction(()=>{
      this.requireScope(lineage);const candidate=JSON.parse(inventoryRaw),holder=candidate?.payload?.holder;
      if(!digest(holder))throw new Error('Invalid inventory holder');
      const receiver=this.db.prepare('SELECT public_key FROM exchange_trust WHERE lineage=? AND site=?').get(lineage,holder);if(!receiver)throw new Error('Untrusted inventory holder');
      const basis=validateInventory(candidate,lineage,receiver.public_key);this.deltaGraphBounds(lineage);const known=new Set(basis.payload.revisions),all=this.revisions(lineage),revisions=all.filter(r=>!known.has(r.id));
      if(revisions.length>MAX_REVISIONS)throw new Error('Delta revision limit exceeded; no partial transfer exported');
      const sourceFrontier=frontier(all);if(sourceFrontier.length>MAX_EXCHANGE_INVENTORY_REVISIONS)throw new Error('Delta frontier limit exceeded');
      const assets=Object.fromEntries([...new Set(revisions.flatMap(r=>r.body.attachments))].sort().map(hash=>[hash,this.getAsset(hash).toString('base64')]));
      const payload={format:'octavo-exchange-delta-v1',lineage,sender:this.identity.siteId,recipient:holder,basis,frontier:sourceFrontier,revisions,assets};
      const raw=canonical({payload,signature:sign(null,Buffer.from(canonical(payload)),this.identity.privateKey).toString('base64')});
      if(Buffer.byteLength(raw)>MAX_BUNDLE)throw new Error('Delta bundle exceeds limit; no partial transfer exported');return raw;
    }).immediate();
  }
  importBundle(raw:string):{lineage:string;inserted:number;replayed:boolean} {
    // Hold a write transaction across trust validation and insertion, preventing
    // concurrent revocation from racing the authorization decision.
    return this.db.transaction(()=>this.importValidated(raw)).immediate();
  }
  private importValidated(raw:string):{lineage:string;inserted:number;replayed:boolean} {
    if(Buffer.byteLength(raw)>MAX_BUNDLE)throw new Error('Bundle exceeds limit');const bundle=JSON.parse(raw);const p=bundle?.payload;
    const delta=p?.format==='octavo-exchange-delta-v1';
    if(!p || Object.keys(bundle).sort().join(',')!=='payload,signature' || Object.keys(p).sort().join(',')!==(delta?'assets,basis,format,frontier,lineage,recipient,revisions,sender':'assets,format,lineage,revisions,sender') || (!delta&&p.format!=='octavo-exchange-v1') || !identifier(p.lineage) || !digest(p.sender)||!Array.isArray(p.revisions)||p.revisions.length>MAX_REVISIONS || !p.assets || typeof p.assets!=='object'||Array.isArray(p.assets))throw new Error('Invalid exchange bundle');
    this.requireScope(p.lineage);const sender=this.db.prepare('SELECT public_key FROM exchange_trust WHERE lineage=? AND site=?').get(p.lineage,p.sender);if(!sender)throw new Error('Untrusted sending site');
    if(typeof bundle.signature!=='string'||!verify(null,Buffer.from(canonical(p)),sender.public_key,signatureBytes(bundle.signature)))throw new Error('Invalid bundle signature');
    let basis:ExchangeInventory|undefined;
    if(delta){
      if(p.recipient!==this.identity.siteId)throw new Error('Delta recipient mismatch');
      basis=validateInventory(p.basis,p.lineage,this.identity.publicKey);
      if(!Array.isArray(p.frontier)||p.frontier.length>MAX_EXCHANGE_INVENTORY_REVISIONS||!p.frontier.every(digest)||new Set(p.frontier).size!==p.frontier.length||canonical(p.frontier)!==canonical([...p.frontier].sort()))throw new Error('Invalid delta frontier');
    }
    const verified=new Set<string>();
    const verifyRecord=(r:ExchangeRevision)=>{
      if(!r || Object.keys(r).sort().join(',')!=='author,body,docId,id,lineage,parents,signature' || r.lineage!==p.lineage || !identifier(r.docId)||!digest(r.id)||!digest(r.author)||!Array.isArray(r.parents)||r.parents.length>MAX_REVISION_PARENTS||!r.parents.every(digest)||new Set(r.parents).size!==r.parents.length||canonical(r.parents)!==canonical([...r.parents].sort()))throw new Error('Invalid revision');
      validateBody(r.body);const author=this.db.prepare('SELECT public_key FROM exchange_trust WHERE lineage=? AND site=?').get(p.lineage,r.author);if(!author)throw new Error('Untrusted origin site');if(exchangeHash(canonical(unsigned(r)))!==r.id || !verify(null,Buffer.from(r.id),author.public_key,signatureBytes(r.signature)))throw new Error('Invalid origin signature');
      verified.add(r.id);
    };
    const incoming=new Map<string,ExchangeRevision>();for(const r of p.revisions as ExchangeRevision[]){verifyRecord(r);if(incoming.has(r.id))throw new Error('Duplicate revision in bundle');incoming.set(r.id,r);}
    const existingBytes=delta?this.deltaGraphBounds(p.lineage):0;
    const existing=new Map(this.revisions(p.lineage).map(r=>[r.id,r])); const all=new Map([...existing,...incoming]);
    if(delta&&(all.size>MAX_EXCHANGE_INVENTORY_REVISIONS||existingBytes+[...incoming.values()].filter(r=>!existing.has(r.id)).reduce((n,r)=>n+Buffer.byteLength(canonical(r)),0)>MAX_EXCHANGE_DELTA_GRAPH_BYTES))throw new Error('Delta resulting graph limit exceeded');
    // A signed inventory can be stale, but cannot survive lost receiver state:
    // check every advertised ID against the actual pre-import graph atomically.
    if(basis&&basis.payload.revisions.some(id=>!existing.has(id)))throw new Error('Inventory basis no longer exists; request a fresh inventory');
    if(delta){
      const reached=new Set<string>(),verifiedAssets=new Set<string>(),pending:string[]=[...p.frontier];
      while(pending.length){const id=pending.pop()!;if(reached.has(id))continue;const r=all.get(id);if(!r)throw new Error('Incomplete delta source frontier');
        if(!verified.has(id))verifyRecord(r);reached.add(id);
        // Omitted ancestry must still have its local content bytes. Retained
        // revision IDs alone are not proof that a restored/corrupt cache is whole.
        if(!incoming.has(id))for(const hash of r.body.attachments)if(!verifiedAssets.has(hash)){
          const saved=this.db.prepare('SELECT bytes FROM exchange_assets WHERE hash=? AND length(bytes)<=?').get(hash,MAX_ASSET);
          if(!saved||exchangeHash(Buffer.from(saved.bytes))!==hash)throw new Error('Retained delta attachment missing or corrupt');verifiedAssets.add(hash);
        }
        for(const parent of r.parents){const ancestor=all.get(parent);if(!ancestor||ancestor.lineage!==r.lineage||ancestor.docId!==r.docId)throw new Error('Missing or cross-document delta ancestry');pending.push(parent);}
      }
      if([...incoming.keys()].some(id=>!reached.has(id)))throw new Error('Delta revisions outside declared source frontier');
    }
    for(const r of incoming.values()){const old=existing.get(r.id);if(old&&canonical(old)!==canonical(r))throw new Error('Revision identity reuse');for(const parent of r.parents){const ancestor=all.get(parent);if(!ancestor||ancestor.docId!==r.docId||ancestor.lineage!==r.lineage)throw new Error('Missing or cross-document parent');}}
    // Explicit cycle validation even though content addressing makes cycles computationally unlikely.
    const visited=new Set<string>();
    for(const root of incoming.keys()) {
      if(visited.has(root))continue;
      const active=new Set<string>(),stack:{id:string;exit:boolean}[]=[{id:root,exit:false}];
      while(stack.length){const step=stack.pop()!;if(step.exit){active.delete(step.id);visited.add(step.id);continue;}
        if(visited.has(step.id))continue;if(active.has(step.id))throw new Error('Revision cycle');active.add(step.id);stack.push({id:step.id,exit:true});
        for(const parent of all.get(step.id)!.parents)stack.push({id:parent,exit:false});
      }
    }
    const assets=new Map<string,Buffer>();for(const [hash,data] of Object.entries(p.assets)){if(!digest(hash)||typeof data!=='string'||data.length>Math.ceil(MAX_ASSET/3)*4)throw new Error('Invalid attachment');const bytes=Buffer.from(data,'base64');if(bytes.length>MAX_ASSET||bytes.toString('base64')!==data||exchangeHash(bytes)!==hash)throw new Error('Corrupt attachment');assets.set(hash,bytes);}
    // Full-history bundles must supply their own bytes. The local content-addressed
    // pool is shared storage, never evidence that this lineage may obtain an asset.
    for(const r of incoming.values())for(const hash of r.body.attachments)if(!assets.has(hash))throw new Error('Missing attachment');
    return this.db.transaction(()=>{const receipt=exchangeHash(raw);if(this.db.prepare('SELECT 1 FROM exchange_receipts WHERE hash=?').get(receipt)){
      if(delta){if([...incoming.keys()].some(id=>!existing.has(id)))throw new Error('Delta replay graph no longer matches its receipt');for(const [hash,bytes] of assets){const saved=this.db.prepare('SELECT bytes FROM exchange_assets WHERE hash=?').get(hash);if(!saved||!Buffer.from(saved.bytes).equals(bytes))throw new Error('Delta replay attachment no longer matches its receipt');}}
      return {lineage:p.lineage,inserted:0,replayed:true};
    }
    if(delta)for(const [hash,bytes] of assets){const saved=this.db.prepare('SELECT bytes FROM exchange_assets WHERE hash=?').get(hash);if(saved&&!Buffer.from(saved.bytes).equals(bytes))throw new Error('Local attachment collision; delta held');}
    let inserted=0;for(const [hash,bytes] of assets)this.db.prepare('INSERT OR IGNORE INTO exchange_assets VALUES(?,?)').run(hash,bytes);for(const r of incoming.values())inserted+=this.db.prepare('INSERT OR IGNORE INTO exchange_revisions VALUES(?,?,?,?)').run(r.id,r.lineage,r.docId,canonical(r)).changes;this.db.prepare('INSERT INTO exchange_receipts VALUES(?,?,?)').run(receipt,p.lineage,Date.now());return {lineage:p.lineage,inserted,replayed:false};})();
  }
}
