import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as abi from "@audiospan/runtime";

const root = fileURLToPath(new URL("../../", import.meta.url));
const header = readFileSync(resolve(root, "abi/include/audiospan/abi.h"), "utf8");

describe("ABI header stays in sync", () => {
  it("vendored copies match the canonical header and Rust bindings", () => {
    for (const file of ["abi.h", "effect.hpp"]) {
      const canonical = readFileSync(resolve(root, "abi/include/audiospan", file), "utf8");
      for (const target of ["packages/cli/templates/cpp-filter/include/audiospan", "packages/cli/templates/cpp-gain/include/audiospan", "plugins/gain-cpp/include/audiospan"]) {
        expect(readFileSync(resolve(root, target, file), "utf8"), `${target}/${file}`).toBe(canonical);
      }
    }
    const rust = readFileSync(resolve(root, "abi/rust/abi.rs"), "utf8");
    for (const target of ["packages/cli/templates/rust-filter/src/abi.rs", "packages/cli/templates/rust-gain/src/abi.rs", "plugins/gain-rust/src/abi.rs"]) {
      expect(readFileSync(resolve(root, target), "utf8"), target).toBe(rust);
    }
  });

  it("runtime constants mirror the header", () => {
    expect(header).toContain(`#define AUDIOSPAN_ABI_VERSION ${abi.ABI_VERSION}u`);
    for (const [name, value] of [
      ["AS_OK", abi.AS_OK], ["AS_ERROR_GENERIC", abi.AS_ERROR_GENERIC], ["AS_ERROR_INVALID_ARGUMENT", abi.AS_ERROR_INVALID_ARGUMENT],
      ["AS_ERROR_UNSUPPORTED", abi.AS_ERROR_UNSUPPORTED], ["AS_ERROR_OUT_OF_MEMORY", abi.AS_ERROR_OUT_OF_MEMORY], ["AS_ERROR_BAD_STATE", abi.AS_ERROR_BAD_STATE],
      ["AS_ERROR_BUFFER_TOO_SMALL", abi.AS_ERROR_BUFFER_TOO_SMALL], ["AS_ERROR_INVALID_FORMAT", abi.AS_ERROR_INVALID_FORMAT],
    ] as const) {
      expect(header).toMatch(new RegExp(`${name} = ${value}[,\\s]`));
    }
    for (const name of abi.REQUIRED_FUNCTION_EXPORTS) expect(header, name).toContain(`${name}(`);
    for (const name of abi.OPTIONAL_FUNCTION_EXPORTS) expect(header, name).toContain(`${name}(`);
    expect(header).toContain(`import_name("${abi.IMPORT_LOG}")`);
    for (const [name, value] of [["AS_LOG_ERROR", abi.AS_LOG_ERROR], ["AS_LOG_WARN", abi.AS_LOG_WARN], ["AS_LOG_INFO", abi.AS_LOG_INFO], ["AS_LOG_DEBUG", abi.AS_LOG_DEBUG]] as const) {
      expect(header).toMatch(new RegExp(`${name} = ${value}[,\\s]`));
    }
    // Struct layouts: 5 x u32 and 4 x u32 + 2 pointers on wasm32.
    expect(abi.HOST_CONFIG_STRUCT_SIZE).toBe(20);
    expect(abi.PROCESS_STRUCT_SIZE).toBe(24);
    const rust = readFileSync(resolve(root, "abi/rust/abi.rs"), "utf8");
    for (const name of abi.REQUIRED_FUNCTION_EXPORTS) expect(rust, name).toContain(`fn ${name}(`);
    for (const name of abi.OPTIONAL_FUNCTION_EXPORTS) expect(rust, name).toContain(`fn ${name}(`);
    expect(rust).toContain(`fn ${abi.IMPORT_LOG}(`);
    expect(rust).toContain(`pub const AS_LOG_DEBUG: u32 = ${abi.AS_LOG_DEBUG};`);
    expect(rust).toContain(`pub const AUDIOSPAN_ABI_VERSION: u32 = ${abi.ABI_VERSION};`);
    expect(rust).toContain(`pub const AS_ERROR_BUFFER_TOO_SMALL: AsStatus = ${abi.AS_ERROR_BUFFER_TOO_SMALL};`);
  });
});
