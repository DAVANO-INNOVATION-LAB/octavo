import { parseYaml } from "./yaml";

/**
 * Turning a space's own content into a 3D model.
 *
 * The six discipline scenes shipped as presets: pretty, and identical in
 * every library. A network topology that looks the same whatever your network
 * is illustrates rather than describes. This module is what makes the block
 * describe — it produces a scene from real structure, either derived from
 * data Octavo already holds or declared on the page.
 *
 * Two sources, one output shape:
 *
 *   derived    architecture comes from the space's pages and the links
 *              between them; a pipeline comes from its connectors and the
 *              runs already recorded. Neither needs anyone to write anything.
 *   declared   a network topology, an electrode layout, a set of embedding
 *              points — things Octavo has no way to know — are written on the
 *              page in a small YAML block and read from there.
 *
 * Layout is deterministic. A model that reshuffles every render cannot be
 * referred to in prose ("the node on the left"), and a reader who returns to
 * a page expects to recognise it.
 */

export type ModelNode = {
  id: string;
  label?: string;
  /** Which cluster it belongs to — a tier, a zone, a stage. */
  group?: string;
  /** Drawn larger when it matters more: degree, replicas, magnitude. */
  weight?: number;
  /** Health, where a discipline has it. Colours the node. */
  state?: "ok" | "warn" | "fail" | "idle";
  x?: number;
  y?: number;
  z?: number;
  /**
   * Where this node lives in the library. A derived architecture node *is* a
   * page — an ADR, a design note — and showing someone a page they cannot
   * open is a dead end nothing else in the product has.
   */
  href?: string;
};

export type ModelEdge = {
  from: string;
  to: string;
  /** A dashed edge reads as weaker: optional, async, or inferred. */
  dashed?: boolean;
  label?: string;
};

/**
 * A route through the model: a request's journey, a failure path, the way
 * traffic actually flows. Colouring nodes by state says what is broken;
 * a path says how the trouble travels.
 */
export type ModelPath = {
  id: string;
  label: string;
  /** Node ids in order. Edges between consecutive members light up. */
  through: string[];
};

/**
 * One moment in a time-varying model — a recording session played back.
 * Only the nodes that change need naming; everything else holds its value.
 */
export type ModelFrame = {
  label: string;
  /** Node id → activity, 0..1. Drives size and brightness. */
  levels: Record<string, number>;
  /** Node id → state, for frames that also change health. */
  states?: Record<string, NonNullable<ModelNode["state"]>>;
};

export type ModelScene = {
  nodes: ModelNode[];
  edges: ModelEdge[];
  caption: string;
  /** Named groups in a stable order, so colours and tiers stay put. */
  groups: string[];
  paths?: ModelPath[];
  frames?: ModelFrame[];
};

const MAX_NODES = 300;

/** Deterministic pseudo-random. Same seed, same model, every time. */
export function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** A stable numeric seed from a string, so a space always lays out the same. */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Place nodes in space by group: each group gets a horizontal band, and its
 * members are spread across a ring within it. Grouped structure reads far
 * better than a force layout for the things these models describe — tiers,
 * zones, and stages are ordered, and an ordering that wanders is a lie.
 */
export function layout(scene: ModelScene): ModelScene {
  const groups = scene.groups.length
    ? scene.groups
    : [...new Set(scene.nodes.map((n) => n.group ?? ""))];
  const bandCount = Math.max(1, groups.length);
  // Bands sit a fixed distance apart rather than filling a fixed height, so
  // two groups do not float at opposite ends of an empty box.
  const spanY = Math.min(240, 110 * Math.max(1, bandCount - 1));
  const nodes = scene.nodes.map((n) => ({ ...n }));

  for (const [gi, g] of groups.entries()) {
    const members = nodes.filter((n) => (n.group ?? "") === g);
    const y = bandCount === 1 ? 0 : -spanY / 2 + (spanY * gi) / (bandCount - 1);
    const rand = seeded(seedFrom(g || "default") + gi);
    const radius = members.length <= 1 ? 0 : 60 + Math.min(120, members.length * 9);
    const swing = rand() * 0.35;
    members.forEach((n, i) => {
      if (n.x !== undefined && n.y !== undefined && n.z !== undefined) return;
      const angle = (i / Math.max(1, members.length)) * Math.PI * 2 + swing;
      n.x = Math.cos(angle) * radius;
      n.z = Math.sin(angle) * radius;
      // Neighbours are stepped apart vertically rather than jittered. A flat
      // ring reads as a disc and, worse, stacks every label on one line where
      // they collide and most are dropped; a stagger separates them.
      n.y = y + (((i % 3) - 1) * 17);
    });
  }
  return { ...scene, nodes, groups };
}

/* ────────────────────── declared models ────────────────────── */

/**
 * Read a model written on the page. Deliberately forgiving: an author is
 * describing their system, not filling in a form, so anything recognisable
 * is kept and anything unrecognisable is ignored rather than fatal.
 *
 *   nodes:
 *     - id: gw
 *       label: Gateway
 *       group: edge
 *   edges:
 *     - from: gw
 *       to: api
 */
export function parseDeclaredModel(source: string): ModelScene | null {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;

  const rawNodes = Array.isArray(d.nodes) ? d.nodes : [];
  const nodes: ModelNode[] = [];
  for (const r of rawNodes.slice(0, MAX_NODES)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = String(o.id ?? o.name ?? o.label ?? "").trim();
    if (!id) continue;
    nodes.push({
      id,
      label: o.label !== undefined ? String(o.label) : id,
      group: o.group !== undefined ? String(o.group) : o.zone !== undefined ? String(o.zone) : undefined,
      weight: Number.isFinite(Number(o.weight)) ? Number(o.weight) : undefined,
      state: asState(o.state ?? o.status),
      x: num(o.x), y: num(o.y), z: num(o.z),
      href: typeof o.href === "string" && o.href.startsWith("/") ? o.href : undefined,
    });
  }
  if (nodes.length === 0) return null;

  const known = new Set(nodes.map((n) => n.id));
  const rawEdges = Array.isArray(d.edges) ? d.edges : Array.isArray(d.links) ? d.links : [];
  const edges: ModelEdge[] = [];
  for (const r of rawEdges) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const from = String(o.from ?? o.source ?? "").trim();
    const to = String(o.to ?? o.target ?? "").trim();
    // An edge to a node that was never declared would draw into nothing.
    if (!known.has(from) || !known.has(to) || from === to) continue;
    edges.push({
      from, to,
      dashed: Boolean(o.dashed ?? o.optional ?? o.async),
      label: o.label !== undefined ? String(o.label) : undefined,
    });
  }

  const groups = [...new Set(nodes.map((n) => n.group ?? ""))].filter(Boolean);
  return layout({
    nodes,
    edges,
    caption: typeof d.caption === "string" ? d.caption : "",
    groups: groups.length ? groups : [""],
    paths: readPaths(d.paths, known),
    frames: readFrames(d.frames, known),
  });
}

/**
 * Named routes through the model. A path naming a node that does not exist
 * would light up nothing, so the reference is dropped rather than drawn; a
 * path left with fewer than two stops is not a path at all.
 */
function readPaths(raw: unknown, known: Set<string>): ModelPath[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ModelPath[] = [];
  for (const [i, r] of raw.entries()) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const list = Array.isArray(o.through) ? o.through : Array.isArray(o.nodes) ? o.nodes : [];
    const through = list.map((v) => String(v)).filter((v) => known.has(v));
    if (through.length < 2) continue;
    out.push({
      id: String(o.id ?? `path-${i + 1}`),
      label: String(o.label ?? o.name ?? `Path ${i + 1}`),
      through,
    });
  }
  return out.length ? out : undefined;
}

/**
 * Frames of a recording. Levels are clamped to 0..1 because a scale that
 * silently accepts 400 makes one frame swamp every other.
 */
function readFrames(raw: unknown, known: Set<string>): ModelFrame[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ModelFrame[] = [];
  for (const [i, r] of raw.entries()) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const levels: Record<string, number> = {};
    const src = o.levels ?? o.activity;
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (!known.has(k)) continue;
        const n = Number(v);
        if (Number.isFinite(n)) levels[k] = Math.max(0, Math.min(1, n));
      }
    }
    const states: Record<string, NonNullable<ModelNode["state"]>> = {};
    if (o.states && typeof o.states === "object") {
      for (const [k, v] of Object.entries(o.states as Record<string, unknown>)) {
        const st = asState(v);
        if (known.has(k) && st) states[k] = st;
      }
    }
    out.push({
      label: String(o.label ?? o.t ?? `Frame ${i + 1}`),
      levels,
      states: Object.keys(states).length ? states : undefined,
    });
  }
  return out.length > 1 ? out : undefined;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asState(v: unknown): ModelNode["state"] | undefined {
  const s = String(v ?? "").toLowerCase();
  if (s === "ok" || s === "success" || s === "healthy" || s === "passed") return "ok";
  if (s === "warn" || s === "warning" || s === "degraded") return "warn";
  if (s === "fail" || s === "failed" || s === "error" || s === "down") return "fail";
  if (s === "idle" || s === "pending" || s === "unknown") return "idle";
  return undefined;
}

/* ────────────────────── derived models ────────────────────── */

/**
 * Architecture from the space itself: every page is a component or a
 * decision, and the links between pages are the dependencies between them.
 *
 * This is the one that needs no authoring at all — a space of ADRs already
 * contains its own architecture diagram, it has simply never been drawn.
 * Grouping is by the page's parent, because a tree of pages is already how
 * people express "these belong together".
 */
export function architectureFromPages(input: {
  pages: { id: string; title: string; parentTitle?: string | null; href?: string }[];
  links: { from: string; to: string }[];
}): ModelScene {
  const pages = input.pages.slice(0, MAX_NODES);
  const known = new Set(pages.map((p) => p.id));
  const degree = new Map<string, number>();
  for (const l of input.links) {
    if (!known.has(l.from) || !known.has(l.to)) continue;
    degree.set(l.from, (degree.get(l.from) ?? 0) + 1);
    degree.set(l.to, (degree.get(l.to) ?? 0) + 1);
  }
  const nodes: ModelNode[] = pages.map((p) => ({
    id: p.id,
    label: p.title,
    group: p.parentTitle || "Top level",
    weight: degree.get(p.id) ?? 0,
    href: p.href,
  }));
  const edges: ModelEdge[] = input.links
    .filter((l) => known.has(l.from) && known.has(l.to) && l.from !== l.to)
    .map((l) => ({ from: l.from, to: l.to }));
  const groups = [...new Set(nodes.map((n) => n.group ?? ""))];
  return layout({
    nodes,
    edges,
    caption: `${nodes.length} pages, ${edges.length} links — this space's own shape`,
    groups,
  });
}

/**
 * A pipeline from the connectors in this space and what their runs did.
 *
 * The run log already exists; nobody has to describe the pipeline because
 * the pipeline has been describing itself every time it ran. State comes
 * from the most recent run of each connector, so the model shows the system
 * as it is rather than as it was documented.
 */
export function pipelineFromRuns(input: {
  connectors: { id: string; name: string; type: string }[];
  runs: { connectorId: string; status: string; at: number }[];
}): ModelScene {
  const latest = new Map<string, { status: string; at: number }>();
  for (const r of input.runs) {
    const prev = latest.get(r.connectorId);
    if (!prev || r.at > prev.at) latest.set(r.connectorId, { status: r.status, at: r.at });
  }
  const counts = new Map<string, number>();
  for (const r of input.runs) counts.set(r.connectorId, (counts.get(r.connectorId) ?? 0) + 1);

  const nodes: ModelNode[] = input.connectors.slice(0, MAX_NODES).map((c) => ({
    id: c.id,
    label: c.name,
    group: c.type,
    weight: counts.get(c.id) ?? 0,
    state: asState(latest.get(c.id)?.status) ?? "idle",
  }));
  // Connectors of the same type form a stage; stages chain in type order.
  const groups = [...new Set(nodes.map((n) => n.group ?? ""))];
  const edges: ModelEdge[] = [];
  for (let g = 0; g < groups.length - 1; g++) {
    const from = nodes.filter((n) => n.group === groups[g]);
    const to = nodes.filter((n) => n.group === groups[g + 1]);
    for (const a of from) for (const b of to) edges.push({ from: a.id, to: b.id, dashed: true });
  }
  const failing = nodes.filter((n) => n.state === "fail").length;
  return layout({
    nodes,
    edges,
    caption: nodes.length
      ? `${nodes.length} connectors, ${input.runs.length} runs recorded${failing ? ` — ${failing} failing` : ""}`
      : "No connectors in this space yet",
    groups,
  });
}


/* ────────────────────── points from data ────────────────────── */

/**
 * An embedding read from a file rather than typed out.
 *
 * Declaring points by hand is fine for five clusters and useless for five
 * thousand, which is the size at which an embedding is worth looking at.
 * CSV, TSV and JSON all arrive here; the column names are the ones people
 * already use, and anything unrecognisable is skipped rather than fatal.
 *
 * Coordinates are normalised into the same box the layout uses, so a file in
 * any units at all lands at a sensible size.
 */
export function pointsFromTable(text: string, caption = ""): ModelScene | null {
  const rows = text.trim().startsWith("[") || text.trim().startsWith("{")
    ? jsonRows(text)
    : delimitedRows(text);
  if (!rows || rows.length === 0) return null;

  const raw: { id: string; label?: string; group?: string; x: number; y: number; z: number }[] = [];
  for (const [i, r] of rows.entries()) {
    if (raw.length >= MAX_NODES) break;
    const x = pick(r, ["x", "x0", "dim1", "d1", "pc1", "tsne1", "umap1"]);
    const y = pick(r, ["y", "x1", "dim2", "d2", "pc2", "tsne2", "umap2"]);
    if (x === undefined || y === undefined) continue;
    const z = pick(r, ["z", "x2", "dim3", "d3", "pc3", "tsne3", "umap3"]) ?? 0;
    const label = str(r, ["label", "name", "title", "text", "token"]);
    raw.push({
      id: str(r, ["id"]) || label || `p${i + 1}`,
      label,
      group: str(r, ["group", "cluster", "class", "category", "label_id"]) || undefined,
      x, y, z,
    });
  }
  if (raw.length === 0) return null;

  // Normalise into the layout's own box so any units land at a usable size.
  const span = (get: (p: (typeof raw)[number]) => number) => {
    const vs = raw.map(get);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    return { lo, range: hi - lo || 1 };
  };
  const sx = span((p) => p.x), sy = span((p) => p.y), sz = span((p) => p.z);
  const to = (v: number, s: { lo: number; range: number }) => ((v - s.lo) / s.range - 0.5) * 240;

  const nodes: ModelNode[] = raw.map((p) => ({
    id: p.id,
    label: p.label,
    group: p.group,
    x: to(p.x, sx),
    y: to(p.y, sy),
    z: to(p.z, sz),
  }));
  const groups = [...new Set(nodes.map((n) => n.group ?? ""))].filter(Boolean);
  const clusters = groups.length;
  return {
    nodes,
    edges: [],
    groups: groups.length ? groups : [""],
    caption:
      caption ||
      `${nodes.length} points${clusters ? ` in ${clusters} cluster${clusters === 1 ? "" : "s"}` : ""}`,
  };
}

function jsonRows(text: string): Record<string, unknown>[] | null {
  try {
    const v = JSON.parse(text);
    const arr = Array.isArray(v) ? v : Array.isArray((v as { points?: unknown }).points) ? (v as { points: unknown[] }).points : null;
    if (!arr) return null;
    return arr.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
  } catch {
    return null;
  }
}

/** CSV or TSV, delimiter inferred from the header. Quoted fields respected. */
function delimitedRows(text: string): Record<string, unknown>[] | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const delim = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  const header = splitRow(lines[0], delim).map((h) => h.trim().toLowerCase());
  const out: Record<string, unknown>[] = [];
  for (const line of lines.slice(1, MAX_NODES + 1)) {
    const cells = splitRow(line, delim);
    const row: Record<string, unknown> = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    out.push(row);
  }
  return out;
}

function splitRow(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function pick(row: Record<string, unknown>, names: string[]): number | undefined {
  for (const n of names) {
    if (row[n] === undefined || row[n] === "") continue;
    const v = Number(row[n]);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

function str(row: Record<string, unknown>, names: string[]): string {
  for (const n of names) {
    const v = row[n];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}
