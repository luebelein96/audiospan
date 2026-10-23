import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, TEMPLATES, buildPlugin, createProject, detectEmcc, loadProjectConfig, testArtifact, validateProjectName, type TemplateName } from "../src/lib.js";

describe("createProject", () => {
  it("generates a C++ filter project by default, with bindings, and refuses to overwrite", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "as-create-")), "my-filter");
    const result = await createProject({ name: "my-filter", language: "cpp", directory: dir, vendor: "ACME" });
    expect(result.pluginId).toBe("com.example.my_filter");
    expect(result.files.length).toBeGreaterThanOrEqual(10);
    const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    expect(manifest.id).toBe("com.example.my_filter");
    expect(manifest.name).toBe("My Filter");
    expect(manifest.vendor).toBe("ACME");
    expect(manifest.parameters.map((p: { id: string }) => p.id)).toEqual(["cutoff", "q"]);
    expect(manifest.outputs.map((o: { id: string }) => o.id)).toEqual(["level"]);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("# My Filter");
    expect(readFileSync(join(dir, "presets/dark.json"), "utf8")).toContain("com.example.my_filter");
    expect(existsSync(join(dir, "include/audiospan/abi.h"))).toBe(true);
    expect(existsSync(join(dir, "src/biquad.h"))).toBe(true);
    const header = readFileSync(join(dir, "generated/audiospan_params.h"), "utf8");
    expect(header).toContain("kCutoff = 0,");
    expect(header).toContain("kOutLevel = 0,");
    await expect(createProject({ name: "my-filter", language: "cpp", directory: dir })).rejects.toBeInstanceOf(CliError);
    await expect(createProject({ name: "my-filter", language: "cpp", directory: dir, force: true })).resolves.toBeDefined();
    const config = await loadProjectConfig(dir);
    expect(config.language).toBe("cpp");
    expect(config.sources).toEqual(["src/plugin.cpp"]);
  });

  it("generates the minimal gain template on request", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "as-create-")), "my-gain");
    await createProject({ name: "my-gain", language: "cpp", directory: dir, template: "gain" });
    expect(existsSync(join(dir, "src/biquad.h"))).toBe(false);
    expect(readFileSync(join(dir, "src/plugin.cpp"), "utf8")).toContain("parameters()");
    expect(readFileSync(join(dir, "generated/audiospan_params.h"), "utf8")).toContain("kGain = 0,");
    expect(TEMPLATES).toEqual(["filter", "gain"]);
  });

  it("generates Rust projects with the generated module", async () => {
    for (const template of TEMPLATES) {
      const dir = join(mkdtempSync(join(tmpdir(), "as-create-")), `rusty-${template}`);
      await createProject({ name: `rusty-${template}`, language: "rust", directory: dir, pluginId: `dev.test.rusty_${template}`, template });
      expect(readFileSync(join(dir, "Cargo.toml"), "utf8")).toContain(`name = "rusty-${template}"`);
      expect(readFileSync(join(dir, "plugin.json"), "utf8")).toContain(`dev.test.rusty_${template}`);
      expect(existsSync(join(dir, "src/abi.rs"))).toBe(true);
      expect(existsSync(join(dir, ".cargo/config.toml"))).toBe(true);
      const module = readFileSync(join(dir, "generated/audiospan_params.rs"), "utf8");
      expect(module).toContain(template === "filter" ? "pub const CUTOFF: u32 = 0;" : "pub const GAIN: u32 = 0;");
      expect(readFileSync(join(dir, "src/lib.rs"), "utf8")).toContain('#[path = "../generated/audiospan_params.rs"]');
    }
  });

  it("validates names, languages, templates and ids", async () => {
    expect(() => validateProjectName("My Gain")).toThrow(CliError);
    expect(() => validateProjectName("ok-name")).not.toThrow();
    await expect(createProject({ name: "x", language: "go" as "cpp" })).rejects.toBeInstanceOf(CliError);
    await expect(createProject({ name: "x", language: "cpp", pluginId: "bad id", directory: mkdtempSync(join(tmpdir(), "as-")) })).rejects.toBeInstanceOf(CliError);
    await expect(createProject({ name: "x", language: "cpp", template: "synth" as TemplateName })).rejects.toBeInstanceOf(CliError);
  });
});

describe("buildPlugin", () => {
  for (const template of TEMPLATES) {
    it(`builds the C++ ${template} template with emcc, writes the bindings and types, and passes its vectors`, async () => {
      const emcc = await detectEmcc();
      if (!emcc.available) {
        console.warn("emcc not available; skipping C++ build test");
        return;
      }
      const dir = join(mkdtempSync(join(tmpdir(), "as-build-")), "fx");
      await createProject({ name: "fx", language: "cpp", directory: dir, template });
      const config = await loadProjectConfig(dir);
      const result = await buildPlugin(config);
      expect(existsSync(result.modulePath)).toBe(true);
      expect(result.report?.ok).toBe(true);
      expect(result.command[0]).toBe("emcc");
      expect(result.command).toContain("-Igenerated");
      expect(result.generated.map((f) => f.endsWith("generated/audiospan_params.h"))).toEqual([true]);
      expect(readFileSync(join(result.outDir, "plugin.d.ts"), "utf8")).toContain("export type FxPlugin = TypedPluginInstance<");
      const tests = await testArtifact(result.outDir, join(dir, "test/vectors.json"));
      expect(tests.results.filter((r) => !r.ok)).toEqual([]);
      if (template === "filter") {
        // The parameters() path: default state carries both values and round-trips through the runtime checks.
        expect(tests.results.map((r) => r.name)).toContain("outputs read back finite values and reject an out-of-range index");
      }
    }, 180000);
  }

  it("fails clearly when the toolchain is missing", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "as-build-")), "fx");
    await createProject({ name: "fx", language: "rust", directory: dir });
    const config = await loadProjectConfig(dir);
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      await expect(buildPlugin(config)).rejects.toMatchObject({ exitCode: 4 });
    } finally {
      process.env["PATH"] = originalPath;
    }
  });
});
