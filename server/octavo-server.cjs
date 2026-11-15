/**
 * Octavo's server entry.
 *
 * Next's standalone output generates its own `server.js` and calls
 * `startServer()`, which creates the HTTP listener internally and never hands
 * it back. Route Handlers cannot serve WebSockets — Next's own documentation
 * says so — and collaboration has to attach to a listener somewhere.
 *
 * So this wrapper intercepts `http.createServer` exactly once, keeps the
 * server Next builds, restores the original function immediately, and then
 * runs the generated entry unchanged. It is a small, deliberate liberty taken
 * against a private seam, and the alternative was a second port for every
 * deployment.
 *
 * The interception is verified at startup and reported either way, so if a
 * future Next release changes shape this fails loudly rather than leaving
 * collaboration quietly broken.
 */

const http = require("node:http");
const path = require("node:path");

const { collaborationEnabled } = require("./collab-config.cjs");
const collabEnabled = collaborationEnabled();
// Never trust an externally supplied capability. The wrapper establishes its
// own process-only secret before loading Next; disabled servers retain none.
if (collabEnabled)
  process.env.OCTAVO_COLLAB_INTERNAL_SECRET = require("node:crypto").randomBytes(32).toString("hex");
else
  delete process.env.OCTAVO_COLLAB_INTERNAL_SECRET;

const port = parseInt(process.env.PORT, 10) || 3000;

let captured = null;
const originalCreateServer = http.createServer;

if (collabEnabled) {
  http.createServer = function patched(...args) {
    const server = originalCreateServer.apply(this, args);
    if (!captured) {
      captured = server;
      // Take the liberty once, then put things back exactly as they were.
      http.createServer = originalCreateServer;
    }
    return server;
  };
}

// Run the generated standalone entry. It resolves everything relative to its
// own directory, so it must be required rather than re-implemented.
require(path.join(__dirname, "..", "server.js"));

if (collabEnabled) {
  // Give startServer a tick to build its listener before looking for it.
  setTimeout(() => {
    http.createServer = originalCreateServer;
    if (!captured)
      throw new Error("octavo: collaboration startup failed: HTTP listener was not captured");
    // An enabled deployment must not remain healthy while advertising a
    // persistence protocol without its coordinator. Uncaught startup errors
    // terminate the process so the operator can fix or explicitly disable it.
    const { attachCollab } = require("./collab.cjs");
    if (!attachCollab(captured, { port }))
      throw new Error("octavo: collaboration startup failed: coordinator did not attach");
    console.log("octavo: real-time collaboration attached at /collab");
  }, 500);
}
