/** Compare Markdown-compatible block meaning, ignoring identity and harmless
 * default display properties. Unknown/custom properties remain significant. */
export function repoSemantic(value: unknown): string {
  const normalize = (v: unknown, parentKey = ""): unknown => {
    if (Array.isArray(v)) return v.map(x => normalize(x));
    if (!v || typeof v !== "object") return v;
    const entries = Object.entries(v).filter(([key,value]) => {
      if (key === "id" && "type" in v && "children" in v) return false;
      if (parentKey === "props" && ((["backgroundColor","textColor"].includes(key) && value === "default") || (key === "textAlignment" && value === "left"))) return false;
      return true;
    }).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,normalize(value,key)]);
    return Object.fromEntries(entries.filter(([key,value]) => !(key === "props" && value && typeof value === "object" && Object.keys(value).length === 0)));
  };
  return JSON.stringify(normalize(value));
}
