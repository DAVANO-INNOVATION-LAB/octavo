import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import Module,{createRequire} from 'node:module';import ts from 'typescript';
const require=createRequire(import.meta.url),temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-notes-'));process.env.OCTAVO_DATA_DIR=temp;
const load=Module._load;Module._load=function(n,p,m){if(n==='server-only')return {};if(n==='next/headers')return {cookies:async()=>({}),headers:async()=>new Headers()};return load.call(this,n,p,m)};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compareVersions,unseenReleases,releaseHistory}=require('../src/lib/release-notes.ts'),{VERSION}=require('../src/lib/version.ts'),{getDb}=require('../src/lib/db.ts'),{releaseState,acknowledgeRelease}=require('../src/lib/release-state.ts');const db=getDb();
try{
for(const [a,b]of [['0.28.0-rc.2','0.28.0-rc.1'],['0.28.0-rc.10','0.28.0-rc.2'],['0.28.0','0.28.0-rc.9'],['0.29.0','0.28.9']]){assert.equal(compareVersions(a,b),1);assert.equal(compareVersions(b,a),-1);assert.equal(compareVersions(a,a),0);}
assert.throws(()=>compareVersions('oops','0.28.0'));assert.equal(unseenReleases(null).length,2);assert.equal(unseenReleases('0.27.27').length,2);assert.equal(unseenReleases('0.28.0-rc.1').length,1);assert.equal(unseenReleases(VERSION).length,0);assert.equal(unseenReleases('0.29.0').length,0);assert.equal(releaseHistory('0.28.0-rc.1').length,1);
for(const id of ['a','b'])db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,id+'@example.test',id,'!','reader',Date.now());
assert.equal(releaseState('a').unread.length,2);acknowledgeRelease('a');acknowledgeRelease('a');assert.equal(releaseState('a').unread.length,0);assert.equal(releaseState('b').unread.length,2);
db.prepare('UPDATE kv SET value=? WHERE key=?').run('0.29.0','release-seen:a');acknowledgeRelease('a');assert.equal(releaseState('a').previousVersion,'0.29.0');assert.ok(releaseHistory().some(n=>n.version===VERSION));require('../src/lib/auth.ts').deleteUser('a');assert.equal(db.prepare('SELECT value FROM kv WHERE key=?').get('release-seen:a'),undefined);
console.log('PASS 10 release-note version, skipped upgrade, account isolation, idempotence, downgrade and deletion groups');
}finally{db.close();fs.rmSync(temp,{recursive:true,force:true});}
