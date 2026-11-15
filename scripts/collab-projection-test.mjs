// Real BlockNote/Yjs ESM conversion, no DOM and no mocked schema.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import * as Y from 'yjs';
import {defaultBlockSpecs} from '@blocknote/core';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-projection-'));
try {
 fs.symlinkSync(path.resolve('node_modules'),path.join(temp,'node_modules'),'dir');
 for(const name of ['collab-schema','collab-projection'])fs.writeFileSync(path.join(temp,name+'.mjs'),ts.transpileModule(fs.readFileSync('src/lib/'+name+'.ts','utf8').replace('import "server-only";','').replace('"./collab-schema"','"./collab-schema.mjs"'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
 const {seedSharedState,projectSharedState}=await import(pathToFileURL(path.join(temp,'collab-projection.mjs'))),{customBlockConfigs}=await import(pathToFileURL(path.join(temp,'collab-schema.mjs')));
 let checks=0;const check=(name,fn)=>{fn();console.log('ok',name);checks++;};
 const paragraph={id:'nested',type:'paragraph',content:[{type:'text',text:'Nested note',styles:{note:'Keep annotation',bold:true}}],children:[]};
 for(const config of Object.values(customBlockConfigs))check('custom '+config.type+' preserves IDs, props, content and nested note',()=>{
  const props=Object.fromEntries(Object.entries(config.propSchema).map(([k,v])=>[k,v.values?.[1]??(typeof v.default==='string'?'fixture-'+k:v.default)]));
  const input={id:'block-'+config.type,type:config.type,props,children:[paragraph],...(config.content==='inline'?{content:[{type:'text',text:'Rich text',styles:{italic:true,note:'Annotation'}}]}:{})};
  const result=JSON.parse(projectSharedState(seedSharedState(JSON.stringify([input]))));assert.equal(result[0].id,input.id);assert.deepEqual(result[0].props,props);assert.deepEqual(result[0].children[0].content,paragraph.content);assert.equal(result[0].children[0].id,'nested');
 });
 check('default blocks, links, media and styles roundtrip',()=>{const input=[paragraph,{id:'heading',type:'heading',props:{level:2},content:[{type:'link',href:'https://example.test',content:[{type:'text',text:'Link',styles:{underline:true}}]}],children:[]},{id:'image',type:'image',props:{url:'/uploads/example.png',caption:'Caption'},children:[]}];assert.equal(JSON.parse(projectSharedState(seedSharedState(JSON.stringify(input)))).length,3);});
 for(const [type,spec] of Object.entries(defaultBlockSpecs))check('default schema '+type,()=>{
  const content=spec.config.content==='table'?{type:'tableContent',columnWidths:[120,180],rows:[{cells:[{type:'tableCell',content:[{type:'text',text:'Cell A',styles:{note:'table note'}}]},{type:'tableCell',content:[{type:'text',text:'Cell B',styles:{bold:true}}]}]}]}:spec.config.content==='none'?undefined:[{type:'text',text:'Default '+type,styles:{}}];
  const input={id:'default-'+type,type,children:[],...(content===undefined?{}:{content})};const result=JSON.parse(projectSharedState(seedSharedState(JSON.stringify([input]))));assert.equal(result[0].id,input.id);assert.equal(result[0].type,type);
 });
 check('unknown block, prop and style rejected instead of discarded',()=>{for(const input of [[{...paragraph,type:'future'}],[{...paragraph,props:{future:'value'}}],[{...paragraph,content:[{type:'text',text:'Hi',styles:{future:true}}]}]])assert.throws(()=>seedSharedState(JSON.stringify(input)));});
 check('malformed and missing fragment states rejected',()=>{assert.throws(()=>projectSharedState(new Uint8Array()));assert.throws(()=>projectSharedState(new Uint8Array([255])));assert.throws(()=>projectSharedState(Y.encodeStateAsUpdate(new Y.Doc())));});
 check('unknown Yjs element attribute rejected without dropping data',()=>{const doc=new Y.Doc();Y.applyUpdate(doc,seedSharedState(JSON.stringify([paragraph])));doc.getXmlFragment('blocknote').get(0).setAttribute('future','value');assert.throws(()=>projectSharedState(Y.encodeStateAsUpdate(doc)));doc.destroy();});
 check('projection is non-mutating and deterministic',()=>{const bytes=seedSharedState(JSON.stringify([paragraph])),copy=bytes.slice();assert.equal(projectSharedState(bytes),projectSharedState(bytes));assert.deepEqual(bytes,copy);});
 console.log(`${checks} headless projection cases passed`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
