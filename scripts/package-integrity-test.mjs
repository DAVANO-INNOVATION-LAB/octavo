// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-package-integrity-'));
process.env.OCTAVO_DATA_DIR=temporary;
const oldLoad=Module._load,oldTs=Module._extensions['.ts'],oldTsx=Module._extensions['.tsx'],oldFetch=globalThis.fetch,oldError=console.error;
let db,cookie,cacheFails=false,forwardFails=false,checks=0;
const errors=[];
class Redirect extends Error{constructor(location){super('redirect');this.location=location;}}
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='next/headers')return {cookies:async()=>({get:key=>key==='octavo_session'&&cookie?{value:cookie}:undefined}),headers:async()=>new Map()};
 if(name==='next/navigation')return {redirect:location=>{throw new Redirect(location);}};
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
 const data=load('lib/data.ts'),{zip,unzip}=load('lib/zip.ts'),{exportSpaceZip,importUpload}=load('lib/transfer.ts'),{previewImport}=load('lib/import-preview.ts');
 const {addPackageIntegrity,verifyPackageIntegrity}=load('lib/package-integrity.ts');
 const space=data.createSpace({name:'Integrity fixture',visibility:'private'});data.createPage({spaceId:space.id,title:'Synthetic page',content:JSON.stringify([{type:'paragraph',content:[{type:'text',text:'Package body',styles:{}}],children:[]}])});
 const archive=exportSpaceZip(space),entries=unzip(archive,true),inventory=entries.find(e=>e.name.endsWith('/octavo-integrity.json'));
 assert.ok(inventory);checks++;const recorded=JSON.parse(inventory.data);check(recorded.schemaVersion,1);check(recorded.manifestPath,space.slug+'/octavo.json');check(verifyPackageIntegrity(entries).status,'verified');check(previewImport('export.zip',archive).packageIntegrity.status,'verified');
 const legacy=entries.filter(e=>e!==inventory);check(verifyPackageIntegrity(legacy).status,'unverified');check(previewImport('legacy.zip',zip(legacy)).packageIntegrity.status,'unverified');
 check(previewImport('markdown.zip',zip([{name:'page.md',data:Buffer.from('# Plain')}])).packageIntegrity,undefined);
 // Directory inclusion is opt-in; ordinary ZIP consumers retain prior behavior.
 const withDirectory=[{name:space.slug+'/',data:Buffer.alloc(0)},...legacy];check(unzip(zip(withDirectory)).length,legacy.length);check(unzip(zip(withDirectory),true).length,legacy.length+1);check(verifyPackageIntegrity(withDirectory).status,'unverified');
 const coveredDirectories=addPackageIntegrity(withDirectory,recorded.manifestPath);check(verifyPackageIntegrity(coveredDirectories).status,'verified');
 const snapshot=()=>JSON.stringify(db.prepare('SELECT id,slug FROM spaces ORDER BY id').all());
 const alteredInventory=mutate=>{const d=JSON.parse(inventory.data);mutate(d);return entries.map(e=>e===inventory?{...e,data:Buffer.from(JSON.stringify(d))}:e);};
 const cases=[
  entries.map(e=>e===inventory?e:{...e,data:Buffer.concat([e.data,Buffer.from('tamper')])}),
  entries.filter(e=>e!==legacy[0]),[...entries,{name:space.slug+'/extra.txt',data:Buffer.from('extra')}],
  entries.map(e=>e===inventory?{...e,data:Buffer.from('{broken')}:e),
  alteredInventory(d=>{d.schemaVersion=2;}),alteredInventory(d=>{d.algorithm='md5';}),alteredInventory(d=>{d.manifestPath='other/octavo.json';}),
  alteredInventory(d=>{d.files[0].bytes++;}),alteredInventory(d=>{d.files[0].sha256='0'.repeat(64);}),alteredInventory(d=>{d.files[0].sha256='bad';}),
  alteredInventory(d=>{d.files.push(d.files[0]);}),alteredInventory(d=>{d.files[0].path='../escape';}),
  [...entries,entries[0]],[...entries,{name:'other/octavo.json',data:legacy[0].data}],
  [...entries,{name:'other/octavo-integrity.json',data:inventory.data}],
  [...entries,{name:'../escape.txt',data:Buffer.from('x')}],
  [...entries,{name:space.slug+'/./alias.txt',data:Buffer.from('x')}],
  [...entries,{name:space.slug+'\\alias.txt',data:Buffer.from('x')}],
  [...entries,{name:space.slug+'/../',data:Buffer.alloc(0)}],
  [...entries,{name:space.slug+'/',data:Buffer.alloc(0)}],
  [...entries,{name:space.slug+'/octavo.json/',data:Buffer.alloc(0)}],
  entries.map(e=>e===inventory?{...e,data:Buffer.alloc(2*1024*1024+1,32)}:e),
 ];
 for(const invalid of cases){const bytes=zip(invalid),before=snapshot();assert.throws(()=>previewImport('broken.zip',bytes),/Package integrity/);checks++;assert.throws(()=>importUpload('broken.zip',bytes),/Package integrity/);checks++;check(snapshot(),before,'invalid package rejects before mutation');}
 // Parser sniffing cannot bypass a bad inventory or substitute a different manifest.
 const sniff=[...entries,{name:'entities.xml',data:Buffer.from('<hibernate-generic/>')}];assert.throws(()=>importUpload('sniff.zip',zip(sniff)),/Package integrity/);checks++;
 const badNames=[{name:'root/octavo.json',data:legacy[0].data},{name:'root/parent',data:Buffer.from('x')},{name:'root/parent/child.md',data:Buffer.from('# Child')}];assert.throws(()=>verifyPackageIntegrity(badNames),/directory/);checks++;
 const many=Array.from({length:10001},(_,n)=>({name:'root/'+n+'.md',data:Buffer.alloc(0)}));many[0]={name:'root/octavo.json',data:legacy[0].data};assert.throws(()=>verifyPackageIntegrity(many),/too many/);checks++;
 const lookalike=zip([{name:'fakeoctavo.json',data:Buffer.from(JSON.stringify({octavo:1,space:{name:'Spoof'},pages:[{title:'Spoof',blocks:[]}]}))},{name:'actual.md',data:Buffer.from('# Actual')}]);
 const lookPreview=previewImport('lookalike.zip',lookalike);check(lookPreview.packageIntegrity,undefined);check(lookPreview.pages.length,1);check(lookPreview.pages[0].title,'Actual');
 const lookImport=importUpload('lookalike.zip',lookalike),lookSpace=data.getSpaceBySlug(lookImport.spaceSlug);check(db.prepare('SELECT title FROM pages WHERE space_id=?').all(lookSpace.id),[{title:'Actual'}],'preview/import dispatch agree for lookalike manifest name');
 const imported=importUpload('valid.zip',archive);assert.ok(data.getSpaceBySlug(imported.spaceSlug));checks++;
 const oldImport=importUpload('legacy.zip',zip(legacy));assert.ok(data.getSpaceBySlug(oldImport.spaceSlug));checks++;
 console.log(`PASS package integrity: ${checks} checks`);
} finally {
 db?.close();Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
