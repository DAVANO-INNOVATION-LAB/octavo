// Functional metadata projection/filter tests. No services or persistent state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),oldTs=Module._extensions['.ts'];
let checks=0;
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
try{
 const {TEMPLATES}=require('../src/lib/templates.ts');
 const {TEMPLATE_GROUPS,templateOutline,buildTemplateCatalog,filterTemplateCatalog}=require('../src/lib/template-catalog.ts');
 const before=JSON.stringify(TEMPLATES),catalog=buildTemplateCatalog(TEMPLATES);
 check(JSON.stringify(TEMPLATES),before,'metadata projection does not mutate templates');check(catalog.length,TEMPLATES.length);check(catalog.map(t=>t.id),TEMPLATES.map(t=>t.id),'catalog order is unchanged');
 const expectedOutline=(pages,depth=0,parentIndex=null,out=[])=>{for(const page of pages){const index=out.length;out.push({title:page.title.trim()||'Untitled',depth,parentIndex});expectedOutline(page.children??[],depth+1,index,out);}return out;};
 for(let i=0;i<TEMPLATES.length;i++){
  const actual=catalog[i],template=TEMPLATES[i],outline=expectedOutline(template.pages);
  check(Object.keys(actual).sort(),['audience','group','id','kind','name','outline','pageCount','tagline']);check(actual.outline,outline);check(actual.pageCount,outline.length);
  for(const key of ['audience','group','id','kind','name','tagline'])check(actual[key],template[key]);
  for(const node of actual.outline)check(Object.keys(node).sort(),['depth','parentIndex','title']);
 }
 check(filterTemplateCatalog(catalog),catalog);check(filterTemplateCatalog(catalog,{query:' \t ',group:'all'}),catalog);
 check(TEMPLATE_GROUPS.map(g=>g.id),['simple','presentation','engineering']);
 for(const {id} of TEMPLATE_GROUPS)check(filterTemplateCatalog(catalog,{group:id}),catalog.filter(t=>t.group===id));
 check(filterTemplateCatalog(catalog,{query:'runnable demos'}).map(t=>t.id),['job-demos']);check(filterTemplateCatalog(catalog,{query:'RUNNABLE  DEMOS'}).map(t=>t.id),['job-demos']);check(filterTemplateCatalog(catalog,{query:'runnable demos',group:'simple'}),[]);
 const synthetic=[{
  id:'nested',name:'Café notebook',tagline:'Focused experiments',audience:'Platform teams',kind:'docs',group:'simple',
  pages:[{title:'  Start  ',get blocks(){throw Error('Block bodies must never be read');},children:[{title:'Child',blocks:[{type:'heading',text:'DO_NOT_SERIALIZE_OR_SEARCH_BODY'}],children:[{title:'  ',blocks:[]}]}]},{title:'Last',blocks:[]}],
  secret:'DO_NOT_SERIALIZE_EXTRA_METADATA',
 },{id:'empty',name:'Empty skeleton',tagline:'No draft pages',audience:'Everyone',kind:'docs',group:'engineering',pages:[]}];
 const projected=buildTemplateCatalog(synthetic);
 check(projected[0].outline,[{title:'Start',depth:0,parentIndex:null},{title:'Child',depth:1,parentIndex:0},{title:'Untitled',depth:2,parentIndex:1},{title:'Last',depth:0,parentIndex:null}]);check(projected[0].pageCount,4);check(projected[1].pageCount,0);check(templateOutline([]),[]);
 check(JSON.stringify(projected).includes('DO_NOT_SERIALIZE'),false,'neither block content nor extra fields serialized');
 check(filterTemplateCatalog(projected,{query:'cafe platform child'}).map(t=>t.id),['nested'],'accent insensitive multiword matching spans metadata and outline');
 check(filterTemplateCatalog(projected,{query:'DO_NOT_SERIALIZE_OR_SEARCH_BODY'}),[],'body-only text is not searchable');check(filterTemplateCatalog(projected,{query:'missing'}),[]);
 const projectedBefore=JSON.stringify(projected);filterTemplateCatalog(projected,{query:'child',group:'simple'});check(JSON.stringify(projected),projectedBefore,'filtering does not mutate catalog or selection metadata');
 check(buildTemplateCatalog([]),[]);check(filterTemplateCatalog([],{query:'anything'}),[]);
 console.log(`${checks} template catalog functional checks passed`);
}finally{if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];}
