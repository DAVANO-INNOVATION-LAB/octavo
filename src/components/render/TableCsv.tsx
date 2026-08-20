"use client";

import { Download } from "lucide-react";

function csvEscape(cell: string): string {
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** Downloads a rendered table's data as CSV — the useful half of "export to Excel". */
export function TableCsv({ rows, name }: { rows: string[][]; name: string }) {
  return (
    <button
      onClick={() => {
        const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
        const url = URL.createObjectURL(
          new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" })
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name || "table"}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }}
      title="Download this table as CSV"
      className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-surface/80 text-faint opacity-0 shadow-card backdrop-blur transition-opacity hover:text-ink group-hover/table:opacity-100 print:hidden"
    >
      <Download size={12} />
    </button>
  );
}
