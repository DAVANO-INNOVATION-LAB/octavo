// Actual SCIM routes + SQLite + local/session auth; no provider or production data.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import Module,{createRequire} from 'node:module';import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-lifecycle-'));
process.env.OCTAVO_DATA_DIR=temp;
const original=Module._load,ext=Module._extensions['.ts'];
let cookie, cookieOptions;
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='next/headers')return {cookies:async()=>({get:()=>cookie?{value:cookie}:undefined,set:(key,value,options)=>{cookie=value;cookieOptions=options}}),headers:async()=>new Map()};
 if(name==='./audit-forward')return {forwardAudit:()=>{}};
 if(name.startsWith('@/'))name=path.join(root,name.slice(2));
 return original.call(this,name,parent,main);
};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
let n=0;const check=async(name,fn)=>{await fn();n++;console.log('PASS',name)};
try{
 const db=require(path.join(root,'lib/db.ts')).getDb(),auth=require(path.join(root,'lib/auth.ts')),scim=require(path.join(root,'lib/scim.ts'));
 const claims=require(path.join(root,'lib/oidc-claims.ts'));
 const routes=require(path.join(root,'app/api/scim/v2/Users/[id]/route.ts'));
 const user=auth.createUser('synthetic@example.test','Synthetic','synthetic-password','member');
 const token=scim.issueScimToken();const context={params:Promise.resolve({id:user})};
 const request=(body,authorized=true)=>new Request('http://localhost/api/scim/v2/Users/'+user,{method:'PATCH',headers:{'content-type':'application/scim+json',authorization:'Bearer '+(authorized?token:'wrong')},body:JSON.stringify(body)});
 const active=value=>({Operations:[{op:'replace',path:'active',value}]});
 await check('TTL opt-in validates bounded values and preserves unset default',async()=>{assert.equal(claims.claimOptions({}).sessionTtlSeconds,undefined);assert.equal(claims.claimOptions({OCTAVO_OIDC_SESSION_TTL_SECONDS:'60'}).sessionTtlSeconds,60);for(const value of ['0','59','86401','1.5','NaN','-1'])assert.throws(()=>claims.claimOptions({OCTAVO_OIDC_SESSION_TTL_SECONDS:value}))});
 await check('short OIDC session caps DB and cookie, does not extend policy',async()=>{const before=Date.now();await auth.createSession(user,60);const row=db.prepare('SELECT expires_at FROM sessions WHERE id=?').get(cookie);assert(row.expires_at>=before+60000&&row.expires_at<=Date.now()+60000);assert.equal(cookieOptions.maxAge,60);assert(await auth.currentUser());await auth.createSession(user);assert(cookieOptions.maxAge>60)});
 await check('unauthorized deprovision has no effect',async()=>{const before=db.prepare('SELECT count(*) n FROM sessions').get().n;assert.equal((await routes.PATCH(request(active(false),false),context)).status,401);assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n,before);assert(await auth.currentUser())});
 await check('PATCH deprovision clears every session and denies local and SSO login',async()=>{const oldCookie=cookie;assert.equal((await routes.PATCH(request(active(false)),context)).status,200);assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(user).n,0);cookie=oldCookie;assert.equal(await auth.currentUser(),null);assert.equal(auth.authenticate('synthetic@example.test','synthetic-password').ok,false);await assert.rejects(auth.createSession(user,60));assert.throws(()=>auth.upsertOidcUser({issuer:'https://id.example.test',sub:'a',email:'synthetic@example.test',name:'Synthetic'}))});
 await check('reactivation never resurrects old sessions',async()=>{await routes.PATCH(request(active(true)),context);assert.equal(await auth.currentUser(),null);assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(user).n,0);assert.equal(auth.authenticate('synthetic@example.test','synthetic-password').ok,true);await auth.createSession(user,60);assert(await auth.currentUser())});
 await check('deprovision storage failure rolls back account state and session deletion',async()=>{db.exec("CREATE TRIGGER fail_revoke BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");const before=db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(user).n;assert.throws(()=>scim.scimPatch(user,active(false).Operations));assert.equal(scim.isDeactivated(user),false);assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(user).n,before);db.exec('DROP TRIGGER fail_revoke')});
 await check('PUT deprovision and profile changes are atomic',async()=>{db.exec("CREATE TRIGGER fail_revoke BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");assert.throws(()=>scim.scimReplace(user,{active:false,displayName:'Changed'}));assert.equal(scim.scimGet(user).displayName,'Synthetic');assert.equal(scim.isDeactivated(user),false);db.exec('DROP TRIGGER fail_revoke');assert.equal((await routes.PUT(request({active:false}),context)).status,200);assert.equal(await auth.currentUser(),null)});
 await check('expired session denies and removes persisted session',async()=>{scim.scimPatch(user,active(true).Operations);await auth.createSession(user,60);db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now()-1,cookie);assert.equal(await auth.currentUser(),null);assert.equal(db.prepare('SELECT id FROM sessions WHERE id=?').get(cookie),undefined)});
 console.log(`${n} lifecycle groups passed`);
}finally{globalThis.__octavoDb?.close();delete globalThis.__octavoDb;Module._load=original;Module._extensions['.ts']=ext;fs.rmSync(temp,{recursive:true,force:true})}
