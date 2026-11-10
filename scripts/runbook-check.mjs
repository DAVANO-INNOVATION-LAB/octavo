#!/usr/bin/env node
// Explicit local execution only. Inspect the downloaded plan before running.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
if(process.argv.length!==4 || process.argv[2]!=='--execute') {
  console.error('Inspect the plan, then run: node scripts/runbook-check.mjs --execute runbook-plan.json');
  process.exit(2);
}
const plan=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
for(const k of ['checkId','pageId','revision','definition','command','expected']) {
  if(typeof plan[k]!=='string'||plan[k].length>64000) throw new Error(`Invalid ${k}`);
}
const result=spawnSync(plan.command,{shell:true,encoding:'utf8',timeout:30000,maxBuffer:64000});
const output=((result.stdout||'')+(result.stderr||'')+(result.error?.message||'')).slice(0,64000);
console.log(JSON.stringify({checkId:plan.checkId,pageId:plan.pageId,revision:plan.revision,definition:plan.definition,exitCode:result.status??-1,output},null,2));
