import { describe, expect, it } from "vitest";
import { emccCommand, parseProjectConfig } from "../src/lib.js";

const raw = { language: "cpp", sources: ["src/plugin.cpp"], includeDirs: ["include"] };

describe("build flags", () => {
  it("enables SIMD and LTO by default and lets the config turn them off", () => {
    const defaults = parseProjectConfig(raw, "/p");
    expect(defaults.cpp).toMatchObject({ simd: true, lto: true });
    const command = emccCommand(defaults, 16 * 1024 * 1024, "/p/dist/module.wasm");
    expect(command).toContain("-msimd128");
    expect(command).toContain("-flto");
    expect(command).not.toContain("-DAUDIOSPAN_ENABLE_LOG=1");
    const plain = emccCommand(parseProjectConfig({ ...raw, cpp: { simd: false, lto: false } }, "/p"), 16 * 1024 * 1024, "/p/dist/module.wasm");
    expect(plain).not.toContain("-msimd128");
    expect(plain).not.toContain("-flto");
  });

  it("defines AUDIOSPAN_ENABLE_LOG for development builds", () => {
    const command = emccCommand(parseProjectConfig(raw, "/p"), 16 * 1024 * 1024, "/p/dist/module.wasm", true);
    expect(command).toContain("-DAUDIOSPAN_ENABLE_LOG=1");
  });
});
