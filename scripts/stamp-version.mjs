// Keep src/lib/version.ts in step with package.json.
//
// The health endpoint reports this, and the test suites refuse to run against
// a server whose version does not match the checkout — which is what turns
// "I pointed the suite at a server from last week" from a silent green run
// into an error.
import { readFileSync, writeFileSync } from "node:fs";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
writeFileSync(
  "src/lib/version.ts",
  `/** The version of this checkout. Written by scripts/stamp-version.mjs. */\nexport const VERSION = ${JSON.stringify(version)};\n`
);
