import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { requireTarget } from './target.mjs';
const base=process.argv[2]||'http://127.0.0.1:8612'; await requireTarget(base);
const db=new Database('data/octavo.db');db.pragma('foreign_keys = ON');
const id='trash-'+randomBytes(6).toString('hex'),now=Date.now();
const tokens=[randomBytes(24).toString('hex'),randomBytes(24).toString('hex')];
const headers=i=>({cookie:`octavo_session=${tokens[i]}`,origin:new URL(base).origin});
const action=(html,field)=>{
 const form=[...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map(m=>m[0]).find(f=>f.includes(`name="${field}"`));
 assert.ok(form,`form containing ${field} exists`);
 return form.match(/name="(\$ACTION_ID_[^"]+)"/)[1];
};
async function post(url,key,fields,i=0){const form=new FormData();form.set(key,'');for(const [k,v] of Object.entries(fields))form.set(k,v);return fetch(url,{method:'POST',headers:headers(i),body:form,redirect:'manual'});}
let space;
try{
 for(let i=0;i<2;i++){
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id+i,id+i+'@example.test','Trash test','disabled','member',now);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokens[i],id+i,now+3600000);
 }
 const form=new FormData();form.set('name',id);form.set('file',new Blob(['# Recovery specimen\n\nRetain this exact content.']), 'recovery.md');
 const imported=await fetch(base+'/api/import',{method:'POST',headers:headers(0),body:form,redirect:'manual'});
 assert.equal(imported.status,303);space=db.prepare('SELECT * FROM spaces WHERE slug=?').get(imported.headers.get('location').slice(1));
 db.prepare('INSERT INTO space_members(space_id,user_id,role,added_at) VALUES(?,?,?,?)').run(space.id,id+1,'reader',now);
 const pagesBefore=db.prepare('SELECT * FROM pages WHERE space_id=? ORDER BY id').all(space.id);
 const membersBefore=db.prepare('SELECT * FROM space_members WHERE space_id=? ORDER BY user_id').all(space.id);
 db.prepare("UPDATE spaces SET visibility='public' WHERE id=?").run(space.id);
 const original=pagesBefore[0];
 db.prepare('INSERT INTO page_versions(id,page_id,title,content,content_text,saved_at) VALUES(?,?,?,?,?,?)').run(id+'-version',original.id,original.title,original.content,original.content_text,now);
 db.prepare('INSERT INTO comments(id,page_id,user_id,body,created_at) VALUES(?,?,?,?,?)').run(id+'-comment',original.id,id+1,'Keep this discussion',now);
 const settings=base+'/'+space.slug+'/settings';
 const html=await(await fetch(settings,{headers:headers(0)})).text();
 const del=action(html,'confirmation');
 await post(settings,del,{slug:space.slug,confirmation:space.name},1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM deleted_spaces WHERE space_id=?').get(space.id).n,0,'reader cannot delete');
 await post(settings,del,{slug:space.slug,confirmation:'wrong'});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM deleted_spaces WHERE space_id=?').get(space.id).n,0,'confirmation enforced server-side');
 const removed=await post(settings,del,{slug:space.slug,confirmation:space.name});assert.equal(removed.status,303);assert.match(removed.headers.get('location'),/trash/);
 assert.ok(db.prepare('SELECT 1 FROM deleted_spaces WHERE space_id=?').get(space.id));
 for(const path of ['/'+space.slug,'/'+space.slug+'/'+pagesBefore[0].slug,'/api/pages/'+pagesBefore[0].id+'/export'])assert.equal((await fetch(base+path,{headers:headers(0),redirect:'manual'})).status,404,path);
 assert.ok(!(await(await fetch(base+'/',{headers:headers(0)})).text()).includes(`href="/${space.slug}"`));
 assert.ok(!(await(await fetch(base+'/api/search?q=Recovery',{headers:headers(0)})).text()).includes(pagesBefore[0].id));
 assert.equal((await fetch(base+'/'+space.slug+'/'+original.slug,{redirect:'manual'})).status,404);
 assert.ok(!(await(await fetch(base+'/api/search?q=Recovery')).text()).includes(original.id));
 assert.ok(!(await(await fetch(base+'/sitemap.xml')).text()).includes('/'+space.slug+'/'));
 const trash=await(await fetch(base+'/trash',{headers:headers(0)})).text();assert.ok(trash.includes(`<h2 class="font-medium">${space.name}</h2>`));
 assert.ok(!(await(await fetch(base+'/trash',{headers:headers(1)})).text()).includes(`<h2 class="font-medium">${space.name}</h2>`));
 const restore=action(trash,'spaceId');
 await post(base+'/trash',restore,{spaceId:space.id},1);assert.ok(db.prepare('SELECT 1 FROM deleted_spaces WHERE space_id=?').get(space.id));
 const restored=await post(base+'/trash',restore,{spaceId:space.id});assert.equal(restored.status,303);
 assert.ok(!db.prepare('SELECT 1 FROM deleted_spaces WHERE space_id=?').get(space.id));
 assert.deepEqual(db.prepare('SELECT * FROM pages WHERE space_id=? ORDER BY id').all(space.id),pagesBefore);
 assert.deepEqual(db.prepare('SELECT * FROM space_members WHERE space_id=? ORDER BY user_id').all(space.id),membersBefore);
 assert.equal(db.prepare('SELECT content FROM page_versions WHERE id=?').get(id+'-version').content,original.content);
 assert.equal(db.prepare('SELECT body FROM comments WHERE id=?').get(id+'-comment').body,'Keep this discussion');
 assert.equal((await fetch(base+'/'+space.slug,{headers:headers(0)})).status,200);
 assert.equal((await fetch(base+'/'+space.slug+'/'+pagesBefore[0].slug,{headers:headers(1)})).status,200);
 console.log('PASS confirmed deletion, forged reader denial, hidden routes/search/library, retained content and grants, restricted Trash, restoration and original URLs.');
}finally{
 if(space){db.prepare('DELETE FROM pages_fts WHERE page_id IN (SELECT id FROM pages WHERE space_id=?)').run(space.id);db.prepare('DELETE FROM spaces WHERE id=?').run(space.id);}
 for(let i=0;i<2;i++){db.prepare('DELETE FROM sessions WHERE user_id=?').run(id+i);db.prepare('DELETE FROM users WHERE id=?').run(id+i);}db.close();
}
