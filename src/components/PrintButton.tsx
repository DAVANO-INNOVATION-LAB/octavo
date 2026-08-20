"use client";

import { Printer } from "lucide-react";

/**
 * PDF export via the browser's print engine — it renders our own book
 * typography, so the PDF looks exactly like the page. A print stylesheet
 * strips the app chrome.
 */
export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      title="Export this page as PDF (print)"
      className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-ink print:hidden"
    >
      <Printer size={13} />
      PDF
    </button>
  );
}
