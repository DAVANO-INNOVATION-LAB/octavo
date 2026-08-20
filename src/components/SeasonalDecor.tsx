"use client";

import { useEffect, useState } from "react";

const SEASONAL = new Set(["hallows", "harvest", "yuletide", "meridian"]);

const FLYBY_MIN_MS = 45 * 60_000;
const FLYBY_MAX_MS = 90 * 60_000;
const FLYBY_DURATION_MS = 13_000;

declare global {
  interface Window {
    __octavoFlybys?: Record<string, () => void>;
  }
}

/**
 * A flyby is a rare event: once every 45–90 minutes (randomized), the rider
 * makes a single pass and is gone. Manually summonable from the console for
 * demos: window.__octavoFlybys.santa() / .witch()
 */
function useFlyby(name: string): boolean {
  const [flying, setFlying] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const schedule = () => {
      const delay =
        FLYBY_MIN_MS + Math.random() * (FLYBY_MAX_MS - FLYBY_MIN_MS);
      timer = setTimeout(fly, delay);
    };
    const fly = () => {
      if (cancelled) return;
      setFlying(true);
      timer = setTimeout(() => {
        if (cancelled) return;
        setFlying(false);
        schedule();
      }, FLYBY_DURATION_MS);
    };

    schedule();
    window.__octavoFlybys = { ...window.__octavoFlybys, [name]: fly };
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (window.__octavoFlybys) delete window.__octavoFlybys[name];
    };
  }, [name]);

  return flying;
}

/**
 * Hand-drawn SVG dressing for the seasonal palettes. Mounted inside the
 * header; renders nothing outside the seasonal months (it keys off the
 * data-palette attribute, which only carries a seasonal value while the
 * season is active and the user hasn't turned it off).
 */
export function SeasonalDecor() {
  const [season, setSeason] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      const p = document.documentElement.getAttribute("data-palette");
      setSeason(p && SEASONAL.has(p) ? p : null);
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-palette"],
    });
    return () => mo.disconnect();
  }, []);

  if (!season) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 select-none overflow-hidden"
    >
      {season === "hallows" && <Hallows />}
      {season === "harvest" && <Harvest />}
      {season === "yuletide" && <Yuletide />}
    </div>
  );
}

/* ————— October: pumpkin and scarecrow on the shelf, a witch drifting by ————— */

function Pumpkin({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M12 5 C12.5 3 14 2 15.5 2 C15 3 14.5 4 14.5 5.5 Z" fill="#6b4a2b" />
      <ellipse cx="12" cy="14.5" rx="9" ry="7.5" fill="#d05a16" />
      <ellipse cx="12" cy="14.5" rx="4.2" ry="7.5" fill="#e06a20" />
      <path d="M7.5 8.6 C6 11 6 18 7.5 20.4 M16.5 8.6 C18 11 18 18 16.5 20.4" stroke="#a8440e" strokeWidth="1" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function Scarecrow({ size = 26 }: { size?: number }) {
  return (
    <svg width={size * (24 / 28)} height={size} viewBox="0 0 24 28" style={{ opacity: 0.55 }}>
      <g fill="var(--muted)">
        <rect x="11.1" y="9" width="1.8" height="19" rx="0.9" />
        <rect x="3" y="11.5" width="18" height="1.7" rx="0.85" />
        <circle cx="12" cy="6.5" r="3.1" />
        <path d="M6.8 4.6 L12 0.4 L17.2 4.6 Z" />
        <rect x="5.8" y="4.1" width="12.4" height="1.4" rx="0.7" />
        <path d="M3.4 11.6 L1.2 14.4 M20.6 11.6 L22.8 14.4" stroke="var(--muted)" strokeWidth="1.2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function Witch() {
  const flying = useFlyby("witch");
  if (!flying) return null;
  return (
    <div className="seasonal-flyby absolute left-0 top-[10px]">
      <div className="seasonal-bob">
        <svg width="52" height="26" viewBox="0 0 52 26" style={{ opacity: 0.55 }}>
          <g fill="var(--ink)">
            {/* broom */}
            <rect x="2" y="16.4" width="34" height="1.4" rx="0.7" transform="rotate(-4 19 17)" />
            <path d="M3.5 13.5 L9 16.8 L3.5 20.5 L0.5 17.2 Z" />
            {/* dress */}
            <path d="M20 17 L30 17 L27.5 8.5 L23.5 9 Z" />
            {/* head + hat */}
            <circle cx="28.5" cy="6.8" r="2.4" />
            <path d="M24.5 5.2 L31 1 L32.5 6.2 Z" />
            <rect x="23.6" y="4.9" width="10" height="1.2" rx="0.6" transform="rotate(-8 28.6 5.5)" />
            {/* cape flick */}
            <path d="M20.5 9.5 C17 10 15 12.5 14.5 15 C17.5 13.8 19.5 13.5 21.5 13.8 Z" />
          </g>
        </svg>
      </div>
    </div>
  );
}

function Hallows() {
  return (
    <>
      <Witch />
      <div className="absolute inset-x-0 bottom-0 hidden justify-center sm:flex">
        <div className="flex items-end gap-3 pb-px">
          <Scarecrow />
          <Pumpkin />
          <Pumpkin size={11} />
        </div>
      </div>
    </>
  );
}

/* ————— November: the harvest basket under the wordmark ————— */

function Harvest() {
  return (
    <div className="relative mx-auto h-full max-w-7xl px-4 sm:px-6">
      <svg
        width="46"
        height="18"
        viewBox="0 0 46 18"
        className="absolute left-6 top-[37px] sm:left-8"
      >
        {/* wheat stalks */}
        <path d="M37 8 C40 5 41 3 41.5 0.8 M39 9 C42.5 7.5 44 6 45.2 3.6" stroke="#b98a3a" strokeWidth="1.1" fill="none" strokeLinecap="round" />
        {/* fruit */}
        <circle cx="12" cy="7.5" r="4" fill="#ab2b34" />
        <circle cx="20" cy="6" r="4.6" fill="#d0761c" />
        <circle cx="28" cy="7.5" r="3.6" fill="#7a8a2e" />
        <circle cx="32.5" cy="9" r="2" fill="#5d3a6e" />
        <circle cx="35" cy="7.4" r="2" fill="#5d3a6e" />
        <circle cx="34.6" cy="10.6" r="2" fill="#5d3a6e" />
        <path d="M20 2 C20.6 1 21.6 0.6 22.4 0.6" stroke="#5d4222" strokeWidth="1.1" fill="none" strokeLinecap="round" />
        {/* basket */}
        <path d="M5 9 L41 9 Q40 18 34 18 L12 18 Q6 18 5 9 Z" fill="#8a5a2b" />
        <path d="M8.5 12.5 L37.5 12.5 M10.5 15.2 L35.6 15.2" stroke="#6d451f" strokeWidth="1.1" />
        <path d="M5 9 L41 9" stroke="#a06c36" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/* ————— December: all out — lights, Santa flyby, tree, lit fireplace ————— */

const BULB_COLORS = ["#e0555e", "#e3b74f", "#58a86a", "#6db1ff"];

function Lights() {
  return (
    <div className="absolute inset-x-0 top-0">
      {Array.from({ length: 32 }, (_, i) => (
        <span
          key={i}
          className="seasonal-bulb absolute rounded-full"
          style={{
            left: `${((i + 0.5) / 32) * 100}%`,
            top: `${3.5 + 2.5 * Math.sin(i * 1.25)}px`,
            width: "5px",
            height: "5px",
            background: BULB_COLORS[i % 4],
            boxShadow: `0 0 6px 1px ${BULB_COLORS[i % 4]}`,
            animationDelay: `${(i % 8) * 0.35}s`,
          }}
        />
      ))}
    </div>
  );
}

function Tree({ size = 30 }: { size?: number }) {
  return (
    <svg width={size * (24 / 30)} height={size} viewBox="0 0 24 30">
      <path d="M12 1.5 L13 4.2 L15.8 4.2 L13.6 6 L14.5 8.8 L12 7.1 L9.5 8.8 L10.4 6 L8.2 4.2 L11 4.2 Z" fill="#e3b74f" />
      <path d="M12 6.5 L18 13.5 L6 13.5 Z" fill="#2e6b3f" />
      <path d="M12 10.5 L19.5 19.5 L4.5 19.5 Z" fill="#2f7a44" />
      <path d="M12 15.5 L21.5 26 L2.5 26 Z" fill="#35894c" />
      <rect x="10.4" y="26" width="3.2" height="3.5" fill="#6b4a2b" />
      <circle className="seasonal-bulb" cx="10" cy="12.4" r="1.1" fill="#e0555e" />
      <circle className="seasonal-bulb" cx="14.5" cy="17.5" r="1.1" fill="#e3b74f" style={{ animationDelay: "0.6s" }} />
      <circle className="seasonal-bulb" cx="8.5" cy="22.5" r="1.1" fill="#6db1ff" style={{ animationDelay: "1.2s" }} />
      <circle className="seasonal-bulb" cx="15.5" cy="23.6" r="1.1" fill="#e0555e" style={{ animationDelay: "1.8s" }} />
    </svg>
  );
}

function Fireplace({ size = 26 }: { size?: number }) {
  return (
    <svg width={size * (30 / 26)} height={size} viewBox="0 0 30 26">
      {/* mantel + bricks */}
      <rect x="0.5" y="0.5" width="29" height="3" rx="1" fill="#5f3428" />
      <path d="M2.5 3.5 L27.5 3.5 L27.5 26 L2.5 26 Z" fill="#7a4434" />
      <path d="M5 8 h6 M13 8 h6 M21 8 h5 M8 12.6 h6 M16.5 12.6 h6" stroke="#5f3428" strokeWidth="1" strokeLinecap="round" opacity="0.8" />
      {/* opening */}
      <path d="M7 26 L7 14 Q7 8.5 15 8.5 Q23 8.5 23 14 L23 26 Z" fill="#1d1210" />
      {/* logs */}
      <rect x="9" y="22.4" width="12" height="2.2" rx="1.1" fill="#6b4a2b" />
      {/* flame */}
      <g className="seasonal-flame">
        <path d="M15 12.5 C17.8 15 18.8 17.5 18.8 19.5 C18.8 21.8 17 23 15 23 C13 23 11.2 21.8 11.2 19.5 C11.2 17.5 12.2 15 15 12.5 Z" fill="#e08a2e" />
        <path d="M15 16 C16.5 17.6 17 18.8 17 20 C17 21.5 16 22.4 15 22.4 C14 22.4 13 21.5 13 20 C13 18.8 13.5 17.6 15 16 Z" fill="#e8c25a" />
      </g>
    </svg>
  );
}

function Santa() {
  const flying = useFlyby("santa");
  if (!flying) return null;
  return (
    <div className="seasonal-flyby absolute left-0 top-[7px]">
      <div className="seasonal-bob">
        <svg width="104" height="30" viewBox="0 0 104 30" style={{ opacity: 0.85 }}>
          {/* reins */}
          <path d="M34 16 C44 12.5 56 12.5 66 15" stroke="var(--accent)" strokeWidth="1" fill="none" opacity="0.7" />
          {/* reindeer, x2 */}
          <g fill="var(--ink)">
            <Reindeer x={62} />
            <Reindeer x={82} />
          </g>
          {/* sleigh */}
          <g fill="var(--accent)">
            <path d="M8 14 Q4 14 4 10 Q4 8.5 5.5 8.5 Q5 12 9 12 L30 12 Q34 12 34 16 Q34 21 28 21 L12 21 Q8 21 8 14 Z" />
            {/* santa */}
            <circle cx="24" cy="8.6" r="2.6" />
            <path d="M20 12 L28 12 L27 6.5 L21.5 7 Z" opacity="0.9" />
            <path d="M24.5 5.8 L28.5 3.4 L29.3 6.3 Z" />
          </g>
          <circle cx="29.4" cy="3.3" r="1.1" fill="#fff" opacity="0.9" />
          {/* runner */}
          <path d="M6 24 Q6 26 9 26 L30 26 Q33 26 33 23.5" stroke="var(--ink)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <path d="M12 21 L12 24.4 M26 21 L26 24.4" stroke="var(--ink)" strokeWidth="1.2" />
        </svg>
      </div>
    </div>
  );
}

function Reindeer({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`}>
      {/* body + head */}
      <rect x="0" y="14" width="12" height="5.5" rx="2.7" />
      <rect x="10" y="10.5" width="4.5" height="5" rx="2" />
      {/* antlers */}
      <path d="M12 10.5 L10.8 6.8 M12 9.5 L13.8 6.4 M13.4 10.5 L15.4 7.6" stroke="var(--ink)" strokeWidth="1" strokeLinecap="round" fill="none" />
      {/* legs, mid-gallop */}
      <path d="M2 19.5 L0 23.5 M5 19.5 L4.5 24 M8.5 19.5 L10 23.5 M11 19.5 L13 22.6" stroke="var(--ink)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      {/* tail */}
      <path d="M0.5 14.5 L-1.5 12.8" stroke="var(--ink)" strokeWidth="1.2" strokeLinecap="round" />
    </g>
  );
}

function Yuletide() {
  return (
    <>
      <Lights />
      <Santa />
      <div className="absolute inset-x-0 bottom-0 hidden justify-center sm:flex">
        <div className="flex items-end gap-4 pb-px">
          <Tree />
          <Fireplace />
        </div>
      </div>
    </>
  );
}
