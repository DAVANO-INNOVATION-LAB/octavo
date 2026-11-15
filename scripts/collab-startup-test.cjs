/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS startup contract test. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {collaborationEnabled,attachCollab}=require('../server/collab.cjs');
let checks=0;
const check=(name,value)=>{assert.ok(value,name);console.log('ok '+(++checks)+': '+name);};
for(const flag of [undefined,'','1','experimental'])check('enabled flag '+String(flag),collaborationEnabled({OCTAVO_COLLAB_PERSISTENCE:flag}));
for(const env of [{OCTAVO_COLLAB:'0'},{OCTAVO_COLLAB_PERSISTENCE:'0'},{OCTAVO_COLLAB:'0',OCTAVO_COLLAB_PERSISTENCE:'experimental'}])check('disable config '+JSON.stringify(env),!collaborationEnabled(env));
for(const value of ['false','true','legacy','experimental ']){
 assert.throws(()=>collaborationEnabled({OCTAVO_COLLAB_PERSISTENCE:value}),/Invalid OCTAVO_COLLAB_PERSISTENCE/);
 assert.throws(()=>collaborationEnabled({OCTAVO_COLLAB:'0',OCTAVO_COLLAB_PERSISTENCE:value}),/Invalid OCTAVO_COLLAB_PERSISTENCE/);
}
check('invalid values fail even when collaboration separately disabled',true);
const source=fs.readFileSync(path.resolve('server/octavo-server.cjs'),'utf8');
function startup(env,options={}) {
 const state={env:{...env,OCTAVO_COLLAB_INTERNAL_SECRET:'untrusted-injected-secret'},loaded:false,scheduled:false};
 const http={createServer:()=>({})};
 vm.runInNewContext(source,{
  process:{env:state.env},__dirname:path.resolve('server'),console,
  setTimeout:callback=>{state.scheduled=true;state.callback=callback;},
  require:name=>{
   if(name==='node:http')return http;
   if(name==='./collab.cjs')return {attachCollab:()=>{if(options.error)throw Error(options.error);return options.attached??true;}};
   if(name==='./collab-config.cjs')return {collaborationEnabled:()=>collaborationEnabled(state.env)};
   if(name==='node:path'||name==='node:crypto')return require(name);
   if(name===path.resolve('server.js')){if(options.capture)http.createServer();state.loaded=true;state.secretAtLoad=state.env.OCTAVO_COLLAB_INTERNAL_SECRET;return {};}
   throw Error('unexpected require '+name);
  },
 });
 return state;
}
const first=startup({}),second=startup({});
check('default startup replaces external secret before Next loads',first.loaded&&/^[a-f0-9]{64}$/.test(first.secretAtLoad)&&first.scheduled);
check('startup secret is fresh per process',first.secretAtLoad!==second.secretAtLoad);
assert.throws(()=>first.callback(),/HTTP listener was not captured/);
check('missing listener fails startup rather than advertising broken collaboration',true);
assert.throws(()=>startup({},{capture:true,attached:false}).callback(),/coordinator did not attach/);
check('failed coordinator attachment fails startup',true);
assert.throws(()=>startup({},{capture:true,error:'fixture database failure'}).callback(),/fixture database failure/);
check('attachment exception escapes startup instead of log-and-continue',true);
startup({},{capture:true}).callback();
check('successful attachment completes startup',true);

for(const env of [{OCTAVO_COLLAB:'0'},{OCTAVO_COLLAB_PERSISTENCE:'0'}]){
 const result=startup(env);
 check('disabled startup deletes secret and does not schedule socket attachment',result.loaded&&!result.secretAtLoad&&!result.scheduled);
}
assert.throws(()=>startup({OCTAVO_COLLAB_PERSISTENCE:'legacy'}),/Invalid OCTAVO_COLLAB_PERSISTENCE/);
check('startup rejects invalid persistence configuration',true);
const saved={...process.env};
try {
 for(const key of ['OCTAVO_COLLAB','OCTAVO_COLLAB_PERSISTENCE','OCTAVO_COLLAB_INTERNAL_SECRET'])delete process.env[key];
 assert.throws(()=>attachCollab({on(){}},{port:1}),/Missing internal/);
 check('default attachment cannot fall back without process secret',true);
 for(const key of ['OCTAVO_COLLAB','OCTAVO_COLLAB_PERSISTENCE']){
  process.env[key]='0';
  check('disabled attachment never accesses server or database',attachCollab(null,{port:1})===false);
  delete process.env[key];
 }
}finally{
 for(const key of ['OCTAVO_COLLAB','OCTAVO_COLLAB_PERSISTENCE','OCTAVO_COLLAB_INTERNAL_SECRET']){
  if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
 }
}
console.log(checks+' startup config checks passed');
