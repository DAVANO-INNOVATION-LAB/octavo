import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb, UPLOADS_DIR } from "./db";
import { VERSION } from "./version";

/** Whole-upload derivation snapshot, not source authenticity or lossless reconstruction. */
export type ImportProvenance = {
  schemaVersion: 1;
  source: { id: string; sha256: string; bytes: number };
  converter: { name: "octavo/importUpload"; version: string };
  capturedAt: number;
  pages: { pageId: string; contentSha256: string }[];
  attachments: { name: string; bytes: number; sha256: string }[];
};
const MAX_ITEMS = 10000;
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const sha256 = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");

export function captureImportProvenance(input: { spaceId: string; receiptId: string; sourceBytes: Buffer; capturedAt: number }): ImportProvenance {
  const db = getDb();
  if (!db.inTransaction) throw new Error("Import provenance requires an active import transaction");
  if (input.sourceBytes.length > 100 * 1024 * 1024) throw new Error("Import provenance source exceeds size limit");
  const pages = db.prepare("SELECT id, content FROM pages WHERE space_id=? ORDER BY id LIMIT ?").all(input.spaceId, MAX_ITEMS + 1) as { id: string; content: string }[];
  const files = db.prepare("SELECT name FROM uploads WHERE space_id=? ORDER BY name LIMIT ?").all(input.spaceId, MAX_ITEMS + 1) as { name: string }[];
  if (pages.length + files.length > MAX_ITEMS) throw new Error("Import provenance exceeds item limit");
  let totalBytes = 0;
  const attachments = files.map(({ name }) => {
    if (!name || name !== path.basename(name) || name === "." || name === ".." || /[\\/]/.test(name)) throw new Error("Invalid import provenance attachment name");
    const file = path.join(UPLOADS_DIR, name);
    const initial = fs.lstatSync(file);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("Import provenance attachment must be a regular file, not a symbolic link");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (before.dev !== initial.dev || before.ino !== initial.ino) throw new Error("Import provenance attachment changed before capture");
      if (!before.isFile()) throw new Error("Import provenance attachment must be a regular file");
      totalBytes += before.size;
      if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error("Import provenance attachments exceed size limit");
      const digest = crypto.createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0, count: number;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        bytes += count;
        if (bytes > before.size) throw new Error("Import provenance attachment changed during capture");
        digest.update(buffer.subarray(0, count));
      }
      const after = fs.fstatSync(fd);
      if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Import provenance attachment changed during capture");
      return { name, bytes, sha256: digest.digest("hex") };
    } finally { fs.closeSync(fd); }
  });
  return {
    schemaVersion: 1,
    source: { id: input.receiptId, sha256: sha256(input.sourceBytes), bytes: input.sourceBytes.length },
    converter: { name: "octavo/importUpload", version: VERSION },
    capturedAt: input.capturedAt,
    pages: pages.map(page => ({ pageId: page.id, contentSha256: sha256(page.content) })),
    attachments,
  };
}
