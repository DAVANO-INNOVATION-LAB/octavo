// Local-only, read-only HTTP stress test. Use an isolated fixture database.
// node scripts/quality-load-test.mjs http://127.0.0.1:8546 /tmp/fixture/octavo.db /tmp/results.json
import Database from 'better-sqlite3';
import {writeFileSync} from 'node:fs';
const [base,dbPath,output]=process.argv.slice(2);
if(!base||!dbPath||!output)throw new Error('Supply local URL, fixture database and output JSON path');
const url=new URL(base);
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Local targets only');
const db=new Database(dbPath,{readonly:true});
const session=db.prepare('SELECT id FROM sessions WHERE expires_at>? ORDER BY expires_at DESC LIMIT 1').get(Date.now());
if(!session)throw new Error('Sign into the isolated fixture first');
const page=db.prepare('SELECT s.slug space,p.slug page FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.published=1 ORDER BY length(p.title),p.id LIMIT 1').get();
const count=db.prepare('SELECT count(*) n FROM pages').get().n;db.close();
const paths=['/quality','/search?q=recovery','/api/search?q=recovery',`/${page.space}/${page.page}`];
const results=[];
for(const concurrency of [1,10,30]){
 const samples=[],statuses={},start=performance.now(),stop=start+12000;let sequence=0,errors=0;
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(performance.now()<stop){const route=paths[sequence++%paths.length],t=performance.now();
   try{const response=await fetch(new URL(route,url),{headers:{cookie:`octavo_session=${session.id}`},redirect:'manual',signal:AbortSignal.timeout(20000)});await response.arrayBuffer();statuses[response.status]=(statuses[response.status]||0)+1;if(response.status!==200)errors++;samples.push(performance.now()-t);}
   catch{errors++;}
  }
 }));
 samples.sort((a,b)=>a-b);const percentile=p=>samples.length?Math.round(samples[Math.min(samples.length-1,Math.floor(samples.length*p))]*10)/10:null;
 const result={concurrency,requests:samples.length,errors,statuses,rps:Math.round(samples.length/((performance.now()-start)/1000)*10)/10,p50_ms:percentile(.5),p95_ms:percentile(.95),p99_ms:percentile(.99)};
 results.push(result);console.log(result);
}
writeFileSync(output,JSON.stringify({at:new Date().toISOString(),pages:count,paths,results},null,2));
if(results.some(r=>r.errors))process.exitCode=1;
