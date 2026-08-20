"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { GraphData } from "@/lib/data";

type Node = GraphData["nodes"][number] & { x: number; y: number; vx: number; vy: number };

/**
 * Force-directed link graph on canvas — no dependency, no WebGL. A simple
 * spring/repulsion simulation that settles in a couple of seconds.
 */
export function GraphCanvas({ graph }: { graph: GraphData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const router = useRouter();
  const [hover, setHover] = useState<Node | null>(null);
  const dragRef = useRef<Node | null>(null);
  const nodesRef = useRef<Node[]>([]);

  const spaces = useMemo(
    () => [...new Set(graph.nodes.map((n) => n.space))],
    [graph]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const W = () => canvas.getBoundingClientRect().width;
    const H = () => canvas.getBoundingClientRect().height;

    // Seed positions with a deterministic scatter — a circle seed makes a
    // symmetric graph freeze into a ring instead of finding its clusters.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    nodesRef.current = graph.nodes.map((n) => ({
      ...n,
      x: W() * (0.2 + rand() * 0.6),
      y: H() * (0.2 + rand() * 0.6),
      vx: 0,
      vy: 0,
    }));

    // Ideal edge length for this many nodes in this much space.
    const k = Math.max(
      42,
      Math.sqrt((W() * H()) / Math.max(1, graph.nodes.length)) * 0.62
    );
    const index = new Map(nodesRef.current.map((n) => [n.id, n]));
    const edges = graph.edges
      .map((e) => ({ a: index.get(e.from)!, b: index.get(e.to)! }))
      .filter((e) => e.a && e.b);

    const style = getComputedStyle(document.documentElement);
    const read = (v: string, fallback: string) =>
      style.getPropertyValue(v).trim() || fallback;

    let raf = 0;
    let alpha = 1;
    const tick = () => {
      const nodes = nodesRef.current;
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { d2 = 1; dx = Math.random(); dy = Math.random(); }
          const f = (k * k * alpha) / d2;
          const d = Math.sqrt(d2);
          a.vx -= (dx / d) * f;
          a.vy -= (dy / d) * f;
          b.vx += (dx / d) * f;
          b.vy += (dy / d) * f;
        }
      }
      // springs
      for (const e of edges) {
        const dx = e.b.x - e.a.x;
        const dy = e.b.y - e.a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = ((d - k) / k) * 6 * alpha;
        e.a.vx += (dx / d) * f;
        e.a.vy += (dy / d) * f;
        e.b.vx -= (dx / d) * f;
        e.b.vy -= (dy / d) * f;
      }
      // centering + integrate
      for (const n of nodes) {
        if (dragRef.current === n) continue;
        n.vx += (W() / 2 - n.x) * 0.004 * alpha;
        n.vy += (H() / 2 - n.y) * 0.004 * alpha;
        n.vx *= 0.85;
        n.vy *= 0.85;
        const speed = Math.hypot(n.vx, n.vy);
        const max = 18;
        if (speed > max) {
          n.vx = (n.vx / speed) * max;
          n.vy = (n.vy / speed) * max;
        }
        n.x = Math.max(24, Math.min(W() - 24, n.x + n.vx));
        n.y = Math.max(24, Math.min(H() - 24, n.y + n.vy));
      }
      alpha = Math.max(0.03, alpha * 0.991);

      // draw
      const ink = read("--ink", "#211c13");
      const line = read("--line-strong", "#cfc6ae");
      const accent = read("--accent", "#b8401b");
      ctx.clearRect(0, 0, W(), H());
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      for (const e of edges) {
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const n of nodes) {
        const r = Math.min(11, 3.5 + n.degree * 1.1);
        const isHover = hover?.id === n.id;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isHover ? accent : ink;
        ctx.globalAlpha = isHover ? 1 : 0.75;
        ctx.fill();
        if (isHover || n.degree > 2) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = isHover ? accent : ink;
          ctx.font = `${isHover ? 600 : 400} 11px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = "center";
          const label = n.title.length > 28 ? n.title.slice(0, 27) + "…" : n.title;
          ctx.fillText(label, n.x, n.y - r - 5);
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const at = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      return nodesRef.current.find(
        (n) => Math.hypot(n.x - x, n.y - y) < Math.min(14, 6 + n.degree)
      ) ?? null;
    };
    const onMove = (e: PointerEvent) => {
      if (dragRef.current) {
        const rect = canvas.getBoundingClientRect();
        dragRef.current.x = e.clientX - rect.left;
        dragRef.current.y = e.clientY - rect.top;
        alpha = Math.max(alpha, 0.35);
        return;
      }
      const n = at(e);
      setHover(n);
      canvas.style.cursor = n ? "pointer" : "default";
    };
    const onDown = (e: PointerEvent) => { dragRef.current = at(e); };
    const onUp = (e: PointerEvent) => {
      const dragged = dragRef.current;
      dragRef.current = null;
      const n = at(e);
      if (n && n === dragged && Math.hypot(n.vx, n.vy) < 6) router.push(n.href);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
    };
  }, [graph, router, hover?.id]);

  return (
    <div className="mt-6">
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        <canvas ref={canvasRef} className="h-[62vh] w-full touch-none" />
      </div>
      <p className="mt-3 text-xs text-faint">
        {spaces.length} {spaces.length === 1 ? "space" : "spaces"} represented ·
        node size follows how often a page is linked
      </p>
    </div>
  );
}
