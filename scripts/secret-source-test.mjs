import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSecretSource } from '../src/lib/secret-source.ts';
const dir=mkdtempSync(join(tmpdir(),'octavo-secret-'));
let checks=0;const check=(fn)=>{fn();checks++;};
try {
 const path=join(dir,'credential');
 check(()=>assert.equal(resolveSecretSource({}),null));
 check(()=>assert.equal(resolveSecretSource({storedValue:'db-fixture'}),'db-fixture'));
 check(()=>assert.equal(resolveSecretSource({envValue:'env-fixture',storedValue:'db-fixture'}),'env-fixture'));
 writeFileSync(path,'file-fixture\n');
 check(()=>assert.equal(resolveSecretSource({filePath:path,storedValue:'db-fixture'}),'file-fixture'));
 check(()=>assert.throws(()=>resolveSecretSource({filePath:path,envValue:'env-fixture'}),/either/));
 writeFileSync(join(dir,'replacement'),'rotated-fixture\r\n');renameSync(join(dir,'replacement'),path);
 check(()=>assert.equal(resolveSecretSource({filePath:path}),'rotated-fixture'));
 symlinkSync(path,join(dir,'projected'));
 check(()=>assert.equal(resolveSecretSource({filePath:join(dir,'projected')}),'rotated-fixture'));
 for(const value of ['', ' \n', 'x\0y', 'x'.repeat(65537),Buffer.from([0xff])]) {
  writeFileSync(path,value);check(()=>assert.throws(()=>resolveSecretSource({filePath:path,storedValue:'fallback-forbidden'}),/invalid/));
 }
 check(()=>assert.throws(()=>resolveSecretSource({filePath:dir}),/invalid/));
 check(()=>assert.throws(()=>resolveSecretSource({filePath:join(dir,'missing')}),e=>!e.message.includes(dir)&&e.message.includes('invalid')));
 writeFileSync(path,' x ');check(()=>assert.equal(resolveSecretSource({filePath:path}),' x '));
 writeFileSync(path,'x'.repeat(65536));check(()=>assert.equal(resolveSecretSource({filePath:path}).length,65536));
 console.log(`${checks} secret-source checks passed`);
} finally {rmSync(dir,{recursive:true,force:true});}
