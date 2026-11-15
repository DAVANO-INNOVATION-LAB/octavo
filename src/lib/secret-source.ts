import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Resolve a secret without caching file contents or falling back after file errors.
 * Kubernetes projected Secrets and Vault Agent files may be replaced atomically.
 * Call this for every settings read so rotation invalidates the OIDC cache key.
 */
export function resolveSecretSource(input: {
  envValue?: string;
  filePath?: string;
  storedValue?: string | null;
}): string | null {
  const { envValue, filePath, storedValue } = input;
  if (filePath) {
    if (envValue) throw new Error("Configure either the secret value or secret file, not both");
    let fd: number | undefined;
    try {
      // Nonblocking open lets us reject a misconfigured FIFO instead of hanging.
      fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 65536) throw new Error("invalid file");
      const bytes = Buffer.alloc(65537);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > 65536) throw new Error("oversize file");
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)).replace(/\r?\n$/, "");
      if (!value.trim() || value.includes("\0")) throw new Error("empty or invalid secret");
      return value;
    } catch {
      // Never include paths, operating-system messages or credential bytes.
      throw new Error("Configured secret file is missing, unreadable, empty or invalid");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return envValue || storedValue || null;
}
