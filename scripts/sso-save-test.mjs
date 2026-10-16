import Database from 'better-sqlite3';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes, createHash, createDecipheriv } from 'node:crypto';

// Run only against a disposable instance: this test changes its SSO configuration.
const [base, dataDir] = process.argv.slice(2);
assert.ok(base && dataDir?.includes('sso-regression'), 'Provide an isolated URL and sso-regression data directory');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
await fetch(base + '/login');
const db = new Database(dataDir + '/octavo.db');
const id = 'sso-test-' + randomBytes(8).toString('hex');
const token = randomBytes(24).toString('hex');
const now = Date.now();
assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0, 'Test instance must have no existing users');
const originalSettings=db.prepare("SELECT key,value FROM kv WHERE key LIKE 'setting:%'").all();
db.prepare("DELETE FROM kv WHERE key LIKE 'setting:%'").run();
db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,id+'@example.test','SSO regression','disabled','admin',now);
db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,id,now+3600000);
const headers = {cookie:'octavo_session='+token, origin:base};
const settings = () => db.prepare("SELECT key,value FROM kv WHERE key LIKE 'setting:%' ORDER BY key").all();
const get = key => db.prepare('SELECT value FROM kv WHERE key=?').get('setting:'+key)?.value;
const secret = () => {
 const [iv,tag,data]=get('oidc_client_secret').slice(4).split(':');
 const key=createHash('sha256').update(db.prepare("SELECT value FROM kv WHERE key='instance_secret'").get().value).digest();
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
 decipher.setAuthTag(Buffer.from(tag,'base64'));
 return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString();
};
async function save(fields, authenticated=true) {
 const html = await (await fetch(base+'/admin/sso',{headers})).text();
 const formHtml=[...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map(m=>m[0]).find(f=>f.includes('name="oidc_issuer"'));
 assert.ok(formHtml);
 const action=formHtml.match(/name="(\$ACTION_ID_[^"]+)"/)[1];
 const form=new FormData(); form.set(action,'');
 for (const [k,v] of Object.entries(fields)) form.set(k,v);
 return fetch(base+'/admin/sso',{method:'POST',body:form,headers:authenticated?headers:{origin:base},redirect:'manual'});
}
let discoveryFails=false;
const provider=createServer((req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(discoveryFails){res.writeHead(503);res.end('{}');return;}
 res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']}));
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const issuer='http://127.0.0.1:'+provider.address().port;
async function testDiscovery(){
 const html=await(await fetch(base+'/admin/sso',{headers})).text();
 const forms=[...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map(m=>m[0]);
 const formHtml=forms.find(f=>/Test (?:saved discovery settings|discovery against the issuer)/.test(f));
 assert.ok(formHtml);
 const body=new FormData();body.set(formHtml.match(/name="(\$ACTION_ID_[^"]+)"/)[1],'');
 return fetch(base+'/admin/sso',{method:'POST',body,headers,redirect:'manual'});
}
const button=async()=> (await (await fetch(base+'/login')).text()).replace(/<!--[\s\S]*?-->/g, '').includes('Continue with Test identity');
try {
 assert.equal(await button(),false);
 const fields={oidc_issuer:issuer,oidc_client_id:'fixture',base_url:base,oidc_name:'Test identity'};
 const before=settings();
 let response=await save(fields);
 assert.equal(response.status,303);assert.match(response.headers.get('location'),/error=/);
 assert.deepEqual(settings(),before);assert.equal(await button(),false);
 response=await save({...fields,oidc_client_secret:'fixture-only-secret'});
 assert.equal(response.status,303);assert.match(response.headers.get('location'),/saved=1/);
 assert.equal(await button(),true);assert.equal(secret(),'fixture-only-secret');
 assert.ok(get('oidc_client_secret').startsWith('enc:'));
 for(const value of ['', '********']) {
  await save({...fields,oidc_client_secret:value});
  assert.equal(secret(),'fixture-only-secret');assert.equal(await button(),true);
 }
 const discoveryBefore=settings();
 response=await testDiscovery();assert.match(response.headers.get('location'),/test=ok/);
 assert.deepEqual(settings(),discoveryBefore,'successful discovery preserves all settings');
 response=await fetch(base+'/api/auth/oidc/login',{redirect:'manual'});
 assert.equal(response.status,307);assert.ok(response.headers.get('location').startsWith(issuer+'/authorize?'));
 assert.ok(response.headers.get('set-cookie').includes('octavo_oidc='));
 discoveryFails=true;
 await save({...fields,oidc_client_secret:'failure-test-rotation'});
 const failedBefore=settings();response=await testDiscovery();
 assert.ok(!response.headers.get('location').endsWith('test=ok'));
 assert.deepEqual(settings(),failedBefore,'failed discovery preserves all settings');
 assert.equal(await button(),true);
 response=await fetch(base+'/api/auth/oidc/login',{redirect:'manual'});
 assert.equal(response.status,303);assert.equal(response.headers.get('location'),base+'/login?error=sso');
 discoveryFails=false;
 response=await testDiscovery();assert.match(response.headers.get('location'),/test=ok/);
 const valid=settings();
 response=await save({...fields,base_url:'not-a-url'});
 assert.match(response.headers.get('location'),/error=/);assert.deepEqual(settings(),valid);
 await save({...fields,oidc_client_secret:'rotated-fixture'});
 assert.equal(secret(),'rotated-fixture');assert.equal(await button(),true);
 const secured=settings(); await save({...fields,oidc_client_secret:'unauthorized'},false);
 assert.deepEqual(settings(),secured);
 const html=await(await fetch(base+'/admin/sso',{headers})).text();
 assert.ok(html.includes('SSO sign-in is available'));assert.ok(!html.includes('rotated-fixture'));
 await save({...fields,oidc_issuer:''});assert.equal(await button(),false);
 console.log('PASS: missing configuration rejected, save enables anonymous login button, encrypted secret retained on blank/masked saves, rotation, invalid URLs rejected atomically, anonymous writes denied, secret absent from HTML, explicit disable, successful/failed discovery never alters settings, provider redirect and failure recovery.');
} finally {
 await new Promise(resolve=>provider.close(resolve));
 db.prepare("DELETE FROM kv WHERE key LIKE 'setting:%'").run();
 for(const row of originalSettings) db.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run(row.key,row.value);
 db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);db.prepare('DELETE FROM users WHERE id=?').run(id);db.close(); }
