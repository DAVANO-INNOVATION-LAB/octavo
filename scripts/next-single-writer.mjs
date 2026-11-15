// Plain Next does not expose its listener to our WebSocket coordinator. Keep
// documented local CLI modes functional without advertising unpersistable edits.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const mode=process.argv[2];
if(!['dev','start'].includes(mode))throw new Error('Expected dev or start');
const env={...process.env,OCTAVO_COLLAB:'0'};
delete env.OCTAVO_COLLAB_INTERNAL_SECRET;
console.log('Octavo: plain Next '+mode+' runs in single-writer mode. Use the packaged server wrapper for coordinated collaboration.');
const child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),mode,...process.argv.slice(3)],{stdio:'inherit',env});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
