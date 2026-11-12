import "server-only";
import path from "node:path";
import { unzip } from "./zip";
import { looksLikeConfluence,readConfluenceExport } from "./confluence";
import { looksLikeConfluenceHtml,readConfluenceHtmlExport } from "./confluence-html";
import { markdownToBlocks,splitFrontmatter } from "./markdown";
import { planMarkdownAssets } from "./markdown-assets";
import { planMarkdownImport } from "./markdown-import-plan";
import { documentReferences,contentDigest } from "./quality-core";

const KNOWN=new Set(["paragraph","heading","bulletListItem","numberedListItem","checkListItem","quote","codeBlock","table","image","video","audio","file","pageBreak","toggleListItem","callout","expandable","step","math","drawio","themeImage","model3d","apiRequest","sketch","syncedPage","ifvar"]);
export type ImportPreview={digest:string;pages:{title:string;blocks:number;sourcePath?:string;parentIndex?:number|null;published?:boolean;generated?:boolean}[];warnings:string[];errors:string[];attachments:number;assetPlan?:{files:number;bytes:number}};
/** Uses import parsers without creating spaces, pages, or attachment files. */
export function previewImport(name:string,data:Buffer):ImportPreview {
  const result:ImportPreview={digest:contentDigest(data),pages:[],warnings:[],errors:[],attachments:0};
  const add=(title:string,blocks:unknown[])=>{
    if(!Array.isArray(blocks)) throw new Error("Page blocks must be an array");
    const walk=(list:unknown[])=>{for(const b of list){if(!b||typeof b!=="object") {result.errors.push(`Invalid block in ${title}`);continue;}const x=b as {type?:string;children?:unknown[]};if(!KNOWN.has(x.type??""))result.errors.push(`Unsupported block ${x.type??"unknown"} in ${title}`);if(Array.isArray(x.children))walk(x.children);}};
    walk(blocks);result.pages.push({title,blocks:blocks.length});
  };
  const lower=name.toLowerCase();
  if(lower.endsWith(".zip")) {
    const entries=unzip(data), names=new Set(entries.map(e=>path.posix.normalize(e.name.replaceAll("\\","/"))));
    if(looksLikeConfluence(entries)) {
      const parsed=readConfluenceExport(entries,true);parsed.pages.forEach(p=>add(p.title,p.blocks));result.attachments=parsed.attachmentsSaved;
      result.warnings.push(...parsed.attachmentsMissing.map(n=>`Missing attachment: ${n}`));
      if(parsed.pagesSkipped)result.warnings.push(`${parsed.pagesSkipped} archived or historical pages will be skipped`);
    } else if(looksLikeConfluenceHtml(entries)) {
      const parsed=readConfluenceHtmlExport(entries,p=>{if(!names.has(path.posix.normalize(p)))result.warnings.push(`Missing attachment: ${p}`);return p;});
      parsed.pages.forEach(p=>add(p.title,p.blocks));result.attachments=entries.filter(e=>!e.name.match(/\.html?$/i)).length;
    } else {
      const manifest=entries.find(e=>e.name.endsWith("octavo.json"));
      if(manifest) readManifest(manifest.data);
      else {
      const markdownPlan=planMarkdownImport(entries);
      const indices=new Map(markdownPlan.nodes.map((node,index)=>[node.key,index]));
      for(const node of markdownPlan.nodes){
        add(node.title,node.blocks);
        Object.assign(result.pages[result.pages.length-1],{parentIndex:node.parentKey?indices.get(node.parentKey):null,published:node.published,generated:node.sourcePath===undefined,...(node.sourcePath!==undefined?{sourcePath:node.sourcePath}:{})});
      }
      for(const document of markdownPlan.documents) {
        for(const ref of documentReferences(JSON.stringify(document.blocks))) {
          if(ref.kind==="synced"||/^(#|\/|[a-z]+:)/i.test(ref.value))continue;
          let target:string;try{target=decodeURIComponent(ref.value.split(/[?#]/)[0]);}catch{result.warnings.push(`Invalid link: ${ref.value}`);continue;}
          if(!names.has(path.posix.normalize(path.posix.join(path.posix.dirname(document.sourcePath),target))))result.warnings.push(`Missing local reference in ${document.sourcePath}: ${ref.value}`);
        }
      }
      const plan=planMarkdownAssets(entries,markdownPlan.documents);
      result.assetPlan={files:plan.assets.size,bytes:plan.bytes};
      }
      result.attachments=entries.filter(e=>!e.name.match(/\.(md|json)$/i)).length;
    }
  } else if(lower.endsWith(".json")) readManifest(data);
  else if(/\.(md|markdown|txt)$/.test(lower)) {const [meta,body]=splitFrontmatter(data.toString("utf8"));add(meta.title||name,markdownToBlocks(body));}
  else if(lower.endsWith(".ipynb")) {
    const nb=JSON.parse(data.toString("utf8"));if(!Array.isArray(nb.cells))throw new Error("Notebook has no cells");
    result.pages.push({title:name,blocks:nb.cells.length});result.warnings.push("Notebook cell count shown; outputs and images are converted during import.");
  } else if(lower.endsWith(".docx")) {
    const doc=unzip(data).find(e=>e.name==="word/document.xml");if(!doc)throw new Error("Word document is missing document.xml");
    result.pages.push({title:name,blocks:[...doc.data.toString().matchAll(/<w:p[ >]/g)].length});result.warnings.push("Word paragraphs are converted; complex formatting and embedded objects may be simplified.");
  } else throw new Error("Unsupported import format");
  const titles=new Set<string>();for(const p of result.pages){const t=p.title.trim().toLowerCase();if(titles.has(t))result.warnings.push(`Duplicate title: ${p.title}`);titles.add(t);}
  if(!result.pages.length) result.errors.push("No importable pages found");
  if(result.pages.length>5000)result.errors.push("Import is limited to 5,000 pages");
  result.warnings=[...new Set(result.warnings)].slice(0,200);result.errors=[...new Set(result.errors)].slice(0,200);
  return result;
  function readManifest(bytes:Buffer) {
    const m=JSON.parse(bytes.toString("utf8"));if(m.octavo!==1||!Array.isArray(m.pages))throw new Error("Not an Octavo manifest");
    m.pages.forEach((p:{title:string;blocks:unknown[]})=>add(p.title||"Untitled",p.blocks));
  }
}
