import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { User } from "./auth";
import { getDb, UPLOADS_DIR } from "./db";
import { canReadUpload } from "./uploads";
import { getSpace, type Space } from "./data";
import { canEditSpace,canReadSpace } from "./roles";
import { requireQualityUser } from "./quality";
import { qualityRevision, reviewFor, publishProblems, type QualityPage } from "./quality-checks";
import { contentDigest, documentReferences } from "./quality-core";
import { parseBlocks } from "./blocks";
import { blocksToMarkdown } from "./markdown";
import { getSetting } from "./settings";
import { composeBlocks, parseVars } from "./page-compose";
import { zip, type ZipEntry } from "./zip";
/** A read-only snapshot. No drafts or inaccessible embedded sources enter it. */
export function releaseBundle(user:User|null,space:Space,version:string):Buffer {
 requireQualityUser(user);
 if(!canEditSpace(user,space.id)) throw new Error("Editing permission required");
 if(!/^[a-zA-Z0-9._-]{1,60}$/.test(version)) throw new Error("Invalid version label");
 return getDb().transaction(()=>{
  const db=getDb(), entries:ZipEntry[]=[], files=new Set<string>();let bytes=0;
  const add=(name:string,data:Buffer)=>{bytes+=data.length;if(bytes>200*1024*1024)throw new Error("Bundle exceeds 200 MB");entries.push({name,data});};
  const pages=db.prepare('SELECT * FROM pages WHERE space_id=? AND published=1 ORDER BY position,id').all(space.id) as QualityPage[];
  const manifest=pages.map(p=>{
   const blocks=composeBlocks(parseBlocks(p.content),parseVars(getSetting(`vars:${space.id}`)),id=>{
    const source=db.prepare('SELECT * FROM pages WHERE id=? AND published=1').get(id) as QualityPage|undefined;
    const sourceSpace=source&&getSpace(source.space_id);
    if(!source||!sourceSpace||!canReadSpace(user,sourceSpace))throw new Error('An embedded source is missing or inaccessible');
    return {state:'ok',title:source.title,href:`/${sourceSpace.slug}/${source.slug}`,blocks:parseBlocks(source.content)};
   });
   const serialized=JSON.stringify(blocks);
   for(const ref of documentReferences(serialized)) {
    if(!ref.value.startsWith('/api/files/'))continue;
    const name=ref.value.slice('/api/files/'.length).split(/[?#]/)[0];
    if(!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name))throw new Error('Invalid attachment path');
    if(!canReadUpload(user,name))throw new Error("An attachment is inaccessible; ask an administrator to verify its origin or reupload it into this space");
    if(!files.has(name)){const file=path.join(UPLOADS_DIR,name);if(!fs.existsSync(file))throw new Error('Missing attachment: '+name);if(fs.statSync(file).size>100*1024*1024)throw new Error('Attachment exceeds 100 MB');add('attachments/'+name,fs.readFileSync(file));files.add(name);}
   }
   const local=(s:string)=>s.replace(/\/api\/files\//g,'../attachments/');
   add(`pages/${p.id}.md`,Buffer.from(local('# '+p.title+'\n\n'+blocksToMarkdown(blocks))));
   add(`pages/${p.id}.json`,Buffer.from(local(serialized)));
   return {id:p.id,slug:p.slug,title:p.title,revision:qualityRevision(p),review:reviewFor(p.id),publishingProblems:publishProblems(p),markdown:`pages/${p.id}.md`};
  });
  add('release.json',Buffer.from(JSON.stringify({format:1,space:space.slug,version,createdAt:new Date().toISOString(),pages:manifest},null,2)));
  add('README.md',Buffer.from('# '+space.name+' — '+version+'\n\nPublished-page snapshot. Read Markdown in pages/; attachments are included. JSON preserves block properties. External links and embeds may require network access. Checksums cover all other files. Review metadata records the state at export time.\n'));
  add('checksums.sha256',Buffer.from(entries.map(e=>contentDigest(e.data)+'  '+e.name).join('\n')+'\n'));
  return zip(entries);
 })();
}
