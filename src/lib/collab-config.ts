import "server-only";

/** Keep these accepted values aligned with server/collab-config.cjs. Disabling
 * persistence disables collaboration, never selects the unsafe legacy writer. */
export function collaborationEnabled(): boolean {
  const mode = process.env.OCTAVO_COLLAB_PERSISTENCE ?? "";
  if (!["", "0", "1", "experimental"].includes(mode))
    throw new Error("Invalid OCTAVO_COLLAB_PERSISTENCE; use 1 or 0");
  return process.env.OCTAVO_COLLAB !== "0" && mode !== "0";
}
