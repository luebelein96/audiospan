import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export interface TarEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  path: string;
  data: Uint8Array;
}

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) throw new Error(`tar field overflow for ${JSON.stringify(value)}`);
  block.set(bytes, offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function header(path: string, size: number, type: "0" | "5"): Uint8Array {
  const block = new Uint8Array(512);
  let name = path;
  let prefix = "";
  if (new TextEncoder().encode(name).length > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0) throw new Error(`path too long for ustar: ${path}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0); // mtime: epoch, for reproducibility
  block.fill(0x20, 148, 156); // checksum placeholder (spaces)
  writeString(block, 156, 1, type);
  writeString(block, 257, 6, "ustar");
  writeString(block, 263, 2, "00");
  writeString(block, 265, 32, "root");
  writeString(block, 297, 32, "root");
  if (prefix) writeString(block, 345, 155, prefix);
  let sum = 0;
  for (const b of block) sum += b;
  writeString(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

/**
 * Build a deterministic ustar archive: entries sorted by path, fixed
 * ownership and timestamps. Directories are implied (not emitted).
 */
export function createTar(entries: readonly TarEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const entry of sorted) {
    const h = header(entry.path, entry.data.byteLength, "0");
    chunks.push(h, entry.data);
    total += 512 + entry.data.byteLength;
    const pad = (512 - (entry.data.byteLength % 512)) % 512;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      total += pad;
    }
  }
  chunks.push(new Uint8Array(1024));
  total += 1024;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** gzip with a fixed header (no mtime, no name) so identical input yields identical bytes. */
export function createTarGz(entries: readonly TarEntry[]): Uint8Array {
  const gz = gzipSync(createTar(entries), { level: 9 });
  // zlib writes mtime=0 and OS=3 already; normalise defensively.
  gz[4] = 0;
  gz[5] = 0;
  gz[6] = 0;
  gz[7] = 0;
  gz[9] = 3;
  return new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength);
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
