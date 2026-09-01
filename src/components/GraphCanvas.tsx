"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Search, X } from "lucide-react";
import type { GraphData } from "@/lib/data";

type Node = GraphData["nodes"][number] & {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  sx: number; sy: number; scale: number; depth: number;
};

/**
 * A 3D force-directed link graph on plain canvas — no WebGL, no dependency.
 *
 * The layout settles and then FREEZES, so nodes stay still and are easy to
 * click. Dragging empty space orbits the camera; dragging a node moves it;
 * clicking a node opens the page. "Reheat" restarts the simulation.
 */
export function GraphCanvas({ graph }: { graph: GraphData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const router = useRouter();
  const [hoverTitle, setHoverTitle] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const reheatRef = useRef<() => void>(() => {});

  const allSpaces = useMemo(
    () => [...new Set(graph.nodes.map((n) => n.space))].sort(),
    [graph]
  );
  /** Empty means "all" — so a new space appearing is included by default. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [clickMode, setClickMode] = useState<"open" | "focus">("open");

  /**
   * Filtering rebuilds the layout — a deliberate act, and the graph should
   * re-settle around what is left. Searching and focusing do NOT: they are
   * read from refs inside the draw loop, so the shape stays put under you.
   */
  const shown = useMemo(() => {
    if (hidden.size === 0) return graph;
    const nodes = graph.nodes.filter((n) => !hidden.has(n.space));
    const keep = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
  }, [graph, hidden]);

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of shown.edges) {
      if (!m.has(e.from)) m.set(e.from, new Set());
      if (!m.has(e.to)) m.set(e.to, new Set());
      m.get(e.from)!.add(e.to);
      m.get(e.to)!.add(e.from);
    }
    return m;
  }, [shown]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      shown.nodes
        .filter((n) => n.title.toLowerCase().includes(q) || n.space.toLowerCase().includes(q))
        .map((n) => n.id)
    );
  }, [query, shown]);

  // Refs so the animation loop sees the current values without restarting.
  const matchRef = useRef<Set<string> | null>(null);
  const focusRef = useRef<Set<string> | null>(null);
  const modeRef = useRef<"open" | "focus">("open");
  // Written in an effect, not during render: the draw loop reads them on the
  // next frame either way, and assigning during render is a lint error and a
  // concurrent-rendering hazard.
  useEffect(() => {
    matchRef.current = matches;
  }, [matches]);
  useEffect(() => {
    modeRef.current = clickMode;
  }, [clickMode]);
  useEffect(() => {
    focusRef.current = focusId
      ? new Set([focusId, ...(neighbours.get(focusId) ?? [])])
      : null;
  }, [focusId, neighbours]);

  const spaces = allSpaces;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let W = 0;
    let H = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      W = rect.width;
      H = rect.height;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // Deterministic scatter in a sphere.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const R = Math.min(W, H) * 0.3;
    const nodes: Node[] = shown.nodes.map((n) => ({
      ...n,
      x: (rand() - 0.5) * R * 2,
      y: (rand() - 0.5) * R * 2,
      z: (rand() - 0.5) * R * 2,
      vx: 0, vy: 0, vz: 0,
      sx: 0, sy: 0, scale: 1, depth: 0,
    }));
    const index = new Map(nodes.map((n) => [n.id, n]));
    const edges = graph.edges
      .map((e) => ({ a: index.get(e.from)!, b: index.get(e.to)! }))
      .filter((e) => e.a && e.b);

    // Ideal edge length for this many nodes in this much volume.
    const k = Math.max(
      46,
      Math.cbrt((Math.min(W, H) ** 3) / Math.max(1, nodes.length)) * 1.15
    );

    // Camera
    let yaw = 0.6;
    let pitch = -0.25;
    const FOCAL = 900;
    const CAM = 1000;

    let alpha = 1;
    let running = true;
    let dragNode: Node | null = null;
    let orbiting = false;
    let hover: Node | null = null;
    let last = { x: 0, y: 0 };
    let moved = 0;
    let spin = 0.0016; // gentle idle rotation, stops on interaction
    let raf = 0;

    const project = () => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (const n of nodes) {
        // rotate: yaw around Y, then pitch around X
        const x1 = n.x * cy - n.z * sy;
        const z1 = n.x * sy + n.z * cy;
        const y2 = n.y * cp - z1 * sp;
        const z2 = n.y * sp + z1 * cp;
        const scale = FOCAL / (CAM + z2);
        n.sx = W / 2 + x1 * scale;
        n.sy = H / 2 + y2 * scale;
        n.scale = scale;
        n.depth = z2;
      }
    };

    const step = () => {
      // repulsion (3D inverse-square)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1) { d2 = 1; dx = rand(); dy = rand(); dz = rand(); }
          const d = Math.sqrt(d2);
          const f = (k * k * alpha) / d2;
          a.vx -= (dx / d) * f; a.vy -= (dy / d) * f; a.vz -= (dz / d) * f;
          b.vx += (dx / d) * f; b.vy += (dy / d) * f; b.vz += (dz / d) * f;
        }
      }
      // springs
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, dz = e.b.z - e.a.z;
        const d = Math.max(1, Math.hypot(dx, dy, dz));
        const f = ((d - k) / k) * 5 * alpha;
        e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f; e.a.vz += (dz / d) * f;
        e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f; e.b.vz -= (dz / d) * f;
      }
      // gravity toward origin + integrate
      const bound = Math.min(W, H) * 0.44;
      for (const n of nodes) {
        if (n === dragNode) continue;
        n.vx += -n.x * 0.004 * alpha;
        n.vy += -n.y * 0.004 * alpha;
        n.vz += -n.z * 0.004 * alpha;
        n.vx *= 0.84; n.vy *= 0.84; n.vz *= 0.84;
        const sp2 = Math.hypot(n.vx, n.vy, n.vz);
        if (sp2 > 20) { n.vx = (n.vx / sp2) * 20; n.vy = (n.vy / sp2) * 20; n.vz = (n.vz / sp2) * 20; }
        n.x += n.vx; n.y += n.vy; n.z += n.vz;
        const r = Math.hypot(n.x, n.y, n.z);
        if (r > bound) { const s = bound / r; n.x *= s; n.y *= s; n.z *= s; }
      }
      alpha *= 0.975;
      // Freeze once it has settled — a still graph is a clickable graph,
      // and that means stopping the idle rotation too.
      if (alpha < 0.02) {
        alpha = 0;
        running = false;
        spin = 0;
        setSettled(true);
      }
    };

    const style = getComputedStyle(document.documentElement);
    const read = (v: string, fb: string) => style.getPropertyValue(v).trim() || fb;

    const draw = () => {
      const ink = read("--ink", "#211c13");
      const line = read("--line-strong", "#cfc6ae");
      const accent = read("--accent", "#b8401b");
      ctx.clearRect(0, 0, W, H);

      // Search and focus are lenses, not filters: everything stays on
      // screen so you keep your bearings, but what you asked for is lit
      // and the rest recedes. Read from refs so neither restarts the layout.
      const lit = matchRef.current;
      const near = focusRef.current;
      const prominence = (id: string) => {
        if (near && !near.has(id)) return 0.08;
        if (lit && !lit.has(id)) return 0.12;
        return 1;
      };

      // edges first, dimmed by depth
      ctx.lineWidth = 1;
      for (const e of edges) {
        const mid = (e.a.depth + e.b.depth) / 2;
        const t = Math.max(0, Math.min(1, (CAM * 0.5 - mid) / (CAM * 0.9)));
        const touches = hover && (e.a === hover || e.b === hover);
        const lens = Math.min(prominence(e.a.id), prominence(e.b.id));
        ctx.strokeStyle = touches ? accent : line;
        ctx.globalAlpha = (touches ? 0.75 : 0.14 + t * 0.34) * lens;
        ctx.beginPath();
        ctx.moveTo(e.a.sx, e.a.sy);
        ctx.lineTo(e.b.sx, e.b.sy);
        ctx.stroke();
      }

      // nodes back-to-front so near ones overlap far ones
      const order = [...nodes].sort((a, b) => b.depth - a.depth);
      for (const n of order) {
        const base = Math.min(11, 3.6 + n.degree * 1.05);
        const r = base * n.scale;
        const isHover = hover === n;
        const lens = prominence(n.id);
        const isLit = (lit?.has(n.id) ?? false) || (near?.has(n.id) ?? false);
        const t = Math.max(0, Math.min(1, (CAM * 0.5 - n.depth) / (CAM * 0.9)));
        ctx.beginPath();
        ctx.arc(n.sx, n.sy, Math.max(1.6, r), 0, Math.PI * 2);
        ctx.fillStyle = isHover || isLit ? accent : ink;
        ctx.globalAlpha = (isHover ? 1 : 0.32 + t * 0.55) * lens;
        ctx.fill();
        if (isHover || isLit) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(n.sx, n.sy, Math.max(1.6, r) + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        // label only the well-connected and the hovered — depth-faded
        if (isHover || isLit || n.degree > 3) {
          ctx.globalAlpha = (isHover || isLit ? 1 : 0.3 + t * 0.5) * lens;
          ctx.fillStyle = isHover || isLit ? accent : ink;
          ctx.font = `${isHover ? 600 : 400} ${Math.max(9, 11 * n.scale)}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = "center";
          const label = n.title.length > 30 ? n.title.slice(0, 29) + "…" : n.title;
          ctx.fillText(label, n.sx, n.sy - r - 6);
        }
      }
      ctx.globalAlpha = 1;
    };

    const frame = () => {
      if (running) step();
      if (!orbiting && !dragNode && spin) yaw += spin;
      project();
      draw();
      raf = requestAnimationFrame(frame);
    };
    project();
    raf = requestAnimationFrame(frame);

    reheatRef.current = () => {
      alpha = 0.9;
      running = true;
      spin = 0.0016;
      setSettled(false);
    };

    // ---- interaction ----
    const pick = (cx: number, cy: number): Node | null => {
      const rect = canvas.getBoundingClientRect();
      const x = cx - rect.left;
      const y = cy - rect.top;
      let best: Node | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        const r = Math.max(9, Math.min(11, 3.6 + n.degree * 1.05) * n.scale + 7);
        const d = Math.hypot(n.sx - x, n.sy - y);
        // nearest to the camera wins ties
        if (d < r && (d < bestD || (Math.abs(d - bestD) < 6 && n.depth < (best?.depth ?? Infinity)))) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    const onMove = (e: PointerEvent) => {
      if (dragNode) {
        // move the node in the camera plane
        const dx = (e.clientX - last.x) / dragNode.scale;
        const dy = (e.clientY - last.y) / dragNode.scale;
        const cy2 = Math.cos(-yaw), sy2 = Math.sin(-yaw);
        dragNode.x += dx * cy2;
        dragNode.z += dx * sy2;
        dragNode.y += dy;
        dragNode.vx = dragNode.vy = dragNode.vz = 0;
        last = { x: e.clientX, y: e.clientY };
        moved += Math.abs(dx) + Math.abs(dy);
        return;
      }
      if (orbiting) {
        yaw += (e.clientX - last.x) * 0.006;
        pitch = Math.max(-1.2, Math.min(1.2, pitch + (e.clientY - last.y) * 0.005));
        moved += Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y);
        last = { x: e.clientX, y: e.clientY };
        return;
      }
      spin = 0; // the reader is aiming at something — hold still
      const n = pick(e.clientX, e.clientY);
      if (n !== hover) {
        hover = n;
        setHoverTitle(n ? `${n.title} — ${n.space}` : null);
        canvas.style.cursor = n ? "pointer" : "grab";
      }
    };

    const onDown = (e: PointerEvent) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer */
      }
      spin = 0; // stop idle rotation the moment the reader engages
      moved = 0;
      last = { x: e.clientX, y: e.clientY };
      const n = pick(e.clientX, e.clientY);
      if (n) dragNode = n;
      else { orbiting = true; canvas.style.cursor = "grabbing"; }
    };

    const onUp = () => {
      const wasNode = dragNode;
      dragNode = null;
      orbiting = false;
      canvas.style.cursor = hover ? "pointer" : "grab";
      // A click is a press that barely moved — then open the page.
      if (wasNode && moved < 5) {
        if (modeRef.current === "focus") setFocusId((f) => (f === wasNode.id ? null : wasNode.id));
        else router.push(wasNode.href);
      }
    };

    const onLeave = () => {
      hover = null;
      setHoverTitle(null);
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [shown, router]);

  const matchCount = matches?.size ?? 0;
  const focusTitle = focusId
    ? shown.nodes.find((n) => n.id === focusId)?.title ?? null
    : null;

  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter opens the single best match — locate, then go.
              if (e.key !== "Enter" || !matches?.size) return;
              const first = shown.nodes.find((n) => matches.has(n.id));
              if (first) router.push(first.href);
            }}
            placeholder="Find a page…"
            className="h-8 w-52 rounded-md border border-line bg-bg pl-7 pr-2 text-xs text-ink outline-none placeholder:text-faint focus:border-accent"
          />
        </span>
        {query.trim() !== "" && (
          <span className="text-xs text-faint">
            {matchCount === 0
              ? "no match"
              : `${matchCount} lit${matchCount === 1 ? " · Enter opens it" : ""}`}
          </span>
        )}

        <button
          onClick={() => {
            setClickMode((m) => (m === "open" ? "focus" : "open"));
            setFocusId(null);
          }}
          className={`h-8 rounded-md border px-2.5 text-xs transition-colors ${
            clickMode === "focus"
              ? "border-accent bg-accent-soft text-accent"
              : "border-line text-muted hover:text-ink"
          }`}
          title="What a click does"
        >
          Click to {clickMode === "focus" ? "focus" : "open"}
        </button>

        {focusTitle && (
          <button
            onClick={() => setFocusId(null)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-2.5 text-xs text-accent"
          >
            <X size={12} />
            Focused on {focusTitle.length > 24 ? focusTitle.slice(0, 23) + "…" : focusTitle}
          </button>
        )}

        {allSpaces.length > 1 && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {allSpaces.map((sp) => {
              const on = !hidden.has(sp);
              return (
                <button
                  key={sp}
                  onClick={() =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (next.has(sp)) next.delete(sp);
                      else next.add(sp);
                      // Hiding everything shows nothing and reads as a bug;
                      // the last visible space stays visible.
                      return next.size >= allSpaces.length ? h : next;
                    })
                  }
                  className={`h-7 rounded-full border px-2.5 text-[11px] transition-colors ${
                    on
                      ? "border-line-strong text-ink"
                      : "border-line text-faint line-through"
                  }`}
                >
                  {sp}
                </button>
              );
            })}
          </span>
        )}
      </div>

      {/* The canvas is a picture; this is the same information as content.
          It gives a screen reader something to read and a keyboard user
          somewhere to go — a graph you can only reach with a pointer is a
          graph most people cannot reach at all. */}
      <ul className="sr-only">
        {graph.nodes.map((n) => (
          <li key={n.id}>
            <a href={n.href}>
              {n.title} — in {n.space}
            </a>
          </li>
        ))}
      </ul>

      <div className="relative overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Knowledge graph: ${graph.nodes.length} pages and ${graph.edges.length} links between them. The same pages are listed below this figure.`}
          className="h-[62vh] w-full touch-none select-none"
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3">
          <span className="rounded-md bg-bg/85 px-2 py-1 text-xs text-muted backdrop-blur">
            {hoverTitle ??
              (settled
                ? `Drag to orbit · click a page to ${clickMode === "focus" ? "focus its neighbourhood" : "open it"}`
                : "Finding the shape…")}
          </span>
          <button
            onClick={() => reheatRef.current()}
            className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-line bg-bg/85 px-2.5 py-1 text-xs text-muted backdrop-blur transition-colors hover:text-ink"
          >
            <RotateCcw size={12} />
            Reheat
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-faint">
        {spaces.length} {spaces.length === 1 ? "space" : "spaces"} represented ·
        node size follows how often a page is linked · depth is real: nearer
        pages are brighter
      </p>
    </div>
  );
}
