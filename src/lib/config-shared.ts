/**
 * Values shared by the server module that resolves runtime configuration and
 * the client module that reads it. Kept in its own file with no environment
 * directive so importing it from either side is safe.
 */

/** The public draw.io editor, used when an operator has not self-hosted one. */
export const DEFAULT_DRAWIO_ORIGIN = "https://embed.diagrams.net";

export type PublicConfig = {
  drawioOrigin: string;
  /** False when this deployment has turned real-time co-editing off. */
  collab: boolean;
  /** False when draw.io editing is unavailable on this instance. */
  drawioEnabled: boolean;
  offline: boolean;
};
