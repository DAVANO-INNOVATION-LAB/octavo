import "server-only";
import { BlockNoteEditor, BlockNoteSchema, createBlockSpec, createStyleSpec, defaultBlockSpecs, defaultStyleSpecs } from "@blocknote/core";
import { blocksToYDoc, yDocToBlocks } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { customBlockConfigs, noteStyleConfig } from "./collab-schema";

// Conversion does not render. Accidentally invoking a rendering path fails
// rather than importing browser code or silently inventing a DOM.
const noRender = (): never => { throw new Error("Headless projection cannot render DOM"); };
const customSpecs = Object.fromEntries(Object.values(customBlockConfigs).map(config => [config.type,createBlockSpec(config,{render:noRender})()]));
const schema = BlockNoteSchema.create({blockSpecs:{...defaultBlockSpecs,...customSpecs},styleSpecs:{...defaultStyleSpecs,note:createStyleSpec(noteStyleConfig,{render:noRender})}});
const editor = () => BlockNoteEditor.create({schema});
const stable = (value: unknown): string => JSON.stringify(normalize(value));
function normalize(value: unknown): unknown {
  if(Array.isArray(value))return value.map(normalize);
  if(value && typeof value === "object")return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)]));
  return value;
}
// Compare supplied fields, allowing only schema-default fields to be added.
// Unknown properties, styles, IDs and text must never silently disappear.
function retains(input: unknown, output: unknown): boolean {
  if(Array.isArray(input))return Array.isArray(output) && input.length===output.length && input.every((v,i)=>retains(v,output[i]));
  if(input && typeof input === "object")return !!output && typeof output === "object" && Object.entries(input).every(([k,v])=>Object.hasOwn(output,k) && retains(v,(output as Record<string,unknown>)[k]));
  return input===output;
}
function xmlShape(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): unknown {
  if(node instanceof Y.XmlText)return {text:node.toDelta()};
  return {name:node instanceof Y.XmlElement?node.nodeName:"fragment",attrs:node instanceof Y.XmlElement?node.getAttributes():{},children:node.toArray().map(child=>{
    if(!(child instanceof Y.XmlElement) && !(child instanceof Y.XmlText))throw new Error("Unsupported shared document node");
    return xmlShape(child);
  })};
}
/** Seed only a new epoch. Never replace an existing CRDT's history with this. */
export function seedSharedState(content: string): Uint8Array {
  const blocks: unknown=JSON.parse(content);
  if(!Array.isArray(blocks))throw new Error("Page content must be a block array");
  const instance=editor();
  const doc=blocksToYDoc(instance,blocks as never,"blocknote");
  try {
    const roundtrip=yDocToBlocks(instance,doc,"blocknote");
    if(!retains(blocks,roundtrip))throw new Error("Page content cannot be seeded without loss");
    return Y.encodeStateAsUpdate(doc);
  } finally {doc.destroy();}
}
/** Read only: materialize the complete state without altering CRDT history. */
export function projectSharedState(bytes: Uint8Array): string {
  if(!bytes.length)throw new Error("Shared document is not seeded");
  const doc=new Y.Doc();let canonical:Y.Doc|undefined;
  try {
    Y.applyUpdate(doc,bytes);
    if(!doc.share.has("blocknote"))throw new Error("Shared document has no blocknote fragment");
    // Unresolved update dependencies mean this is not a complete persisted state.
    if(doc.store.pendingStructs || doc.store.pendingDs)throw new Error("Shared document state is incomplete");
    const instance=editor(),fragment=doc.getXmlFragment("blocknote");
    const before=stable(xmlShape(fragment));
    const blocks=yDocToBlocks(instance,doc,"blocknote");
    canonical=blocksToYDoc(instance,blocks,"blocknote");
    if(before!==stable(xmlShape(canonical.getXmlFragment("blocknote"))))throw new Error("Shared document cannot be projected without loss");
    return JSON.stringify(blocks);
  } finally {canonical?.destroy();doc.destroy();}
}
