import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const adapter=await import(new URL('../src/lib/jobs.ts',import.meta.url));
let calls=0, state='RUNNING';
const server=createServer(async(req,res)=>{
 calls++;const chunks=[];for await(const c of req)chunks.push(c);
 assert.equal(req.headers.authorization,'Bearer test-token');
 let value={};
 if(req.method==='POST'&&!req.url.endsWith('/stop')){const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.submission_id,'octavo-fixture');value=req.url==='/jobs'?{id:'octavo-fixture'}:{submission_id:'octavo-fixture'};}
 else if(req.url.endsWith('/stop')){state='STOPPED';value={stopped:true};}
 else if(req.url.endsWith('/logs'))value={logs:'result=42'};
 else value={status:state,output:'logs'};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
});
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 for(const type of ['ray','skypilot']){
 state='RUNNING';const spec=type==='ray'?{entrypoint:'python main.py'}:{task:{run:'echo done'}};
 const submitted=await adapter.submitJob(type,base,'test-token',JSON.stringify(spec),'fixture');assert.equal(submitted.status,'running');
 assert.equal((await adapter.inspectJob(type,base,'test-token',submitted.remoteId)).status,'running');
 state='SUCCEEDED';assert.equal((await adapter.inspectJob(type,base,'test-token',submitted.remoteId)).status,'succeeded');
 state='FAILED';assert.equal((await adapter.inspectJob(type,base,'test-token',submitted.remoteId)).status,'failed');
 assert.equal((await adapter.inspectJob(type,base,'test-token',submitted.remoteId,true)).status,'cancelled');
 }
 for(const spec of ['null','[]','{}','{"entrypoint":"x","entrypoint_num_gpus":-1}','{"entrypoint":"x","submission_id":"overwrite"}'])assert.throws(()=>adapter.jobSpec(spec,'ray','id'));
 console.log(`PASS job adapters: Ray/SkyPilot submit, running, success, failure, cancellation, logs, Bearer auth; invalid manifests rejected (${calls} mock requests).`);
}finally{server.close();}
if(process.env.OCTAVO_RAY_TEST_URL){
 const base=process.env.OCTAVO_RAY_TEST_URL;
 for(const [label,entrypoint,wanted] of [['success',"python3 -c 'print(6 * 7)'",'succeeded'],['failure',"python3 -c 'raise SystemExit(2)'",'failed'],['cancel',"python3 -c 'import time; time.sleep(120)'",'cancelled']]){
 const job=await adapter.submitJob('ray',base,'',JSON.stringify({entrypoint}),'test-'+label+'-'+Date.now());
 let result;for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,1000));result=await adapter.inspectJob('ray',base,'',job.remoteId,label==='cancel'&&i===0);if(result.status!=='running')break;}
 assert.equal(result.status,wanted,JSON.stringify(result));if(label==='success')assert.ok(result.output.includes('42'));console.log(`PASS live Ray ${label}: ${result.status}`);
 }
}
