import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { packArtifact, validateArtifact, testArtifact, generateInput, expectedOutput, sha256, CliError } from "../src/lib.js";

const gainDist = fileURLToPath(new URL("../../../plugins/gain-cpp/dist/", import.meta.url));
const vectors = fileURLToPath(new URL("../templates/cpp-gain/test/vectors.json", import.meta.url));
const available = existsSync(join(gainDist, "module.wasm")) && existsSync(join(gainDist, "plugin.json"));

function tarEntries(gz: Uint8Array): string[] {
  const tar = gunzipSync(gz);
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = new TextDecoder().decode(tar.subarray(offset, offset + 100)).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(new TextDecoder().decode(tar.subarray(offset + 124, offset + 136)).replace(/\0.*$/s, ""), 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("validateArtifact", () => {
  it("reports a missing directory and missing manifest", async () => {
    const missing = await validateArtifact("/nonexistent/dir");
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]!.code).toBe("ARTIFACT_DIR_MISSING");
    const empty = mkdtempSync(join(tmpdir(), "as-empty-"));
    const noManifest = await validateArtifact(empty);
    expect(noManifest.errors[0]!.code).toBe("ARTIFACT_MANIFEST_MISSING");
  });

  it.skipIf(!available)("accepts the reference artifact and rejects a broken copy", async () => {
    const ok = await validateArtifact(gainDist);
    expect(ok.ok, JSON.stringify(ok.errors)).toBe(true);
    expect(ok.files).toContain("module.wasm");
    expect(ok.files).toContain("presets/default.json");
    expect(ok.module?.memory?.maximumPages).toBe(256);

    const broken = mkdtempSync(join(tmpdir(), "as-broken-"));
    const manifest = JSON.parse(readFileSync(join(gainDist, "plugin.json"), "utf8"));
    writeFileSync(join(broken, "plugin.json"), JSON.stringify({ ...manifest, presets: [{ id: "x", name: "X", path: "presets/x.json" }] }));
    writeFileSync(join(broken, "module.wasm"), "not wasm");
    const report = await validateArtifact(broken);
    expect(report.ok).toBe(false);
    const codes = report.errors.map((e) => e.code);
    expect(codes).toContain("MODULE_INVALID");
    expect(codes).toContain("ARTIFACT_PRESET_MISSING");

    const tooBig = await validateArtifact(gainDist, { maxModuleBytes: 100 });
    expect(tooBig.errors.map((e) => e.code)).toContain("ARTIFACT_MODULE_TOO_LARGE");
    const lowMemory = await validateArtifact(gainDist, { maxMemoryBytes: 1024 * 1024 });
    expect(lowMemory.errors.map((e) => e.code)).toContain("MANIFEST_POLICY_MEMORY");
  });
});

describe.skipIf(!available)("packArtifact", () => {
  it("creates a deterministic archive with a package manifest and checksums", async () => {
    const out1 = mkdtempSync(join(tmpdir(), "as-pack-"));
    const out2 = mkdtempSync(join(tmpdir(), "as-pack-"));
    const a = await packArtifact(gainDist, { outDir: out1 });
    const b = await packArtifact(gainDist, { outDir: out2 });
    expect(a.sha256).toBe(b.sha256);
    expect(a.archivePath.endsWith("dev.audiospan.gain-cpp-0.1.0.audiospan.tar.gz")).toBe(true);
    const bytes = readFileSync(a.archivePath);
    expect(sha256(new Uint8Array(bytes))).toBe(a.sha256);
    expect(readFileSync(a.checksumPath, "utf8")).toContain(a.sha256);
    const entries = tarEntries(new Uint8Array(bytes));
    expect(entries).toEqual(["audiospan-package.json", "checksums.sha256", "module.wasm", "plugin.json", "presets/boost.json", "presets/default.json", "presets/half.json"]);
    expect(a.files.find((f) => f.path === "module.wasm")!.sha256).toBe(sha256(new Uint8Array(readFileSync(join(gainDist, "module.wasm")))));
  });

  it("refuses to pack an invalid artifact and can include sources", async () => {
    const broken = mkdtempSync(join(tmpdir(), "as-broken-"));
    writeFileSync(join(broken, "plugin.json"), "{}");
    await expect(packArtifact(broken)).rejects.toBeInstanceOf(CliError);
    const src = mkdtempSync(join(tmpdir(), "as-src-"));
    mkdirSync(join(src, "src"));
    writeFileSync(join(src, "src", "plugin.cpp"), "// code");
    mkdirSync(join(src, "dist"));
    writeFileSync(join(src, "dist", "ignored.txt"), "x");
    const out = mkdtempSync(join(tmpdir(), "as-pack-"));
    const result = await packArtifact(gainDist, { outDir: out, includeSource: { dir: src } });
    const entries = tarEntries(new Uint8Array(readFileSync(result.archivePath)));
    expect(entries).toContain("source/src/plugin.cpp");
    expect(entries.some((e) => e.includes("ignored"))).toBe(false);
  });
});

describe("test command", () => {
  it("generates inputs and expectations", () => {
    expect(Array.from(generateInput("impulse", 4))).toEqual([1, 0, 0, 0]);
    expect(Array.from(generateInput("constant:0.5", 2))).toEqual([0.5, 0.5]);
    expect(Array.from(generateInput([1, 2], 9))).toEqual([1, 2]);
    expect(generateInput("ramp", 8)[0]).toBe(-1);
    expect(Array.from(expectedOutput("input*0.5", Float32Array.from([1, -1])))).toEqual([0.5, -0.5]);
    expect(Array.from(expectedOutput("silence", Float32Array.from([1, -1])))).toEqual([0, 0]);
    expect(() => generateInput("nope", 1)).toThrow(CliError);
  });

  it.skipIf(!available)("runs generic checks and vectors against the reference plugin", async () => {
    const result = await testArtifact(gainDist, vectors);
    expect(result.results.filter((r) => !r.ok)).toEqual([]);
    expect(result.results.length).toBeGreaterThan(10);
    await expect(testArtifact(resolve(tmpdir()), undefined)).rejects.toBeInstanceOf(CliError);
  });
});

describe.skipIf(!available)("testArtifact --update", () => {
  it("records the current output for cases without an expectation and rewrites the vector file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-vectors-"));
    const file = join(dir, "vectors.json");
    writeFileSync(file, JSON.stringify({ tolerance: 1e-6, cases: [
      { name: "recorded ramp at half gain", parameters: { gain: 0.5 }, input: "ramp", frames: 8, channels: 1 },
      { name: "already has an expectation", parameters: { gain: 2 }, input: "constant:0.25", expect: "input*2" },
    ] }, null, 2));
    const before = await testArtifact(gainDist, file);
    expect(before.ok).toBe(false);
    expect(before.results.find((r) => r.name === "recorded ramp at half gain")?.message).toContain("--update");

    const updated = await testArtifact(gainDist, file, { update: true });
    expect(updated.recorded).toEqual(["recorded ramp at half gain"]);
    expect(updated.ok).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { cases: { name: string; expect?: unknown }[] };
    const recorded = saved.cases[0]!.expect as number[];
    expect(recorded).toHaveLength(8);
    expect(recorded[0]).toBeCloseTo(-0.5, 6); // ramp starts at -1, gain 0.5
    expect(saved.cases[1]!.expect).toBe("input*2");

    const again = await testArtifact(gainDist, file, { update: true });
    expect(again.recorded).toEqual([]); // nothing left to record
    expect(again.ok).toBe(true);
  });
});
