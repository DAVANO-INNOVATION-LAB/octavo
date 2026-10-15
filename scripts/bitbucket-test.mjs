import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
const staged=new URL('../src/lib/.bitbucket-test.ts',import.meta.url);
writeFileSync(staged,readFileSync(new URL('../src/lib/git-host.ts',import.meta.url),'utf8').replace('import "server-only";',''));
let mode='ok', push='';
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c);
 assert.equal(req.headers.authorization,'Bearer local-test-token');
 const url=new URL(req.url,'http://localhost');
 const send=o=>res.end(JSON.stringify(o));
 if(mode==='denied'){res.statusCode=401;return send({error:'unauthorized'});}
 if(url.pathname.includes('/rest/api/1.0/')) {
   if(url.pathname.endsWith('/branches'))return send({values:[{displayId:'main'}],isLastPage:true});
   if(url.pathname.endsWith('/files'))return send(url.searchParams.get('start')==='0'?{values:['docs/readme.md'],isLastPage:false,nextPageStart:1}:{values:['docs/nested/guide.md','other.md'],isLastPage:true});
   if(url.pathname.includes('/raw/'))return res.end('# DC Guide');
 }
 if(url.pathname.endsWith('/refs/branches/main'))return send({name:'main'});
 if(req.method==='POST'){push=Buffer.concat(chunks).toString();return send({hash:'commit123'});}
 if(url.pathname.endsWith('/guide.md'))return res.end('# Guide');
 if(url.pathname.endsWith('/docs/nested'))return send({values:[{type:'commit_file',path:'docs/nested/guide.md',commit:{hash:'a'}}]});
 return send({values:[{type:'commit_directory',path:'docs/nested'},{type:'commit_file',path:'docs/readme.md',commit:{hash:'b'}},{type:'commit_file',path:'docs/picture.png'}],...(mode==='hostile'?{next:'https://attacker.invalid/leak'}:{})});
});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const api=await import(staged.href);
 const c={provider:'bitbucket',endpoint:`http://127.0.0.1:${server.address().port}`,repo:'workspace/repo',branch:'main',path:'docs',token:'local-test-token'};
 assert.equal((await api.verifyConnection(c)).ok,true);
 const listed=await api.listMarkdown(c);assert.equal(listed.ok,true);assert.deepEqual(listed.value.map(f=>f.path).sort(),['nested/guide.md','readme.md']);
 assert.equal((await api.readFile(c,'nested/guide.md')).value,'# Guide');
 assert.equal((await api.pushFiles(c,[{path:'new.md',content:'# New'}],'Demo')).value.commit,'commit123');
 assert.ok(push.includes('name="/docs/new.md"'));assert.ok(push.includes('# New'));
 const dc={...c,provider:'bitbucket-dc',repo:'PROJ/repo',endpoint:c.endpoint+'/bitbucket'};
 assert.equal((await api.verifyConnection(dc)).ok,true);
 assert.equal((await api.listMarkdown(dc)).value.length,2);
 assert.equal((await api.readFile(dc,'nested/guide.md')).value,'# DC Guide');
 assert.equal((await api.pushFiles(dc,[{path:'new.md',content:'no write'}],'blocked')).ok,false);
 assert.ok(api.fileUrl(dc,'nested/guide.md').includes('/bitbucket/projects/PROJ/repos/repo/browse/docs/nested/guide.md'));
 console.log('PASS Data Center: context path, branch, pagination, scoped file listing, raw read, write refusal, source link.');
 mode='hostile';assert.equal((await api.listMarkdown(c)).ok,false);
 mode='denied';assert.equal((await api.verifyConnection(c)).ok,false);
 console.log('PASS Bitbucket: branch, nested listing, Markdown filtering, read, multipart push, hostile pagination refusal, denied token.');
}finally{server.close();rmSync(staged,{force:true});}
