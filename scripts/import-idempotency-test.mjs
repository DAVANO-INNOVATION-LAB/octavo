// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-idempotency-'));
process.env.OCTAVO_DATA_DIR=temporary;
const oldLoad=Module._load,oldTs=Module._extensions['.ts'],oldTsx=Module._extensions['.tsx'],oldFetch=globalThis.fetch,oldError=console.error;
let db,cookie,cacheFails=false,forwardFails=false,checks=0;
const errors=[];
class Redirect extends Error{constructor(location){super('redirect');this.location=location;}}
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='next/headers')return {cookies:async()=>({get:key=>key==='octavo_session'&&cookie?{value:cookie}:undefined}),headers:async()=>new Map()};
 if(name==='next/navigation')return {redirect:location=>{throw new Redirect(location);}};
 if(name==='@/lib/import-preview') {const actual=oldLoad.call(this,path.join(root,'lib/import-preview.ts'),parent,main);return {...actual,previewImport(...args){assert.equal(db.inTransaction,false,'preview runs outside write transaction');return actual.previewImport(...args);}};}
 if(name==='next/cache')return {revalidatePath:()=>{assert.equal(db.inTransaction,false);if(cacheFails)throw Error('synthetic cache failure');}};
 if(name==='@/lib/import-url')return {fetchGuarded:async()=>({body:'# URL report\n\nSynthetic report content',contentType:'text/markdown',finalUrl:'https://synthetic.invalid/report.md'})};
 if(name==='./audit-forward')return {forwardAudit:()=>{assert.equal(db.inTransaction,false);if(forwardFails)throw Error('synthetic forward failure');}};
 if(name.startsWith('@/components/'))return new Proxy({},{get:(_,key)=>key==='__esModule'?true:()=>null});
 if(name.startsWith('@/'))name=path.join(root,name.slice(2));
 return oldLoad.call(this,name,parent,main);
};
Module._extensions['.ts']=Module._extensions['.tsx']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
globalThis.fetch=()=>{throw Error('Unexpected outbound request');};console.error=(...args)=>errors.push(args);
const load=name=>require(path.join(root,name));
const check=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
try {
 const database=load('lib/db.ts');db=database.getDb();
 const data=load('lib/data.ts'),roles=load('lib/roles.ts');
 const retry=load('lib/import-idempotency.ts'),{runImportTransaction}=load('lib/import-transaction.ts');
 const upload=load('app/api/import/route.ts').POST,{NextRequest}=require('next/server');
 const users={};for(const id of ['owner','other']){
  users[id]={id,name:id,email:id+'@example.test',role:'member'};
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,users[id].email,id,'!','member',Date.now());
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);
 }
 cookie='session-owner';
 const body='# Retry\n\nSynthetic retry content',key='3f15fa14-69bb-4b93-9195-dfa4c91d4313';
 const submit=async({filename='retry.md',bytes=body,name='',requestKey=key,extraKey,origin,previewDigest}={})=>{const form=new FormData();form.set('file',new File([bytes],filename));form.set('name',name);if(requestKey!==null)form.set('idempotencyKey',requestKey);if(extraKey!==undefined)form.append('idempotencyKey',extraKey);if(previewDigest)form.set('previewDigest',previewDigest);const response=await upload(new NextRequest('http://localhost/api/import',{method:'POST',body:form,headers:origin?{origin,host:'localhost'}:{}}));check(response.status,303);return response.headers.get('location');};
 const snapshot=()=>JSON.stringify([db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]),fs.readdirSync(database.UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(database.UPLOADS_DIR,name)).toString('hex')])]);
 const location=await submit(),space=data.getSpaceBySlug(location.slice(1));assert.ok(space,location);
 const first=snapshot();check(await submit(),location+'?importReplayed=1');check(snapshot(),first,'replay changes no stored state');
 check(await submit({previewDigest:'outdated-on-retry'}),location+'?importReplayed=1','completed replay does not reconvert or re-preview');
 cacheFails=true;check(await submit(),location+'?importReplayed=1','cache failure cannot claim retry failed');cacheFails=false;
 for(const changes of [{bytes:body+'changed'},{filename:'different.md'},{name:'different name'}]){assert.match(decodeURIComponent(await submit(changes)),/different file or import options/);checks++;check(snapshot(),first);}
 for(const invalid of ['', 'short', 'x'.repeat(129), 'bad/key________________', new File(['x'],'key')]){assert.match(decodeURIComponent(await submit({requestKey:invalid})),/Invalid import retry key/);checks++;}
 assert.match(decodeURIComponent(await submit({extraKey:key})),/Invalid import retry key/);checks++;
 assert.match(await submit({origin:'https://evil.test'}),/origin-mismatch/);checks++;
 const noKeyA=await submit({requestKey:null}),noKeyB=await submit({requestKey:null});assert.notEqual(noKeyA,noKeyB);checks++;
 const newKey=await submit({requestKey:'separate-import-key-123'});assert.notEqual(newKey,location);checks++;
 cookie='session-other';const otherLocation=await submit();assert.notEqual(otherLocation,location);checks++;cookie='session-owner';
 check(db.prepare('SELECT COUNT(*) n FROM import_idempotency WHERE request_key=?').get(key).n,2,'keys are user scoped');
 const memberships=db.prepare('SELECT * FROM space_members WHERE space_id=? AND user_id=?').all(space.id,'owner');
 db.prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').run(space.id,'owner');
 assert.match(decodeURIComponent(await submit()),/previous import is no longer available/);checks++;
 for(const row of memberships)db.prepare('INSERT INTO space_members(space_id,user_id,role,added_at) VALUES(?,?,?,?)').run(row.space_id,row.user_id,row.role,row.added_at);
 db.prepare('UPDATE spaces SET slug=? WHERE id=?').run('renamed-retry-space',space.id);check(await submit(),'/renamed-retry-space?importReplayed=1');
 db.prepare('INSERT INTO deleted_spaces(space_id,deleted_at,deleted_by) VALUES(?,?,?)').run(space.id,Date.now(),'owner');assert.match(decodeURIComponent(await submit()),/previous import is no longer available/);checks++;
 db.prepare('DELETE FROM deleted_spaces WHERE space_id=?').run(space.id);
 db.prepare('DELETE FROM spaces WHERE id=?').run(space.id);check(db.prepare('SELECT space_id FROM import_idempotency WHERE user_id=? AND request_key=?').get('owner',key).space_id,null);assert.match(decodeURIComponent(await submit()),/previous import is no longer available/);checks++;
 // Mapping failure rolls back every newly imported page, receipt, and file.
 const notebook=JSON.stringify({cells:[{cell_type:'code',source:['print(1)'],outputs:[{data:{'image/png':Buffer.from('synthetic image').toString('base64')}}]}]});
 db.exec("CREATE TRIGGER synthetic_retry_failure BEFORE INSERT ON import_idempotency BEGIN SELECT RAISE(ABORT,'synthetic retry failure'); END");
 const before=snapshot();assert.match(decodeURIComponent(await submit({filename:'failure.ipynb',bytes:notebook,requestKey:'failed-retry-key-1234'})),/synthetic retry failure/);checks++;check(snapshot(),before);
 db.exec('DROP TRIGGER synthetic_retry_failure');const recovered=await submit({filename:'failure.ipynb',bytes:notebook,requestKey:'failed-retry-key-1234'});assert.ok(!recovered.includes('error'));checks++;
 check(await submit({filename:'failure.ipynb',bytes:notebook,requestKey:'failed-retry-key-1234'}),recovered+'?importReplayed=1');
 assert.notEqual(retry.importRequestFingerprint('ab',Buffer.from('c'),'d'),retry.importRequestFingerprint('a',Buffer.from('c'),'bd'));checks++;
 assert.throws(()=>retry.replayImport(users.owner,key,'x'),/transaction/);checks++;
 assert.throws(()=>retry.recordImport('owner',key,'x',space.id),/transaction/);checks++;
 db.prepare('DELETE FROM users WHERE id=?').run('other');check(db.prepare('SELECT COUNT(*) n FROM import_idempotency WHERE user_id=?').get('other').n,0);
 console.log(`PASS import idempotency: ${checks} checks`);
} finally {
 db?.close();Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
