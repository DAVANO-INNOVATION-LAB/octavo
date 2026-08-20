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

const port = parseInt(process.env.PORT, 10) || 3000;
const collabEnabled = process.env.OCTAVO_COLLAB !== "0";

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
    if (!captured) {
      console.error(
        "octavo: could not attach real-time collaboration — the HTTP server " +
          "was not where this build expected it. Editing still works; " +
          "co-editing does not. Set OCTAVO_COLLAB=0 to silence this."
      );
      return;
    }
    try {
      const { attachCollab } = require("./collab.cjs");
      const ok = attachCollab(captured, { port });
      console.log(
        ok
          ? "octavo: real-time collaboration attached at /collab"
          : "octavo: collaboration could not attach to the HTTP server"
      );
    } catch (err) {
      console.error("octavo: collaboration failed to start —", err.message);
    }
  }, 500);
}
