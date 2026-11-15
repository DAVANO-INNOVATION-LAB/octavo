import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import Module,{createRequire} from 'node:module';import ts from 'typescript';import Database from 'better-sqlite3';
import {sign,generateKeyPairSync} from 'node:crypto';
const require=createRequire(import.meta.url);Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {SiteExchange,canonical,exchangeHash}=require('../src/lib/site-exchange.ts');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-exchange-'));const dbs=[];let count=0;
const site=n=>{const db=new Database(path.join(root,n+'.db'));dbs.push(db);const engine=new SiteExchange(db,SiteExchange.createIdentity());engine.bindScope('local-'+n,'scope');return engine;};
const A=site('a'),B=site('b'),C=site('c');for(const x of [A,B,C])for(const y of [A,B,C])x.trust('scope',y.identity.publicKey);
const body=(text,extra={})=>({title:'Page',content:JSON.stringify([{id:'b1',type:'paragraph',content:[{type:'text',text,styles:{}}],children:[]}]),parentDocId:null,deleted:false,attachments:[],...extra});
const apply=(s,doc)=>{const heads=s.heads('scope',doc);if(heads.length===1)s.setApplied('scope',doc,heads[0].id);};
const run=(name,fn)=>{fn();count++;console.log('ok',name);};
const resign=(s,b)=>{b.signature=sign(null,Buffer.from(canonical(b.payload)),s.identity.privateKey).toString('base64');return canonical(b);};
try {
run('initial exchange and exact replay no duplicates',()=>{A.capture('scope','doc',body('base'));const bundle=A.exportBundle('scope');assert.equal(B.importBundle(bundle).inserted,1);apply(B,'doc');assert.equal(B.importBundle(bundle).replayed,true);assert.equal(B.revisions('scope').length,1);});
run('two offline edits preserved as two heads',()=>{A.capture('scope','doc',body('A offline'));B.capture('scope','doc',body('B offline'));A.importBundle(B.exportBundle('scope'));B.importBundle(A.exportBundle('scope'));assert.equal(A.heads('scope','doc').length,2);assert.deepEqual(A.heads('scope','doc'),B.heads('scope','doc'));});
run('stale resolution rejected and exact resolution converges',()=>{assert.throws(()=>A.resolve('scope','doc',body('resolved'),[]),/heads changed/);A.resolve('scope','doc',body('resolved'),A.heads('scope','doc').map(r=>r.id));B.importBundle(A.exportBundle('scope'));apply(B,'doc');assert.equal(B.heads('scope','doc').length,1);assert.match(B.heads('scope','doc')[0].body.content,/resolved/);});
run('third site forwarded origin trust required',()=>{C.revoke('scope',B.identity.siteId);assert.throws(()=>C.importBundle(A.exportBundle('scope')),/origin/);assert.equal(C.revisions('scope').length,0);C.trust('scope',B.identity.publicKey);C.importBundle(A.exportBundle('scope'));assert.deepEqual(C.heads('scope','doc'),A.heads('scope','doc'));});
run('out of order full bundles cannot regress heads',()=>{const old=A.exportBundle('scope');A.capture('scope','doc',body('newer'));C.importBundle(A.exportBundle('scope'));C.importBundle(old);assert.match(C.heads('scope','doc')[0].body.content,/newer/);});
run('delete versus edit preserved, tombstone never destroys records',()=>{B.importBundle(A.exportBundle('scope'));apply(B,'doc');A.capture('scope','doc',body('',{deleted:true}));B.capture('scope','doc',body('edit versus delete'));A.importBundle(B.exportBundle('scope'));assert.equal(A.heads('scope','doc').length,2);assert.ok(A.heads('scope','doc').some(r=>r.body.deleted));});
run('rename/move retains document identity',()=>{A.resolve('scope','doc',body('restored',{title:'Renamed',parentDocId:'parent'}),A.heads('scope','doc').map(r=>r.id));C.importBundle(A.exportBundle('scope'));assert.equal(C.heads('scope','doc')[0].body.title,'Renamed');assert.equal(C.heads('scope','doc')[0].body.parentDocId,'parent');});
run('content addressed attachments transfer and validate',()=>{const hash=A.putAsset(Buffer.from('synthetic attachment'));A.capture('scope','asset-doc',body('asset',{attachments:[hash]}));C.importBundle(A.exportBundle('scope'));assert.equal(C.getAsset(hash).toString(),'synthetic attachment');});
run('corrupt attachment rejects entire bundle',()=>{const b=JSON.parse(A.exportBundle('scope'));const hash=Object.keys(b.payload.assets)[0];b.payload.assets[hash]=Buffer.from('tampered').toString('base64');assert.throws(()=>B.importBundle(resign(A,b)),/Corrupt/);assert.equal(B.revisions('scope','asset-doc').length,0);});
run('missing attachment rejects atomically',()=>{const b=JSON.parse(A.exportBundle('scope'));b.payload.assets={};assert.throws(()=>B.importBundle(resign(A,b)),/Missing attachment/);assert.equal(B.revisions('scope','asset-doc').length,0);});
run('missing bytes cannot borrow an asset from another lineage on the same receiver',()=>{
 const receiver=new SiteExchange(new Database(':memory:'),SiteExchange.createIdentity()),sender=new SiteExchange(new Database(':memory:'),SiteExchange.createIdentity());dbs.push(receiver.db,sender.db);
 receiver.bindScope('private-space','private-lineage');receiver.bindScope('attacker-space','attacker-lineage');sender.bindScope('attacker-local','attacker-lineage');receiver.trust('attacker-lineage',sender.identity.publicKey);
 const hash=receiver.putAsset(Buffer.from('secret private lineage bytes'));receiver.capture('private-lineage','private-doc',body('private',{attachments:[hash]}));
 // Sender knows only the digest: forge no data, but validly sign its own revision and envelope.
 const raw={lineage:'attacker-lineage',docId:'exfiltration',author:sender.identity.siteId,parents:[],body:body(`octavo-asset:${hash}.txt`,{attachments:[hash]})};const id=exchangeHash(canonical(raw));const revision={...raw,id,signature:sign(null,Buffer.from(id),sender.identity.privateKey).toString('base64')};
 const payload={format:'octavo-exchange-v1',lineage:'attacker-lineage',sender:sender.identity.siteId,revisions:[revision],assets:{}};const bundle=resign(sender,{payload});
 assert.throws(()=>receiver.importBundle(bundle),/Missing attachment/);assert.equal(receiver.revisions('attacker-lineage').length,0);assert.equal(receiver.db.prepare('SELECT count(*) AS n FROM exchange_receipts').get().n,0);assert.equal(receiver.getAsset(hash).toString(),'secret private lineage bytes');
});
run('bundle tampering rejected',()=>{const b=JSON.parse(A.exportBundle('scope'));b.payload.revisions[0].body.title='bad';assert.throws(()=>B.importBundle(JSON.stringify(b)),/signature/);});
run('forged origin revision rejected even trusted forwarder signs bundle',()=>{const b=JSON.parse(A.exportBundle('scope'));b.payload.revisions[0].body.title='bad';assert.throws(()=>B.importBundle(resign(A,b)),/origin signature/);});
run('unknown parent signed by trusted author rejected',()=>{const b=JSON.parse(A.exportBundle('scope'));const r=b.payload.revisions.find(r=>r.author===A.identity.siteId);r.parents=['f'.repeat(64)];const raw={lineage:r.lineage,docId:r.docId,author:r.author,parents:r.parents,body:r.body};r.id=exchangeHash(canonical(raw));r.signature=sign(null,Buffer.from(r.id),A.identity.privateKey).toString('base64');assert.throws(()=>B.importBundle(resign(A,b)),/parent/);});
run('revoked sender rejected including previously seen bundle',()=>{const b=A.exportBundle('scope');C.revoke('scope',A.identity.siteId);assert.throws(()=>C.importBundle(b),/sending site/);C.trust('scope',A.identity.publicKey);});
run('ACL and publication metadata rejected',()=>{assert.throws(()=>A.capture('scope','no-acl',{...body('x'),published:true}),/body/);});
run('outer application failure rolls back revisions/assets/checkpoint',()=>{const before=B.revisions('scope').length;assert.throws(()=>B.db.transaction(()=>{B.importBundle(A.exportBundle('scope'));throw new Error('application failed');})(),/application failed/);assert.equal(B.revisions('scope').length,before);});
run('restart reconstructs heads and replay receipts',()=>{const id=C.identity;C.db.close();const db=new Database(path.join(root,'c.db'));dbs.push(db);const restarted=new SiteExchange(db,id);assert.deepEqual(restarted.heads('scope','doc'),A.heads('scope','doc'));assert.equal(restarted.importBundle(A.exportBundle('scope')).replayed,true);});
run('RSA trust rejected',()=>{const pair=generateKeyPairSync('rsa',{modulusLength:2048});assert.throws(()=>A.trust('scope',pair.publicKey.export({type:'spki',format:'pem'}).toString()),/Ed25519/);});
run('noncanonical signature rejected',()=>{const b=JSON.parse(A.exportBundle('scope'));b.signature+=' ';assert.throws(()=>B.importBundle(JSON.stringify(b)),/signature/);});
run('deep valid ancestry accepts newest-first ordering',()=>{const D=site('deep'),E=site('receiver');E.trust('scope',D.identity.publicKey);for(let i=0;i<1002;i++)D.capture('scope','deep-doc',body('v'+i));const b=JSON.parse(D.exportBundle('scope'));const byId=new Map(b.payload.revisions.map(r=>[r.id,r]));let r=D.heads('scope','deep-doc')[0];const reverse=[];while(r){reverse.push(r);r=byId.get(r.parents[0]);}b.payload.revisions=reverse;assert.equal(E.importBundle(resign(D,b)).inserted,1002);assert.equal(E.heads('scope','deep-doc').length,1);});
// Efficient authenticated root fixtures: each record is independently valid and
// deliberately concurrent. This avoids making large-fixture setup quadratic.
const seedRoots=(engine,docId,n,prefix='branch',makeBody=i=>body(prefix+i))=>{
 const ids=[];const insert=engine.db.prepare('INSERT INTO exchange_revisions VALUES(?,?,?,?)');
 engine.db.transaction(()=>{for(let i=0;i<n;i++){const raw={lineage:'scope',docId:typeof docId==='function'?docId(i):docId,author:engine.identity.siteId,parents:[],body:makeBody(i)},id=exchangeHash(canonical(raw));const revision={...raw,id,signature:sign(null,Buffer.from(id),engine.identity.privateKey).toString('base64')};insert.run(id,'scope',raw.docId,canonical(revision));ids.push(id);}})();return ids;
};
for(const size of [101,250])run(`${size} concurrent heads resolve atomically into bounded signed ancestry and replay`,()=>{
 const source=site('large-'+size),peer=site('large-peer-'+size);peer.trust('scope',source.identity.publicKey);
 const initial=seedRoots(source,'crowded',size);const before=source.exportBundle('scope');peer.importBundle(before);
 const chosen=body('chosen complete body '+size),resolved=source.resolve('scope','crowded',chosen,initial.slice().reverse());
 const records=source.revisions('scope','crowded'),heads=source.heads('scope','crowded');assert.equal(heads.length,1);assert.equal(heads[0].id,resolved);assert.deepEqual(heads[0].body,chosen);assert.ok(records.every(r=>r.parents.length<=100));assert.equal(records.length,size+(size===101?2:3));
 const byId=new Map(records.map(r=>[r.id,r])),visited=new Set(),stack=[resolved];while(stack.length){const id=stack.pop();if(visited.has(id))continue;visited.add(id);stack.push(...byId.get(id).parents);}assert.ok(initial.every(id=>visited.has(id)));
 const bundle=source.exportBundle('scope');peer.importBundle(bundle);assert.deepEqual(peer.heads('scope','crowded'),heads);assert.equal(peer.importBundle(bundle).replayed,true);peer.importBundle(before);assert.deepEqual(peer.heads('scope','crowded'),heads);
 assert.throws(()=>source.resolve('scope','crowded',chosen,initial),/heads changed/);
});
run('large resolution rejects stale or duplicate head decision before mutation',()=>{
 const engine=site('large-stale'),heads=seedRoots(engine,'crowded',250);seedRoots(engine,'crowded',1,'new');const before=engine.exportBundle('scope');
 assert.throws(()=>engine.resolve('scope','crowded',body('choice'),heads),/heads changed/);assert.equal(engine.exportBundle('scope'),before);
 assert.throws(()=>engine.resolve('scope','crowded',body('choice'),[...heads,heads[0]]),/Invalid resolution heads/);assert.equal(engine.exportBundle('scope'),before);
});
run('failure during second merge rolls back every intermediate node and applied pointer',()=>{
 const engine=site('large-rollback'),heads=seedRoots(engine,'crowded',250);engine.setApplied('scope','crowded',heads[0]);const before=engine.exportBundle('scope');
 engine.db.exec("CREATE TRIGGER fail_second_merge BEFORE INSERT ON exchange_revisions WHEN NEW.doc='crowded' AND (SELECT count(*) FROM exchange_revisions WHERE doc='crowded')>=251 BEGIN SELECT RAISE(ABORT,'fixture merge failure');END;");
 assert.throws(()=>engine.resolve('scope','crowded',body('choice'),heads),/fixture merge failure/);assert.equal(engine.exportBundle('scope'),before);assert.equal(engine.applied('scope','crowded'),heads[0]);engine.db.exec('DROP TRIGGER fail_second_merge');
 engine.resolve('scope','crowded',body('choice'),heads);assert.equal(engine.heads('scope','crowded').length,1);
});
run('4950 heads converge at the exact 5000-revision transport boundary',()=>{
 const engine=site('large-success-bound'),heads=seedRoots(engine,'crowded',4950),selected=body('boundary choice');const result=engine.resolve('scope','crowded',selected,heads);const records=engine.revisions('scope','crowded');assert.equal(records.length,5000);assert.equal(engine.heads('scope','crowded')[0].id,result);assert.equal(engine.heads('scope','crowded').length,1);assert.ok(records.every(r=>r.parents.length<=100));assert.equal(JSON.parse(engine.exportBundle('scope')).payload.revisions.length,5000);
});
run('resolution revision-count overflow is an atomic hold instead of unexportable merge',()=>{
 const engine=site('large-count-bound'),heads=seedRoots(engine,'crowded',101);seedRoots(engine,i=>'other-'+i,4898);const before=engine.exportBundle('scope');
 assert.throws(()=>engine.resolve('scope','crowded',body('choice'),heads),/Revision export exceeds limit/);assert.equal(engine.revisions('scope').length,4999);assert.equal(engine.exportBundle('scope'),before);assert.equal(engine.applied('scope','crowded'),null);
});
run('resolution bundle-byte overflow rolls back signed intermediate history',()=>{
 const engine=site('large-byte-bound'),heads=seedRoots(engine,'crowded',250);seedRoots(engine,i=>'large-other-'+i,31,'large',()=>body('x'.repeat(1024*1024-256)));const beforeHash=exchangeHash(engine.exportBundle('scope'));
 assert.throws(()=>engine.resolve('scope','crowded',body('y'.repeat(512*1024)),heads),/Bundle exceeds limit/);assert.equal(engine.revisions('scope').length,281);assert.equal(exchangeHash(engine.exportBundle('scope')),beforeHash);assert.equal(engine.applied('scope','crowded'),null);
});
console.log(`${count} exchange core cases passed`);
} finally {for(const db of dbs)if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});}
