// Deterministic EditorShell hook harness. Tests queue/error/recovery behavior,
// not real browser rendering or the BlockNote/Yjs editor itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),file=path.resolve('src/components/editor/EditorShell.tsx');
const originalLoad=Module._load,originalTsx=Module._extensions['.tsx'];
const old={fetch:globalThis.fetch,window:globalThis.window,document:globalThis.document,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
let slots=[],cursor=0,effects=[],cleanups=[],timers=new Map(),nextTimer=1,requests=[],listeners=new Map(),storage=new Map(),checks=0;
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const hooks={
 useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>slots[i]=typeof value==='function'?value(slots[i]):value];},
 useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
 useCallback(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn;},
 useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){slots[i]={deps};effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}},
};
const router={prefetch(){}},session={session:null,status:'offline',peers:[],failed:false};
Module._load=function(name,parent,main){
 if(parent?.filename===file){
  if(name==='react')return hooks;
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='next/dynamic')return {__esModule:true,default:()=>function FakeEditor(){}};
  if(name==='next/navigation')return {useRouter:()=>router};
  if(name==='./useCollab')return {useCollab:()=>session};
  if(name==='@/lib/client-config')return {collabEnabled:()=>false};
  if(name==='lucide-react')return {Users:'Users',WifiOff:'WifiOff'};
 }
 return originalLoad.call(this,name,parent,main);
};
Module._extensions['.tsx']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
globalThis.window={localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i]??null,getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn),history:{replaceState(){}},confirm:()=>false};
globalThis.document={createElement:()=>({click(){}})};
globalThis.fetch=(url,init)=>new Promise((resolve,reject)=>requests.push({url,body:JSON.parse(init.body),resolve,reject}));
globalThis.setTimeout=(fn,delay)=>{const id=nextTimer++;timers.set(id,{fn,delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);
const {EditorShell}=require(file);
const props={pageId:'page',spaceSlug:'space',pageSlug:'page',initialTitle:'Original',initialContent:'[]',initialRevision:0,initialEpoch:0,initialUserId:'user'};
const render=()=>{cursor=0;const tree=EditorShell(props);for(const effect of effects.splice(0))effect();return tree;};
const walk=node=>!node||typeof node!=='object'?[]:[node,...(Array.isArray(node.props?.children)?node.props.children:[node.props?.children]).flatMap(walk)];
const text=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':(Array.isArray(node.props?.children)?node.props.children:[node.props?.children]).map(text).join(' ');
const title=value=>walk(render()).find(node=>node.type==='textarea').props.onChange({target:{value}});
const fireTimers=()=>{const pending=[...timers];timers.clear();for(const [,t] of pending)if(t.delay===700)t.fn();};
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const success=(index,revision)=>requests[index].resolve({ok:true,status:200,json:async()=>({slug:'page',revision,epoch:0})});
const reset=()=>{for(const cleanup of cleanups)cleanup?.();slots=[];cursor=0;effects=[];cleanups=[];timers.clear();requests=[];listeners.clear();storage.clear();render();};
const check=async(name,fn)=>{await fn();checks++;console.log('ok',name);};
try {
 await check('serial saves use returned revisions and never overlap',async()=>{reset();title('First');fireTimers();assert.equal(requests.length,1);assert.equal(requests[0].body.expectedRevision,0);title('Second');fireTimers();assert.equal(requests.length,1);success(0,1);await tick();assert.equal(requests.length,2);assert.equal(requests[1].body.title,'Second');assert.equal(requests[1].body.expectedRevision,1);success(1,2);await tick();assert.equal(storage.size,0);assert.match(text(render()),/Saved/);});
 await check('409 preserves the latest draft and stops implicit retries',async()=>{reset();title('First');fireTimers();title('Latest while awaiting');requests[0].resolve({ok:false,status:409});await tick();assert.equal(storage.size,1);assert.equal(JSON.parse([...storage.values()][0]).title,'Latest while awaiting');assert.match(text(render()),/Page changed/);title('Kept after conflict');fireTimers();assert.equal(requests.length,1);assert.equal(JSON.parse([...storage.values()][0]).title,'Kept after conflict');assert.ok(!walk(render()).some(node=>node.type==='button'&&text(node)==='Retry save'));});
 await check('network failure retains edits and explicit retry keeps old baseline',async()=>{reset();title('Offline');fireTimers();requests[0].reject(Error('offline'));await tick();title('Offline latest');fireTimers();assert.equal(requests.length,1);const retry=walk(render()).find(node=>node.type==='button'&&text(node)==='Retry save');assert.ok(retry);retry.props.onClick();assert.equal(requests.length,2);assert.equal(requests[1].body.title,'Offline latest');assert.equal(requests[1].body.expectedRevision,0);requests[1].resolve({ok:false,status:409});await tick();assert.match(text(render()),/Page changed/);assert.equal(storage.size,1);});
 await check('late epoch fence does not clear draft when an old save response arrives',async()=>{reset();title('Pending epoch');fireTimers();for(const listener of listeners.get('octavo:collab-stale'))listener({detail:{pageId:'page'}});success(0,1);await tick();assert.equal(storage.size,1);assert.match(text(render()),/Page changed/);title('Offline branch');fireTimers();assert.equal(requests.length,1);});
 await check('close warns and persists rather than starting an untracked save',async()=>{reset();title('Leaving');let prevented=false;for(const listener of listeners.get('beforeunload'))listener({preventDefault(){prevented=true;},returnValue:null});assert.equal(prevented,true);assert.equal(storage.size,1);assert.equal(requests.length,0);});
 await check('recovered drafts remain separate and are never replayed automatically',async()=>{reset();storage.set('octavo-editor-draft:user:page:prior',JSON.stringify({pageId:'page',title:'Prior unsaved',content:[],expectedRevision:0,expectedEpoch:0,savedAt:'earlier'}));for(const cleanup of cleanups)cleanup?.();slots=[];cleanups=[];effects=[];render();await tick();const tree=render();assert.match(text(tree),/another session/);assert.equal(walk(tree).find(node=>node.type==='textarea').props.value,'Original');assert.equal(requests.length,0);title('New session draft');assert.equal(storage.size,2);assert.equal(JSON.parse(storage.get('octavo-editor-draft:user:page:prior')).title,'Prior unsaved');});
 await check('shared body uses barriers, never whole-body PATCH, and waits for newest edit',async()=>{reset();const barriers=[];session.session={persistence:'barrier-v1',epoch:0,provider:{persist:()=>new Promise((resolve,reject)=>barriers.push({resolve,reject}))}};const content=value=>walk(render()).find(node=>node.type?.name==='FakeEditor').props.onChange([{type:'paragraph',content:value}]);content('first');fireTimers();assert.equal(requests.length,0);assert.equal(barriers.length,1);content('second');fireTimers();assert.equal(barriers.length,1);barriers[0].resolve({epoch:0});await tick();assert.equal(barriers.length,2);assert.equal(storage.size,1);assert.match(text(render()),/Saving/);barriers[1].resolve({epoch:0});await tick();assert.equal(storage.size,0);assert.match(text(render()),/Saved/);session.session=null;});
 await check('title acknowledgment cannot clear a pending collaborative body',async()=>{reset();const barriers=[];session.session={persistence:'barrier-v1',epoch:0,provider:{persist:()=>new Promise(resolve=>barriers.push(resolve))}};walk(render()).find(node=>node.type?.name==='FakeEditor').props.onChange([]);title('Updated title');fireTimers();assert.equal(requests.length,1);assert.deepEqual(requests[0].body,{title:'Updated title',expectedTitle:'Original',expectedEpoch:0});success(0,5);await tick();assert.equal(storage.size,1);assert.match(text(render()),/Saving/);barriers[0]({epoch:0});await tick();assert.equal(storage.size,0);title('Next title');fireTimers();assert.equal(requests[1].body.expectedTitle,'Updated title');success(1,6);await tick();session.session=null;});
 await check('body acknowledgment cannot clear a pending title or stale-epoch recovery',async()=>{reset();const barriers=[];session.session={persistence:'barrier-v1',epoch:0,provider:{persist:()=>new Promise(resolve=>barriers.push(resolve))}};walk(render()).find(node=>node.type?.name==='FakeEditor').props.onChange([]);title('Pending title');fireTimers();barriers[0]({epoch:0});await tick();assert.equal(storage.size,1);assert.match(text(render()),/Saving/);for(const listener of listeners.get('octavo:collab-stale'))listener({detail:{pageId:'page'}});success(0,3);await tick();assert.equal(storage.size,1);assert.match(text(render()),/Page changed/);session.session=null;});
 console.log(`${checks} editor save queue cases passed`);
} finally {for(const cleanup of cleanups)cleanup?.();Module._load=originalLoad;Module._extensions['.tsx']=originalTsx;Object.assign(globalThis,old);}
