// Minimal ZIP writer/reader — no dependencies.
// Writer emits stored (uncompressed) entries: exports are mostly text and
// SQLite-sized; simplicity beats ratio. Reader handles stored and deflated
// entries via node:zlib, which covers zips from every mainstream tool.

import { inflateRawSync } from "node:zlib";

/* ————— CRC32 ————— */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ————— writer ————— */

export type ZipEntry = { name: string; data: Buffer };

function dosDateTime(d = new Date()): { time: number; date: number } {
  return {
    time:
      (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      ((d.getMonth() + 1) << 5) |
      d.getDate(),
  };
}

export function zip(entries: ZipEntry[]): Buffer {
  const { time, date } = dosDateTime();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + e.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ————— reader ————— */

const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export function unzip(buf: Buffer): ZipEntry[] {
  // A signature can occur inside the comment. Only accept an end record whose
  // comment reaches EOF and whose central directory ends at that record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + buf.readUInt16LE(i + 20) === buf.length &&
        buf.readUInt32LE(i + 16) + buf.readUInt32LE(i + 12) === i) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid or truncated ZIP archive central directory");
  const count = buf.readUInt16LE(eocd + 10);
  const centralStart = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralStart === 0xffffffff)
    throw new Error("ZIP64 archives are not supported");
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 ||
      buf.readUInt16LE(eocd + 8) !== count)
    throw new Error("Split-disk ZIP archives are not supported");
  if (count > 10000) throw new Error("Archive has too many entries");

  const span = (offset: number, length: number, end: number) => {
    if (offset < 0 || length < 0 || offset > end || length > end - offset)
      throw new Error("Invalid or truncated ZIP archive entry");
  };
  const entries: { name: string; method: number; crc: number; size: number; start: number; end: number; local: number; boundary: number }[] = [];
  let p = centralStart, totalBytes = 0;
  // Validate all metadata and the total expansion budget before allocating any
  // decompressed buffers. Never rely on Buffer.subarray's silent truncation.
  for (let n = 0; n < count; n++) {
    span(p, 46, eocd);
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad ZIP central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || size === 0xffffffff || localOff === 0xffffffff)
      throw new Error("ZIP64 archives are not supported");
    if (buf.readUInt16LE(p + 34) !== 0) throw new Error("Split-disk ZIP archives are not supported");
    if (flags & 0x41) throw new Error("Encrypted ZIP archives are not supported");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`);
    span(p, 46 + nameLen + extraLen + commentLen, eocd);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = nameBytes.toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (size > MAX_ENTRY_BYTES) throw new Error("Expanded archive entry exceeds 100 MB");
    totalBytes += size;
    if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error("Expanded archive exceeds 200 MB");
    if (method === 0 && csize !== size) throw new Error(`Stored ZIP entry size mismatch: ${name}`);

    span(localOff, 30, centralStart);
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("Bad ZIP local header");
    if (buf.readUInt16LE(localOff + 6) !== flags || buf.readUInt16LE(localOff + 8) !== method)
      throw new Error(`ZIP local header flags or method mismatch: ${name}`);
    if (buf.readUInt32LE(localOff + 18) === 0xffffffff || buf.readUInt32LE(localOff + 22) === 0xffffffff)
      throw new Error("ZIP64 archives are not supported");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    span(localOff, 30 + lNameLen + lExtraLen, centralStart);
    if (!buf.subarray(localOff + 30, localOff + 30 + lNameLen).equals(nameBytes))
      throw new Error(`ZIP local header name mismatch: ${name}`);
    // Bit 3 permits streaming writers to leave these local fields unset. The
    // central sizes/CRC are still checked against the actual decoded bytes.
    if (!(flags & 8) && (buf.readUInt32LE(localOff + 14) !== crc ||
        buf.readUInt32LE(localOff + 18) !== csize || buf.readUInt32LE(localOff + 22) !== size))
      throw new Error(`ZIP local header checksum or size mismatch: ${name}`);
    const start = localOff + 30 + lNameLen + lExtraLen;
    span(start, csize, centralStart);
    const end = start + csize;
    let boundary = end;
    if (flags & 8) {
      // The optional signature can equal an unsigned descriptor's CRC. Try
      // both layouts, accepting only one that matches the central metadata.
      const matches = (at: number) => at + 12 <= centralStart &&
        buf.readUInt32LE(at) === crc && buf.readUInt32LE(at + 4) === csize &&
        buf.readUInt32LE(at + 8) === size;
      if (end + 16 <= centralStart && buf.readUInt32LE(end) === 0x08074b50 && matches(end + 4))
        boundary += 16;
      else if (matches(end)) boundary += 12;
      else throw new Error(`ZIP data descriptor checksum or size mismatch: ${name}`);
    }
    entries.push({ name, method, crc, size, start, end, local: localOff, boundary });
  }
  if (p !== eocd) throw new Error("ZIP central directory size or entry count mismatch");
  const ranges = [...entries].sort((a, b) => a.local - b.local);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].local < ranges[i - 1].boundary) throw new Error("Overlapping ZIP archive entries");
  }

  const out: ZipEntry[] = [];
  for (const entry of entries) {
    const raw = buf.subarray(entry.start, entry.end);
    let data: Buffer;
    if (entry.method === 0) data = Buffer.from(raw);
    else {
      try {
        // Bound actual output too: metadata may understate expanded size.
        // Node's info:true result is not represented by the current @types
        // overload; it returns both the buffer and its decoding engine.
        const inflated = inflateRawSync(raw, {
          maxOutputLength: Math.max(1, entry.size), info: true,
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (inflated.engine.bytesWritten !== raw.length)
          throw new Error("Compressed size does not match the deflate stream");
        data = inflated.buffer;
      } catch {
        throw new Error(`Invalid compressed data or expanded size in ZIP entry: ${entry.name}`);
      }
    }
    if (data.length !== entry.size) throw new Error(`ZIP entry expanded size mismatch: ${entry.name}`);
    if (crc32(data) !== entry.crc) throw new Error(`ZIP entry checksum mismatch: ${entry.name}`);
    if (!entry.name.endsWith("/")) out.push({ name: entry.name, data });
  }
  return out;
}
