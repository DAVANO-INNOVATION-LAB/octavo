import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/document-review.ts", import.meta.url), "utf8");
const exports = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports,
  require: (name) => {
    assert.equal(name, "node:crypto");
    return crypto;
  },
});
const { reviewRevision, reviewState, completeReview } = exports;
const now = 1_800_000_000_000;
const page = { title: "Runbook", content: '[{"type":"paragraph"}]', updatedAt: now - 1000 };
const original = JSON.stringify(page);
const revision = reviewRevision(page);
const previous = { ownerId: "owner", dueAt: now, verifiedAt: null, verifiedBy: null, verifiedRevision: null };
const input = { page, previous, expectedRevision: revision, reviewerId: "reviewer", now, nextDueAt: now + 86400_000 };
assert.equal(reviewState(page, null, now), "unreviewed");
assert.equal(reviewState({ ...page, updatedAt: now - 180 * 86400_000 }, null, now), "stale");
assert.equal(reviewState(page, previous, now), "overdue");
const record = completeReview(input);
assert.equal(record.ownerId, "owner");
assert.equal(record.verifiedBy, "reviewer");
assert.equal(reviewState(page, record, now), "verified");
assert.equal(reviewState(page, record, record.dueAt), "overdue");
for (const changed of [{ ...page, title: "New title" }, { ...page, content: "[]" }]) {
  assert.equal(reviewState(changed, record, now), "changed");
  assert.throws(() => completeReview({ ...input, page: changed }), /Page changed/);
}
assert.equal(JSON.stringify(page), original);
assert.equal(previous.verifiedAt, null);
assert.notEqual(reviewRevision({ title: "a", content: "bc" }), reviewRevision({ title: "ab", content: "c" }));
assert.equal(reviewState(page, { ...record, verifiedBy: null }, now), "unreviewed");
assert.equal(reviewState(page, { ...record, verifiedAt: now + 1 }, now), "unreviewed");
for (const nextDueAt of [now, now - 1, NaN, Infinity, -1, 1.5]) {
  assert.throws(() => completeReview({ ...input, nextDueAt }));
}
assert.throws(() => completeReview({ ...input, reviewerId: " " }), /Reviewer/);
assert.throws(() => reviewState(page, { ...record, dueAt: NaN }, now), /timestamp/);
console.log("PASS document review: stale/due boundaries, unchanged verification, title/content invalidation, concurrent-edit rejection, owner preservation, and invalid inputs.");
