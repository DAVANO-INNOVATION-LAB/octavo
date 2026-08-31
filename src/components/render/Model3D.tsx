"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { ModelScene } from "@/lib/model-data";

// A dependency-free 3D model block. Same projection engine as the knowledge
// graph: nodes in space, perspective projection, orbit by dragging.
//
// The scene can come from three places. A preset draws the discipline's
// generic shape, which is decoration and says so. A declared model is written
// on the page for the things Octavo cannot know — a network, an electrode
// array, a set of embedding points. A space-derived model is built from the
// space's own pages, links, connectors and runs, and needs no authoring at
// all: a space of design notes already contains its architecture diagram, it
// has simply never been drawn.

export type ModelKind =
  | "architecture"
  | "network"
  | "pipeline"
  | "culture"
  | "molecule"
  | "embedding";

type Node = {
  x: number; y: number; z: number;
  label?: string;
  size: number;
  tone: "accent" | "ink" | "muted";
};
type Edge = { a: number; b: number; dashed?: boolean };
type Scene = { nodes: Node[]; edges: Edge[]; caption: string };

const N = (
  x: number, y: number, z: number,
  label: string | undefined,
  size = 8,
  tone: Node["tone"] = "ink"
): Node => ({ x, y, z, label, size, tone });

/** Deterministic pseudo-random so a scene looks the same for everyone. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function buildScene(kind: ModelKind): Scene {
  const r = seeded(7);
  switch (kind) {
    case "architecture": {
      // Tiers stacked in depth: edge, services, data.
      const nodes = [
        N(0, -120, 0, "Client", 9, "muted"),
        N(0, -62, 0, "Gateway", 11, "accent"),
        N(-115, 4, -45, "Auth", 9),
        N(5, 4, 10, "API", 11, "accent"),
        N(120, 4, 45, "Worker", 9),
        N(-100, 92, -30, "Postgres", 10, "muted"),
        N(105, 92, 30, "Queue", 10, "muted"),
        N(0, 108, -95, "Object store", 9, "muted"),
      ];
      const edges = [
        { a: 0, b: 1 }, { a: 1, b: 2 }, { a: 1, b: 3 }, { a: 3, b: 2 },
        { a: 3, b: 4 }, { a: 3, b: 5 }, { a: 4, b: 6 }, { a: 4, b: 7 },
        { a: 6, b: 4, dashed: true },
      ];
      return { nodes, edges, caption: "Service topology — drag to orbit" };
    }
    case "network": {
      // Core, distribution, access, hosts.
      const nodes = [N(0, -100, 0, "WAN", 10, "muted"), N(0, -45, 0, "Firewall", 11, "accent"), N(0, 5, 0, "Core", 12, "accent")];
      const edges: Edge[] = [{ a: 0, b: 1 }, { a: 1, b: 2 }];
      const dist = [-90, 0, 90];
      dist.forEach((x, i) => {
        nodes.push(N(x, 60, i === 1 ? -60 : 40, `VLAN ${10 * (i + 1)}`, 9));
        edges.push({ a: 2, b: nodes.length - 1 });
        for (let h = 0; h < 3; h++) {
          nodes.push(N(x + (h - 1) * 34, 112, (i === 1 ? -60 : 40) + (h - 1) * 22, undefined, 4.5, "muted"));
          edges.push({ a: nodes.length - 2 - h * 0, b: nodes.length - 1 });
        }
      });
      return { nodes, edges, caption: "Network topology — drag to orbit" };
    }
    case "pipeline": {
      // A left-to-right delivery pipeline with a fan-out.
      const stages = ["Commit", "Build", "Test", "Stage", "Prod"];
      const nodes = stages.map((s, i) =>
        N(-150 + i * 75, 0, 0, s, i === stages.length - 1 ? 12 : 9, i === stages.length - 1 ? "accent" : "ink")
      );
      const edges: Edge[] = stages.slice(1).map((_, i) => ({ a: i, b: i + 1 }));
      // parallel test lanes
      ["unit", "integration", "lint"].forEach((t, i) => {
        nodes.push(N(0, -60 + i * 60, -55, t, 6, "muted"));
        edges.push({ a: 1, b: nodes.length - 1 });
        edges.push({ a: nodes.length - 1, b: 3, dashed: true });
      });
      return { nodes, edges, caption: "Delivery pipeline — drag to orbit" };
    }
    case "culture": {
      // A multi-electrode array with a neural culture above it.
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++)
          nodes.push(N(-100 + i * 40, 95, -100 + j * 40, undefined, 3.5, "muted"));
      const cellStart = nodes.length;
      for (let c = 0; c < 22; c++) {
        const a = r() * Math.PI * 2;
        const rad = 30 + r() * 80;
        nodes.push(N(Math.cos(a) * rad, -40 + (r() - 0.5) * 90, Math.sin(a) * rad, undefined, 5 + r() * 4, c % 5 === 0 ? "accent" : "ink"));
      }
      for (let c = cellStart; c < nodes.length; c++) {
        const t = cellStart + Math.floor(r() * (nodes.length - cellStart));
        if (t !== c) edges.push({ a: c, b: t });
        if (r() > 0.55) edges.push({ a: c, b: Math.floor(r() * cellStart), dashed: true });
      }
      return { nodes, edges, caption: "Culture over a 6×6 electrode array — drag to orbit" };
    }
    case "molecule": {
      // A double helix.
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      const turns = 2.2, steps = 26;
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2 * turns;
        const y = -120 + (i / steps) * 240;
        nodes.push(N(Math.cos(t) * 60, y, Math.sin(t) * 60, undefined, 6, "accent"));
        nodes.push(N(Math.cos(t + Math.PI) * 60, y, Math.sin(t + Math.PI) * 60, undefined, 6, "ink"));
        const a = nodes.length - 2, b = nodes.length - 1;
        edges.push({ a, b, dashed: true });
        if (i > 0) {
          edges.push({ a: a - 2, b: a });
          edges.push({ a: b - 2, b });
        }
      }
      return { nodes, edges, caption: "Double helix — drag to orbit" };
    }
    case "embedding":
    default: {
      // Three clusters in embedding space.
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      const centers = [
        [-90, -40, -40], [80, 20, 30], [-10, 90, 60],
      ];
      centers.forEach((c, ci) => {
        const anchor = nodes.length;
        nodes.push(N(c[0], c[1], c[2], `cluster ${ci + 1}`, 10, "accent"));
        for (let i = 0; i < 12; i++) {
          nodes.push(
            N(c[0] + (r() - 0.5) * 90, c[1] + (r() - 0.5) * 90, c[2] + (r() - 0.5) * 90, undefined, 4 + r() * 3, "muted")
          );
          edges.push({ a: anchor, b: nodes.length - 1, dashed: true });
        }
      });
      return { nodes, edges, caption: "Embedding space — drag to orbit" };
    }
  }
}

/**
 * Turn a real scene into drawable nodes. Weight becomes size so the things
 * that matter are the things you notice, and state becomes tone so a failing
 * stage is visible without reading a label.
 */
function fromScene(model: ModelScene): Scene {
  const index = new Map(model.nodes.map((n, i) => [n.id, i]));
  const weights = model.nodes.map((n) => n.weight ?? 0);
  const top = Math.max(1, ...weights);
  const nodes: Node[] = model.nodes.map((n) => ({
    x: n.x ?? 0,
    y: n.y ?? 0,
    z: n.z ?? 0,
    label: n.label,
    size: 5 + Math.round(((n.weight ?? 0) / top) * 7),
    tone:
      n.state === "fail" || n.state === "warn"
        ? "accent"
        : n.state === "idle"
          ? "muted"
          : (n.weight ?? 0) >= top * 0.6
            ? "accent"
            : "ink",
  }));
  const edges: Edge[] = [];
  for (const e of model.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined) continue;
    edges.push({ a, b, dashed: e.dashed });
  }
  return { nodes, edges, caption: model.caption || "Drag to orbit" };
}

export function Model3D({
  kind,
  title,
  height = 340,
  scene: given,
  /** Where to fetch a space-derived scene, for the editor's live preview. */
  fetchFrom,
}: {
  kind: ModelKind;
  title?: string;
  height?: number;
  scene?: ModelScene | null;
  fetchFrom?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hint, setHint] = useState("");
  const [fetched, setFetched] = useState<{ url: string; scene: ModelScene } | null>(null);
  const resetRef = useRef<() => void>(() => {});

  // A space-derived scene is resolved on the server, so the editor asks for
  // it rather than deriving it — the client never learns about pages that
  // the person editing may not read.
  useEffect(() => {
    if (!fetchFrom) return;
    let live = true;
    fetch(fetchFrom)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setFetched(j && j.nodes ? { url: fetchFrom, scene: j as ModelScene } : null); })
      .catch(() => { if (live) setFetched(null); });
    return () => { live = false; };
  }, [fetchFrom]);
  // Keyed by the URL it came from, so a stale scene is never drawn against a
  // block that has since changed where it reads from.
  const derived = fetchFrom && fetched?.url === fetchFrom ? fetched.scene : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const model = given ?? derived;
    // An empty derived scene falls back to the preset: a space with no links
    // yet should show what the block is for, not an empty box.
    const scene = model && model.nodes.length > 0 ? fromScene(model) : buildScene(kind);
    setHint(scene.caption);

    const dpr = window.devicePixelRatio || 1;
    let W = 0, H = 0, fit = 1;

    const FOCAL = 820, CAM = 640;

    /**
     * Scale the scene so it stays inside the stage.
     *
     * The presets were drawn to fit a 340px box. A derived scene has no such
     * courtesy — a space with forty pages spreads much wider than one with
     * four — and without this its outer nodes simply leave the frame while
     * their edges run off the corner. Because perspective magnifies whatever
     * is nearest the camera, the fit cannot be computed in closed form, so it
     * is measured: project the scene as it will actually be drawn, at several
     * points in its own rotation, and shrink until the widest of them lands
     * inside. Three passes is enough to converge.
     */
    const measureFit = () => {
      if (!W || !H) return 1;
      // Room for a label, which sits above its node and runs wider than it.
      // A label sits above its node and runs wider than it, so the margins
      // are the label's, not the dot's.
      const halfW = W / 2 - 26, halfH = H / 2 - 28;
      if (halfW <= 0 || halfH <= 0) return 1;
      let f = 1;
      for (let pass = 0; pass < 3; pass++) {
        let worst = 0;
        for (let a = 0; a < 8; a++) {
          const yy = (a / 8) * Math.PI * 2;
          const cy2 = Math.cos(yy), sy2 = Math.sin(yy);
          const cp2 = Math.cos(-0.2), sp2 = Math.sin(-0.2);
          for (const n of scene.nodes) {
            const nx = n.x * f, ny = n.y * f, nz = n.z * f;
            const x1 = nx * cy2 - nz * sy2;
            const z1 = nx * sy2 + nz * cy2;
            const y2 = ny * cp2 - z1 * sp2;
            const z2 = ny * sp2 + z1 * cp2;
            const sc = FOCAL / Math.max(120, CAM + z2);
            worst = Math.max(worst, Math.abs(x1 * sc) / halfW, Math.abs(y2 * sc) / halfH);
          }
        }
        if (worst <= 1.001) break;
        f /= worst;
      }
      return f;
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      W = rect.width; H = rect.height;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fit = measureFit();
    };
    resize();
    window.addEventListener("resize", resize);

    let yaw = 0.5, pitch = -0.2;
    let spin = 0.0022;
    let dragging = false;
    let last = { x: 0, y: 0 };
    let raf = 0;

    const style = getComputedStyle(document.documentElement);
    const read = (v: string, fb: string) => style.getPropertyValue(v).trim() || fb;

    const frame = () => {
      if (!dragging && spin) yaw += spin;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const proj = scene.nodes.map((n) => {
        const nx = n.x * fit, ny = n.y * fit, nz = n.z * fit;
        const x1 = nx * cy - nz * sy;
        const z1 = nx * sy + nz * cy;
        const y2 = ny * cp - z1 * sp;
        const z2 = ny * sp + z1 * cp;
        const scale = FOCAL / (CAM + z2);
        return { sx: W / 2 + x1 * scale, sy: H / 2 + y2 * scale, scale, depth: z2, n };
      });

      const ink = read("--ink", "#211c13");
      const line = read("--line-strong", "#cfc6ae");
      const accent = read("--accent", "#b8401b");
      const muted = read("--muted", "#6f6553");
      ctx.clearRect(0, 0, W, H);

      ctx.lineWidth = 1;
      for (const e of scene.edges) {
        const a = proj[e.a], b = proj[e.b];
        if (!a || !b) continue;
        const t = Math.max(0, Math.min(1, (CAM * 0.5 - (a.depth + b.depth) / 2) / (CAM * 0.9)));
        ctx.strokeStyle = line;
        ctx.globalAlpha = 0.12 + t * 0.4;
        ctx.setLineDash(e.dashed ? [3, 4] : []);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const byDepth = [...proj].sort((x, y) => y.depth - x.depth);
      for (const p of byDepth) {
        const t = Math.max(0, Math.min(1, (CAM * 0.5 - p.depth) / (CAM * 0.9)));
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, Math.max(1.5, p.n.size * p.scale), 0, Math.PI * 2);
        ctx.fillStyle = p.n.tone === "accent" ? accent : p.n.tone === "muted" ? muted : ink;
        ctx.globalAlpha = 0.3 + t * 0.6;
        ctx.fill();
      }

      // Labels last, nearest first, and a label that would land on one
      // already drawn is dropped. A derived model has as many labels as the
      // space has pages; printed all at once they overlap into a smear, and
      // the reader loses the few they could otherwise have read. Nearest wins
      // because that is the node the reader is looking at.
      ctx.textAlign = "center";
      const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
      for (const p of byDepth.slice().reverse()) {
        if (!p.n.label) continue;
        const t = Math.max(0, Math.min(1, (CAM * 0.5 - p.depth) / (CAM * 0.9)));
        const size = Math.max(9, 11 * p.scale);
        ctx.font = `500 ${size}px ui-sans-serif, system-ui, sans-serif`;
        const w = ctx.measureText(p.n.label).width;
        const cx = p.sx;
        const cy = p.sy - p.n.size * p.scale - 9;
        const box = { x1: cx - w / 2 - 3, y1: cy - size, x2: cx + w / 2 + 3, y2: cy + 3 };
        if (placed.some((q) => box.x1 < q.x2 && box.x2 > q.x1 && box.y1 < q.y2 && box.y2 > q.y1))
          continue;
        placed.push(box);
        ctx.globalAlpha = 0.35 + t * 0.55;
        ctx.fillStyle = p.n.tone === "accent" ? accent : ink;
        ctx.fillText(p.n.label, cx, cy);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    resetRef.current = () => { yaw = 0.5; pitch = -0.2; spin = 0.0022; };

    const down = (e: PointerEvent) => {
      dragging = true; spin = 0; last = { x: e.clientX, y: e.clientY };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      canvas.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yaw += (e.clientX - last.x) * 0.007;
      pitch = Math.max(-1.2, Math.min(1.2, pitch + (e.clientY - last.y) * 0.005));
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => { dragging = false; canvas.style.cursor = "grab"; };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", up);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", up);
    };
  }, [kind, given, derived]);

  return (
    <figure className="blk-model">
      {title && <figcaption className="blk-model-title">{title}</figcaption>}
      <div className="blk-model-stage" style={{ height }}>
        <canvas ref={canvasRef} className="h-full w-full touch-none select-none" />
        <button
          onClick={() => resetRef.current()}
          className="blk-model-reset"
          title="Reset the view"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      <figcaption className="blk-model-hint">{hint}</figcaption>
    </figure>
  );
}
