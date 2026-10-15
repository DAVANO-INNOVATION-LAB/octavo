// Keep mutable runtime data and development-only dependencies out of releases.
import {readFileSync, rmSync, existsSync, readdirSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.env.OCTAVO_BUILD_DIR||'.next','standalone');
if(!existsSync(path.join(root,'server.js')))throw new Error('Standalone build is missing');
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
for(const [name,entry]of Object.entries(lock.packages)){
 if(entry.dev && name.startsWith('node_modules/') && !name.includes('..'))rmSync(path.join(root,name),{recursive:true,force:true});
}
for(const name of readdirSync(root)){
 if(['data','.git'].includes(name)||name.startsWith('.env'))rmSync(path.join(root,name),{recursive:true,force:true});
}
if(existsSync(path.join(root,'data'))||existsSync(path.join(root,'node_modules/braces')))throw new Error('Standalone contains excluded runtime data or development dependencies');
console.log('Standalone verified: runtime data and development-only dependencies excluded.');
