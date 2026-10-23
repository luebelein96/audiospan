const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;
LOOKUP["=".charCodeAt(0)] = -2;

/** Portable base64 encoding that works in browsers, workers, worklets and Node. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + "=";
  }
  return out;
}

/** Decodes standard base64. Throws on invalid characters or padding. */
export function base64ToBytes(text: string): Uint8Array {
  if (typeof text !== "string" || text.length % 4 !== 0) throw new Error("Invalid base64 length");
  if (text.length === 0) return new Uint8Array(0);
  let padding = 0;
  if (text.endsWith("==")) padding = 2;
  else if (text.endsWith("=")) padding = 1;
  const outLength = (text.length / 4) * 3 - padding;
  const out = new Uint8Array(outLength);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = LOOKUP[text.charCodeAt(i)] ?? -1;
    const b = LOOKUP[text.charCodeAt(i + 1)] ?? -1;
    const c = LOOKUP[text.charCodeAt(i + 2)] ?? -1;
    const d = LOOKUP[text.charCodeAt(i + 3)] ?? -1;
    const last = i + 4 === text.length;
    if (a < 0 || b < 0 || (!last && (c < 0 || d < 0))) throw new Error("Invalid base64 character");
    if (last) {
      if ((c === -2 && d !== -2) || c === -1 || d === -1) throw new Error("Invalid base64 padding");
    } else if (c === -2 || d === -2) {
      throw new Error("Invalid base64 padding");
    }
    const cc = c < 0 ? 0 : c;
    const dd = d < 0 ? 0 : d;
    const n = (a << 18) | (b << 12) | (cc << 6) | dd;
    out[o++] = (n >> 16) & 255;
    if (o < outLength) out[o++] = (n >> 8) & 255;
    if (o < outLength) out[o++] = n & 255;
  }
  return out;
}

/** Decoded byte length of a base64 string without allocating. */
export function base64ByteLength(text: string): number {
  if (text.length === 0) return 0;
  if (text.length % 4 !== 0) return -1;
  let padding = 0;
  if (text.endsWith("==")) padding = 2;
  else if (text.endsWith("=")) padding = 1;
  return (text.length / 4) * 3 - padding;
}
