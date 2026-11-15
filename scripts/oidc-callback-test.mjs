// Real callback/account/group/tenant persistence with OIDC network and cookie boundaries mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import Module,{createRequire} from 'node:module';import ts from 'typescript';
const req=createRequire(import.meta.url),root=path.resolve('src'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-oidc-cb-'));
process.env.OCTAVO_DATA_DIR=temp;
const original=Module._load,ext=Module._extensions['.ts'];
let claims, info, sessions=0, badGrant=false, badGroup=false, realAuth, realGroups;
const settings={issuer:'https://id.example.test',clientId:'octavo',clientSecret:'synthetic',baseUrl:'http://localhost:18000',allowedDomain:null,adminDomain:null,defaultRole:'member',groupsClaim:'groups',rolesClaim:'realm_access.roles',roleMap:{'octavo-admin':'admin'},userInfo:false};
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='next/headers')return {cookies:async()=>({}),headers:async()=>new Map()};
 if(name==='@/lib/oidc')return {oidcSettings:()=>settings,discover:async()=>({}),oidc:{authorizationCodeGrant:async(config,url,checks)=>{assert.equal(checks.expectedState,'state');assert.equal(checks.pkceCodeVerifier,'verifier');assert.equal(checks.maxAge,settings.sessionTtlSeconds);if(badGrant)throw new Error('invalid grant');return {claims:()=>claims,access_token:'synthetic'}},fetchUserInfo:async()=>info}};
 if(name==='@/lib/auth')return {...realAuth,createSession:async()=>{sessions++}};
 if(name==='@/lib/groups')return {...realGroups,syncClaimGroups:(...args)=>{if(badGroup)throw new Error('injected group failure');return realGroups.syncClaimGroups(...args)}};
 if(name.startsWith('@/'))name=path.join(root,name.slice(2));
 return original.call(this,name,parent,main);
};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
let n=0;const check=async(name,fn)=>{await fn();n++;console.log('PASS',name)};
try{
 const db=req(path.join(root,'lib/db.ts')).getDb();realAuth=req(path.join(root,'lib/auth.ts'));realGroups=req(path.join(root,'lib/groups.ts'));
 realAuth.createUser('operator@example.test','Operator','synthetic-password','admin');
 const callback=req(path.join(root,'app/api/auth/oidc/callback/route.ts')).GET;
 const request={cookies:{get:()=>({value:JSON.stringify({state:'state',verifier:'verifier'})})},nextUrl:{pathname:'/api/auth/oidc/callback',search:'?code=synthetic&state=state'}};
 const login=async c=>{claims=c;return callback(request)};
 const valid={sub:'alice',email:'alice@example.test',email_verified:true,groups:['engineering'],realm_access:{roles:['octavo-admin']}};
 await check('mapped account success and role removal',async()=>{assert.equal((await login(valid)).headers.get('location'),'http://localhost:18000/');assert.equal(realAuth.findUserByEmail(valid.email).role,'admin');await login({...valid,realm_access:{roles:[]}});assert.equal(realAuth.findUserByEmail(valid.email).role,'member')});
 await check('configured reauth age reaches verified grant checks',async()=>{settings.sessionTtlSeconds=60;await login(valid);delete settings.sessionTtlSeconds});
 await check('unverified token email rejects before provisioning',async()=>{const before=sessions;await login({...valid,sub:'unverified',email:'unverified@example.test',email_verified:false});assert.equal(sessions,before);assert.equal(realAuth.findUserByEmail('unverified@example.test'),null)});
 await check('subject-bound UserInfo provisions missing profile',async()=>{settings.userInfo=true;info={sub:'userinfo',email:'userinfo@example.test',email_verified:true,groups:['engineering']};assert.equal((await login({sub:'userinfo'})).headers.get('location'),'http://localhost:18000/');assert(realAuth.findUserByEmail(info.email))});
 await check('mixed-source email verification cannot link an existing account',async()=>{const before=sessions;info={sub:'mixed',email:'different@example.test',email_verified:true};await login({sub:'mixed',email:'operator@example.test'});assert.equal(sessions,before);assert.equal(db.prepare('SELECT oidc_issuer FROM users WHERE email=?').get('operator@example.test').oidc_issuer,null)});
 await check('UserInfo subject mismatch rejects',async()=>{const before=sessions;info={sub:'different',email:'evil@example.test',email_verified:true};await login({sub:'wrong'});assert.equal(sessions,before);assert.equal(realAuth.findUserByEmail('evil@example.test'),null);settings.userInfo=false});
 await check('malformed mapped claim rejects atomically',async()=>{const before=sessions;await login({...valid,sub:'malformed',email:'malformed@example.test',groups:[{}]});assert.equal(sessions,before);assert.equal(realAuth.findUserByEmail('malformed@example.test'),null)});
 await check('account and claims rollback on storage failure',async()=>{badGroup=true;const before=sessions;await login({...valid,sub:'rollback',email:'rollback@example.test'});assert.equal(sessions,before);assert.equal(realAuth.findUserByEmail('rollback@example.test'),null);badGroup=false});
 await check('invalid grant no mutation/session',async()=>{badGrant=true;const before=sessions;await login({...valid,sub:'grant',email:'grant@example.test'});assert.equal(sessions,before);assert.equal(realAuth.findUserByEmail('grant@example.test'),null);badGrant=false});
 await check('deactivated identity remains denied',async()=>{db.prepare('UPDATE users SET active=0 WHERE email=?').run(valid.email);const before=sessions;await login(valid);assert.equal(sessions,before)});
 console.log(`${n} callback trust/persistence groups passed`);
} finally{globalThis.__octavoDb?.close();delete globalThis.__octavoDb;Module._load=original;Module._extensions['.ts']=ext;fs.rmSync(temp,{recursive:true,force:true})}
