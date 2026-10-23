import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { createTar, createTarGz, sha256 } from "../src/lib.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("deterministic tar", () => {
  it("produces identical bytes regardless of entry order and run", () => {
    const a = createTarGz([{ path: "b.txt", data: enc("bee") }, { path: "a/x.json", data: enc("{}") }]);
    const b = createTarGz([{ path: "a/x.json", data: enc("{}") }, { path: "b.txt", data: enc("bee") }]);
    expect(sha256(a)).toBe(sha256(b));
    expect(a[4]).toBe(0); // gzip mtime zeroed
  });

  it("writes valid ustar headers with epoch mtime and root ownership", () => {
    const tar = createTar([{ path: "hello.txt", data: enc("hi") }]);
    const header = tar.subarray(0, 512);
    const text = (from: number, len: number) => new TextDecoder().decode(header.subarray(from, from + len)).replace(/\0.*$/s, "");
    expect(text(0, 100)).toBe("hello.txt");
    expect(text(124, 12)).toBe("00000000002");
    expect(text(136, 12)).toBe("00000000000");
    expect(text(257, 6)).toBe("ustar");
    expect(text(265, 32)).toBe("root");
    expect(new TextDecoder().decode(tar.subarray(512, 514))).toBe("hi");
    expect(tar.length).toBe(512 + 512 + 1024);
    // checksum: sum of header bytes with checksum field as spaces
    const copy = Uint8Array.from(header);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of copy) sum += b;
    expect(parseInt(text(148, 8), 8)).toBe(sum);
    expect(gunzipSync(createTarGz([{ path: "hello.txt", data: enc("hi") }])).length).toBe(tar.length);
  });
});
