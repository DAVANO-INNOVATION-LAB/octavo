// Functional import-history pagination against isolated SQLite and known synthetic membership fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-import-history-'));
const originalData=process.env.OCTAVO_DATA_DIR;process.env.OCTAVO_DATA_DIR=temporary;
const oldLoad=Module._load,oldTs=Module._extensions['.ts'];
let db,checks=0;
Module._load=function(name,parent,main){if(name==='server-only')return {};if(name==='next/headers')return {cookies:async()=>({get:()=>undefined})};if(name.startsWith('@/'))name=path.join(root,name.slice(2));return oldLoad.call(this,name,parent,main);};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const load=name=>require(path.join(root,name));
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
try{
 db=load('lib/db.ts').getDb();
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),groups=load('lib/groups.ts'),tenants=load('lib/tenants.ts');
 const {createImportReport,listImportReports}=load('lib/import-reports.ts');
 const users={};for(const id of ['owner','other','empty','admin','agent']){const role=id==='admin'?'admin':id==='agent'?'agent':'member';users[id]={id,name:id,email:id+'@example.test',role};db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,users[id].email,id,'!',role,1);}
 const group=groups.createGroup('Synthetic import administrators');groups.addGroupMember(group.id,'owner');
 const tenant=tenants.createTenant('Synthetic import tenant');tenants.addMember(tenant.id,'other');
 check(listImportReports(users.owner),{items:[],offset:0,limit:20,hasMore:false},'no report empty state');
 const noReport=data.createSpace({name:'Created normally without a report'});roles.setSpaceMember(noReport.id,'owner','admin');
 const fixtures=[];
 for(let i=0;i<125;i++){
  const space=data.createSpace({name:'History '+i,visibility:i%2===0?'private':'public'});
  const page=data.createPage({spaceId:space.id,title:'Imported page '+i,published:true});
  const report=db.transaction(()=>createImportReport({spaceId:space.id,actorId:'owner',sourceKind:'upload',sourceLabel:'history-'+i+'.md',preview:{pages:1,attachmentEntries:0,...(i%2===0?{assetPlan:{files:0,bytes:0}}:{})}}))();
  // Fixed clocks deliberately create timestamp ties across pagination boundaries.
  report.id='receipt'+String(i).padStart(3,'0');report.completedAt=1000+Math.floor(i/3);
  db.prepare('UPDATE import_reports SET id=?,completed_at=?,report_json=? WHERE space_id=?').run(report.id,report.completedAt,JSON.stringify({...report,actorId:null}),space.id);
  const kind=i%5;let accessible=kind===0||kind===4;
  if(kind===0)roles.setSpaceMember(space.id,'owner','admin');
  if(kind===1)roles.setSpaceMember(space.id,'other','admin');
  if(kind===2)roles.setSpaceMember(space.id,'owner','reader');
  if(kind===3){roles.setSpaceMember(space.id,'owner','admin');tenants.setSpaceTenant(space.id,tenant.id);}
  if(kind===4)groups.setGroupGrant(group.id,space.id,'admin');
  if(i===10||i===54){data.deleteSpace(space.id,'owner');accessible=false;}
  fixtures.push({space,page,report,accessible,deleted:i===10||i===54});
 }
 const sorted=items=>[...items].sort((a,b)=>b.report.completedAt-a.report.completedAt||b.report.id.localeCompare(a.report.id));
 const expected=()=>sorted(fixtures.filter(f=>f.accessible));
 const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
 const read=(user,options)=>{const before=snapshot();const result=listImportReports(user,options);check(snapshot(),before,'listing is read-only');check(Object.keys(result).sort(),['hasMore','items','limit','offset'],'no unrelated totals added');return result;};
 const assertPage=(user,items,offset=0,limit=20)=>{const result=read(user,{offset,limit});check(result.offset,offset);check(result.limit,limit);check(result.items.map(item=>item.report.id),items.slice(offset,offset+limit).map(f=>f.report.id),'offset applies to visible reports');check(result.hasMore,items.length>offset+limit,'hasMore counts only visible rows');return result;};
 const first=assertPage(users.owner,expected());
 check(first.items.length,20);check(first.items.every(item=>item.report.actorId==='owner'),true);
 const second=assertPage(users.owner,expected(),20),last=assertPage(users.owner,expected(),40);
 check(new Set([...first.items,...second.items,...last.items].map(item=>item.report.id)).size,expected().length,'all pages traverse ties exactly once');
 assertPage(users.owner,expected(),expected().length);assertPage(users.owner,expected(),expected().length+20);
 assertPage(users.owner,expected(),expected().length-20);assertPage(users.owner,expected(),expected().length-21);
 assertPage(users.owner,expected(),0,1);assertPage(users.owner,expected(),0,50);
 check(read(users.owner).items,first.items,'default page matches explicit20');check(read(users.owner).items,first.items,'tie order is stable across repeated reads');
 check(read(null),{items:[],offset:0,limit:20,hasMore:false});check(read(users.empty).items,[]);check(read(users.empty).hasMore,false);
 const all=sorted(fixtures.filter(f=>!f.deleted));assertPage(users.admin,all);assertPage(users.admin,all,100);
 check(read(users.agent).items,[],'ordinary agent fixture has no admin histories');
 // Metadata is live, counts are the immutable saved receipt, and old optional fields stay absent.
 const selected=expected()[0],counts=structuredClone(selected.report.counts);
 data.updateSpace(selected.space.id,{name:'Renamed current space'});db.prepare('UPDATE spaces SET slug=? WHERE id=?').run('renamed-current-space',selected.space.id);
 data.savePage(selected.page.id,{title:'Edited after import',published:false});data.createPage({spaceId:selected.space.id,title:'Later extra page',published:true});
 const renamed=read(users.owner).items.find(item=>item.space.id===selected.space.id);assert.ok(renamed);checks++;
 check(renamed.space,{id:selected.space.id,slug:'renamed-current-space',name:'Renamed current space'});check(renamed.report.counts,counts,'later content changes do not refresh historical counts');
 const legacy=expected().find(f=>f.report.preview&&!Object.hasOwn(f.report.preview,'assetPlan'));
 const legacyItem=read(users.owner,{offset:0,limit:50}).items.find(item=>item.space.id===legacy.space.id);check(Object.hasOwn(legacyItem.report.preview,'assetPlan'),false,'old receipt is not inferred as zero plan');
 // Membership changes affect subsequent list calls, not saved authorship.
 const direct=fixtures.find(f=>f.accessible&&Number(f.report.id.slice(7))%5===0);roles.removeSpaceMember(direct.space.id,'owner');direct.accessible=false;assertPage(users.owner,expected());
 const retained=fixtures.find(f=>Number(f.report.id.slice(7))%5===3);tenants.addMember(tenant.id,'owner');for(const fixture of fixtures)if(Number(fixture.report.id.slice(7))%5===3&&!fixture.deleted)fixture.accessible=true;assertPage(users.owner,expected());tenants.removeMember(tenant.id,'owner');for(const fixture of fixtures)if(Number(fixture.report.id.slice(7))%5===3)fixture.accessible=false;assertPage(users.owner,expected());
 check(read(users.owner,{limit:50}).items.some(item=>item.space.id===retained.space.id),false,'retained grant without tenant membership is unavailable');
 for(const options of [{offset:-1},{offset:NaN},{offset:1.5}])check(read(users.owner,options).offset,0);
 check(read(users.owner,{limit:100}).limit,50);check(read(users.owner,{limit:0}).limit,1);check(read(users.owner,{limit:NaN}).limit,20);
 const index=db.prepare("PRAGMA index_xinfo('import_reports_completed')").all().filter(row=>row.key===1);check(index.map(row=>[row.name,row.desc]),[['completed_at',1],['id',1]],'stable descending pagination index exists');
 const beforeReopen=snapshot();db.close();delete globalThis.__octavoDb;db=load('lib/db.ts').getDb();check(snapshot(),beforeReopen,'reopening leaves reports and index data unchanged');check(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='import_reports_completed'").get().n,1,'pagination index installed once');assertPage(users.owner,expected());
 console.log(`${checks} import history functional checks passed (isolated SQLite)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];
 if(originalData===undefined)delete process.env.OCTAVO_DATA_DIR;else process.env.OCTAVO_DATA_DIR=originalData;fs.rmSync(temporary,{recursive:true,force:true});
}
