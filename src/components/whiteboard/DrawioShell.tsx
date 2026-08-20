"use client";

import dynamic from "next/dynamic";

const DrawioBoard = dynamic(() => import("./DrawioBoard"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-faint">
      Drafting table incoming…
    </div>
  ),
});

export function DrawioShell() {
  return (
    <div className="h-[calc(100vh-9.6rem)] w-full">
      <DrawioBoard />
    </div>
  );
}
