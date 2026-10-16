import assert from 'node:assert/strict';
import { presentationSections } from '../src/lib/presentation.ts';
const b=(id,type='paragraph',props={})=>({id,type,props,children:[]});
const input=[b('intro'),b('section','heading',{level:2}),b('text'),b('sub','heading',{level:3}),b('detail'),b('break','pageBreak'),b('next'),b('end','pageBreak')];
assert.deepEqual(presentationSections(input).map(s=>s.map(b=>b.id)),[['intro'],['section','text','sub','detail'],['next']]);
assert.deepEqual(presentationSections([]),[]);
assert.deepEqual(presentationSections([b('a','pageBreak'),b('b','pageBreak')]),[]);
assert.equal(input.length,8);
console.log('PASS slide boundaries, nested headings, page breaks, empty content and source preservation.');
