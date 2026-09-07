// Refuse to test a server that is not this checkout.
//
// Twice in one session a suite was pointed at a server left running from an
// earlier one — a different port, a build days old — and reported a clean
// pass for code that was never under test. A suite that can silently grade
// the wrong binary is worse than no suite, because it is believed.
//
// Every script that drives a live instance calls this first.
import { readFileSync } from "node:fs";

export async function requireTarget(base) {
  const expected = JSON.parse(readFileSync("package.json", "utf8")).version;
  let res;
  try {
    res = await fetch(`${base}/api/health`, { redirect: "manual" });
  } catch {
    console.error(`\nNothing is answering at ${base}.\n`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\n${base}/api/health answered HTTP ${res.status}.\n`);
    process.exit(1);
  }
  let got;
  try {
    got = (await res.json()).version;
  } catch {
    got = undefined;
  }
  if (got === undefined) {
    // An older build with no version to report is, by definition, not this one.
    console.error(
      `\n${base} reports no version — it predates this check, so it is not the build in this checkout (${expected}).\n` +
        `Rebuild and restart the server you are testing.\n`
    );
    process.exit(1);
  }
  if (got !== expected) {
    console.error(
      `\n${base} is running ${got}; this checkout is ${expected}.\n` +
        `That server is from another build. Rebuild and restart it, or pass the right base URL.\n`
    );
    process.exit(1);
  }
  return expected;
}
