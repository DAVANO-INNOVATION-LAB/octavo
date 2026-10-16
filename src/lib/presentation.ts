import type { Block } from "./blocks";

/** Top-level headings and explicit page breaks define editable slides. */
export function presentationSections(blocks: Block[]): Block[][] {
  const slides: Block[][] = [];
  let current: Block[] = [];
  for (const block of blocks) {
    const boundary = block.type === "pageBreak" || (block.type === "heading" && Number(block.props.level ?? 1) <= 2);
    if (boundary && current.length) { slides.push(current); current = []; }
    if (block.type !== "pageBreak") current.push(block);
  }
  if (current.length) slides.push(current);
  return slides;
}
