// Exercise the real auth module with isolated infrastructure dependencies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const secret = "auth-regression-test-secret";
const clock = 1_800_000_000_000;
const exports = {};
const dependencies = {
  "server-only": {},
  "next/headers": {},
  "node:crypto": crypto,
  "./db": { getDb: () => ({ prepare: () => ({ get: () => ({ value: secret }) }) }) },
  "./util": { now: () => clock },
  "./scim": {},
  "./policy": {},
};
const source = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
vm.runInNewContext(outputText, {
  exports, Buffer,
  require: (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  },
});
const { issuePendingToken, consumePendingToken } = exports;
const signed = (user, expiry) => {
  const payload = `${user}.${expiry}`;
  return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
};
assert.equal(consumePendingToken(issuePendingToken("user-1")), "user-1");
for (const signature of ["é".repeat(64), "😀".repeat(32), "a".repeat(63), "a".repeat(65), "z".repeat(64), "0".repeat(64), ""]) {
  assert.equal(consumePendingToken(`user-1.${clock + 1000}.${signature}`), null);
}
for (const expiry of ["NaN", "Infinity", "", "1e20", "9007199254740992", String(clock), String(clock - 1)]) {
  assert.equal(consumePendingToken(signed("user-1", expiry)), null);
}
assert.equal(consumePendingToken(signed("", clock + 1000)), null);
assert.equal(consumePendingToken(signed("user-2", clock + 1000).replace("user-2", "user-1")), null);
for (const token of ["", "a.b", "a.b.c.d"]) assert.equal(consumePendingToken(token), null);
console.log("PASS auth: valid token, Unicode/malformed/forged signatures, invalid/expired timestamps, empty identity, tampering and malformed structure.");
