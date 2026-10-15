/** Bounded CSV snapshots from Grafana, GPU tools, and other metric exporters. */
export function benchmarkRows(csv: string): string[][] {
  if (csv.length > 1_000_000) throw new Error("CSV must be under 1 MB");
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  csv = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || !field) quoted = !quoted;
      else throw new Error("Invalid CSV quotation");
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      row.push(field); field = "";
      if (row.length > 24) throw new Error("Use at most 24 columns");
      if (c !== ",") {
        if (c === "\r" && csv[i + 1] === "\n") i++;
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (rows.length > 501) throw new Error("Use at most 500 data rows");
      }
    } else field += c;
    if (field.length > 4000) throw new Error("A cell exceeds 4,000 characters");
  }
  if (quoted) throw new Error("Unclosed CSV quotation");
  if (field || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2 || rows.length > 501) throw new Error("Include a header and 1–500 data rows");
  const width = rows[0].length;
  if (width < 2 || width > 24 || rows.some(r => r.length !== width)) throw new Error("CSV rows must have 2–24 matching columns");
  if (rows[0].some(h => !h.trim())) throw new Error("Every column needs a header");
  return rows;
}

export function benchmarkSource(raw: string): string {
  if (!raw.trim()) return "";
  const url = new URL(raw.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) dashboard link without embedded credentials");
  return url.href;
}
