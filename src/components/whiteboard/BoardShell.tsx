"use client";

import dynamic from "next/dynamic";

const Board = dynamic(() => import("./Board"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[calc(100vh-6.1rem)] items-center justify-center text-sm text-faint">
      Rolling out the whiteboard…
    </div>
  ),
});

export function BoardShell() {
  return <Board />;
}
