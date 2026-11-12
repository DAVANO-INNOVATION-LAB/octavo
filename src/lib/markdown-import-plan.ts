import "server-only";
import type { ZipEntry } from "./zip";
import { cleanNotionPath, looksLikeNotion, splitNotionPage } from "./notion";
import { markdownToBlocks, splitFrontmatter } from "./markdown";
import { newId } from "./util";

type MarkdownBlocks = ReturnType<typeof markdownToBlocks>;
export type MarkdownImportNode = { key: string; parentKey: string | null; title: string; published: boolean; sourcePath?: string; blocks: MarkdownBlocks };
function titleFrom(meta: Record<string,string>, body: string, fallback: string): string {
  if(meta.title){try{const parsed:unknown=JSON.parse(meta.title);return typeof parsed === "string"?parsed:meta.title;}catch{return meta.title;}}
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}
const cleanSegment = (s: string) => s.replace(/^\d+[-_.]/, "").replace(/\.md$/i, "");

/** Read-only conversion and hierarchy plan. No database or attachment writes. */
export function planMarkdownImport(entries: ZipEntry[]) {
  const mdFiles = entries
    .filter((e) => e.name.toLowerCase().endsWith(".md"))
    .filter((e) => !e.name.split("/").some((seg) => seg.startsWith(".")));
  if (!mdFiles.length) throw new Error("no markdown files found");

  // A Notion export is markdown, so it lands here — but with a 32-hex id
  // welded onto every name and every internal link pointing at those names.
  // Imported as-is it arrives with unreadable titles and broken links, which
  // is worse than refusing it, because it looks like it worked.
  const notion = looksLikeNotion(entries.map((e) => e.name));

  // Strip a common root directory if every file shares one.
  const parts = mdFiles.map((e) => (notion ? cleanNotionPath(e.name) : e.name).split("/"));
  let rootName = "";
  if (parts.every((p) => p.length > 1 && p[0] === parts[0][0])) {
    rootName = parts[0][0];
    for (const p of parts) p.shift();
  }

  // Start with a deterministic source order; folder-document priority is
  // resolved explicitly after parsing, rather than relying on archive order.
  const files = mdFiles
    .map((e, i) => ({
      path: parts[i].join("/"),
      sourcePath: e.name,
      data: e.data,
    }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0);

  // Prepare the exact document conversion before planning any attachment writes.
  const prepared = files.map(f => {
    const segs = f.path.split("/");
    const fileName = segs.pop()!;
    let raw = f.data.toString("utf8");
    let notionProps: { name: string; value: string }[] = [];
    if (notion) {
      const split = splitNotionPage(raw);
      notionProps = split.properties;
      // Notion writes the title as an H1; keep it so titleFrom still sees it.
      raw = split.title ? `# ${split.title}\n\n${split.body}` : split.body;
    }
    const [meta, body] = splitFrontmatter(raw);
    const isIndex = /^(index|readme)\.md$/i.test(fileName);
    const fallback = cleanSegment(isIndex ? segs[segs.length - 1] ?? "Home" : fileName)
      .replace(/[-_]/g, " ");
    const title = titleFrom(meta, body, fallback || "Untitled");
    // Drop a leading H1 that duplicates the title.
    const bodyNoH1 = body.replace(/^#\s+.+\n+/, (m) =>
      m.slice(2).trim() === title ? "" : m
    );
    const blocks = markdownToBlocks(bodyNoH1);
    // Database properties are real content — owner, status, dates — but read
    // as a broken paragraph inline. A table keeps them, and keeps them apart.
    if (notionProps.length > 0) {
      blocks.unshift({
        id: newId(),
        type: "table",
        props: {},
        content: {
          type: "tableContent",
          rows: notionProps.map((pr) => ({
            cells: [
              [{ type: "text", text: pr.name, styles: { bold: true } }],
              [{ type: "text", text: pr.value, styles: {} }],
            ],
          })),
        },
        children: [],
      } as unknown as (typeof blocks)[number]);
    }

    return { ...f, meta, isIndex, title, blocks };
  });
  const directoryOf = (file: (typeof prepared)[number]) => file.path.split("/").slice(0,-1).join("/");
  const compareText = (a: string,b: string) => a < b ? -1 : a > b ? 1 : 0;
  // One source document owns each folder holder. index.md wins over README.md;
  // exact lowercase spelling wins ties, then original paths break ties. Other
  // index/readme documents remain separate children, never overwritten bodies.
  const primaryByDirectory = new Map<string,(typeof prepared)[number]>();
  const rankIndex = (file: (typeof prepared)[number]) => {
    const name=file.path.split("/").pop()!;
    return (name.toLowerCase()==="index.md"?0:2)+(name===name.toLowerCase()?0:1);
  };
  for(const file of prepared.filter(file=>file.isIndex).sort((a,b)=>rankIndex(a)-rankIndex(b)||compareText(a.sourcePath,b.sourcePath))) {
    const dir=directoryOf(file);
    if(!primaryByDirectory.has(dir))primaryByDirectory.set(dir,file);
  }
  prepared.sort((a,b)=>{
    const aDir=directoryOf(a),bDir=directoryOf(b);
    const depth=(dir:string)=>dir?dir.split("/").length:0;
    return depth(aDir)-depth(bDir)||compareText(aDir,bDir)||
      Number(primaryByDirectory.get(aDir)!==a)-Number(primaryByDirectory.get(bDir)!==b)||
      compareText(a.path,b.path)||compareText(a.sourcePath,b.sourcePath);
  });
  const nodes: MarkdownImportNode[] = [];
  const folders = new Map<string,MarkdownImportNode|null>([["",null]]);
  for(const document of prepared){
    const segments=document.path.split("/").slice(0,-1),dir=segments.join("/");
    let current="";
    for(const segment of segments){
      const next=current?`${current}/${segment}`:segment;
      if(!folders.has(next)){
        const node:MarkdownImportNode={key:`folder:${next}`,parentKey:folders.get(current)?.key??null,title:cleanSegment(segment).replace(/[-_]/g," "),published:false,blocks:[]};
        folders.set(next,node);nodes.push(node);
      }
      current=next;
    }
    const primary=primaryByDirectory.get(dir)===document;
    const existing=primary&&dir?folders.get(dir):null;
    if(existing){
      existing.title=document.title;existing.published=document.meta.published!=="false";
      existing.sourcePath=document.sourcePath;existing.blocks=document.blocks;
    }else{
      const node:MarkdownImportNode={key:`source:${document.sourcePath}`,parentKey:folders.get(dir)?.key??null,title:document.title,published:document.meta.published!=="false",sourcePath:document.sourcePath,blocks:document.blocks};
      nodes.push(node);if(primary)folders.set(dir,node);
    }
  }
  // Match createPage title normalization without changing conversion input.
  for(const node of nodes)node.title=node.title.trim()||"Untitled";
  return {name:cleanSegment(rootName)||"Imported space",notion,documents:prepared,nodes};
}
