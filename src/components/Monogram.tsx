/** Typographic mark for a space: its initial, set in the display face. */
export function Monogram({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const initial = (name.trim()[0] ?? "·").toUpperCase();
  const cls =
    size === "lg"
      ? "h-14 w-14 rounded-xl text-3xl"
      : size === "sm"
        ? "h-6 w-6 rounded-md text-xs"
        : "h-9 w-9 rounded-lg text-lg";
  return (
    <span
      aria-hidden
      className={`wordmark flex shrink-0 select-none items-center justify-center bg-accent-soft text-accent ${cls}`}
    >
      {initial}
    </span>
  );
}
