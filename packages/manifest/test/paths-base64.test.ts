import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, isPluginId, isSafeRelativePath, isSemver, resolveArtifactUrl } from "../src/index.js";

describe("isSafeRelativePath", () => {
  it("accepts simple relative paths", () => {
    for (const p of ["module.wasm", "presets/default.json", "ui/index.html", "a-b_c.1/x"]) expect(isSafeRelativePath(p), p).toBe(true);
  });
  it("rejects traversal, absolute, scheme, and odd paths", () => {
    for (const p of ["../x", "a/../b", "/abs", "\\win", "a\\b", "http://x/y", "data:text/plain,hi", "a//b", "./a", "a/./b", "", "a?b", "a#b", "%2e%2e/x", "a\u0000b"]) {
      expect(isSafeRelativePath(p), JSON.stringify(p)).toBe(false);
    }
  });
});

describe("resolveArtifactUrl", () => {
  it("resolves relative to the manifest directory", () => {
    expect(resolveArtifactUrl("https://cdn.example/plugins/gain/plugin.json", "module.wasm").href).toBe("https://cdn.example/plugins/gain/module.wasm");
    expect(resolveArtifactUrl("http://localhost:8080/p/plugin.json", "presets/a.json").href).toBe("http://localhost:8080/p/presets/a.json");
  });
  it("throws on unsafe paths", () => {
    expect(() => resolveArtifactUrl("https://cdn.example/plugins/gain/plugin.json", "../other/module.wasm")).toThrow();
  });
});

describe("identifiers", () => {
  it("validates plugin ids", () => {
    expect(isPluginId("com.example.gain")).toBe(true);
    expect(isPluginId("dev.audiospan.gain-cpp")).toBe(true);
    expect(isPluginId("gain")).toBe(false);
    expect(isPluginId("Com.Example")).toBe(false);
    expect(isPluginId("com..example")).toBe(false);
  });
  it("validates semver", () => {
    expect(isSemver("1.2.3")).toBe(true);
    expect(isSemver("0.1.0-beta.1+build.5")).toBe(true);
    expect(isSemver("1.2")).toBe(false);
    expect(isSemver("v1.2.3")).toBe(false);
  });
});

describe("base64", () => {
  it("round-trips arbitrary bytes", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 1000]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 73 + 11) & 255;
      const text = bytesToBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString("base64"));
      expect(Array.from(base64ToBytes(text))).toEqual(Array.from(bytes));
    }
  });
  it("rejects invalid input", () => {
    expect(() => base64ToBytes("abc")).toThrow();
    expect(() => base64ToBytes("ab=c")).toThrow();
    expect(() => base64ToBytes("$$$$")).toThrow();
  });
});
