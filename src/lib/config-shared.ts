/**
 * Values shared by the server module that resolves runtime configuration and
 * the client module that reads it. Kept in its own file with no environment
 * directive so importing it from either side is safe.
 */

/**
 * draw.io is served by this instance. It ships inside the image rather than
 * being reached over the internet or run as a sidecar: an air-gapped site
 * frequently cannot do either, and a diagram editor that needs a second
 * container to exist is a diagram editor that is missing.
 */
export const DRAWIO_PATH = "/drawio";

export type PublicConfig = {
  drawioOrigin: string;
  /** False when this deployment has turned real-time co-editing off. */
  collab: boolean;
  offline: boolean;
};
