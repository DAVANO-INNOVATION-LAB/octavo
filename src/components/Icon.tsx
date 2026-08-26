import * as Lucide from "lucide-react";
import { asIconName } from "@/lib/icons";
import { Monogram } from "./Monogram";

/**
 * A page or space's mark: its chosen icon, or its initial if it has none.
 *
 * The lookup is narrowed through asIconName first, so only names from the
 * curated set ever reach the icon family — a stray value in the database
 * falls back to the monogram rather than rendering something arbitrary.
 */
export function Icon({
  icon,
  name,
  size = "md",
}: {
  icon: string;
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const valid = asIconName(icon);
  if (!valid) return <Monogram name={name} size={size} />;

  const Glyph = (Lucide as unknown as Record<string, React.ComponentType<{ size?: number }>>)[valid];
  if (!Glyph) return <Monogram name={name} size={size} />;

  const box =
    size === "lg"
      ? "h-14 w-14 rounded-xl"
      : size === "sm"
        ? "h-6 w-6 rounded-md"
        : "h-9 w-9 rounded-lg";
  const px = size === "lg" ? 26 : size === "sm" ? 13 : 18;

  return (
    <span
      aria-hidden
      className={`flex shrink-0 select-none items-center justify-center bg-accent-soft text-accent ${box}`}
    >
      <Glyph size={px} />
    </span>
  );
}
