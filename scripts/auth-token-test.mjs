// Pending-token regression tests against the real auth module.
// Run with Node 22.18+: node scripts/auth-token-test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Isolate Next request state and SQLite; signing still uses real node:crypto.
const mocks = {
  "server-only": "",
  "next/headers": "export const cookies = () => {}; export const headers = () => {};",
  "./db": 'export const getDb = () => ({ prepare: () => ({ get: () => ({ value: "test-only-instance-secret" }) }) });',
  "./util": "export const newId = () => 'unused'; export const now = () => Date.now();",
  "./scim": "export const isDeactivated = () => false;",
  "./policy": "export const clearSigninFailures = () => {}; export const lockoutState = () => ({}); export const recordSigninFailure = () => {}; export const sessionTtlMs = () => 0;",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/src/lib/auth.ts") && Object.hasOwn(mocks, specifier)) {
      return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { issuePendingToken, consumePendingToken } = await import("../src/lib/auth.ts");
hooks.deregister();

test("issued token verifies with the real HMAC implementation", () => {
  assert.equal(consumePendingToken(issuePendingToken("user-123")), "user-123");
});
test("Unicode signature rejects without a buffer-length exception", () => {
  const token = issuePendingToken("user-123").split(".");
  for (const signature of ["é".repeat(64), "😀".repeat(32), "a".repeat(63) + "é"]) {
    token[2] = signature;
    assert.equal(consumePendingToken(token.join(".")), null);
  }
});
test("malformed and tampered signatures reject", () => {
  const token = issuePendingToken("user-123");
  const [user, expiry, mac] = token.split(".");
  for (const signature of ["", "a", "g".repeat(64), mac.slice(0, 63), (mac[0] === "0" ? "1" : "0") + mac.slice(1)]) {
    assert.equal(consumePendingToken([user, expiry, signature].join(".")), null);
  }
  assert.equal(consumePendingToken(token.replace("user-123", "user-456")), null);
  assert.equal(consumePendingToken("not-a-token"), null);
});
test("expired signed token rejects", () => {
  const originalNow = Date.now;
  let token;
  try {
    Date.now = () => originalNow() - 6 * 60 * 1000;
    token = issuePendingToken("user-123");
  } finally {
    Date.now = originalNow;
  }
  assert.equal(consumePendingToken(token), null);
});
