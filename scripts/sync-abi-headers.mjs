#!/usr/bin/env node
// Copy the canonical ABI files into every place that vendors them.
// With --check, exit 1 if any copy differs (used by CI and tests).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");

export const HEADERS = ["abi.h", "effect.hpp"];
export const TARGETS = ["packages/cli/templates/cpp-filter/include/audiospan", "packages/cli/templates/cpp-gain/include/audiospan", "plugins/gain-cpp/include/audiospan"];
export const RUST_SOURCE = "abi/rust/abi.rs";
export const RUST_TARGETS = ["packages/cli/templates/rust-filter/src/abi.rs", "packages/cli/templates/rust-gain/src/abi.rs", "plugins/gain-rust/src/abi.rs"];

const copies = [
  ...HEADERS.flatMap((header) => TARGETS.map((target) => ({ source: `abi/include/audiospan/${header}`, target: `${target}/${header}` }))),
  ...RUST_TARGETS.map((target) => ({ source: RUST_SOURCE, target })),
];

let drift = 0;
for (const { source, target } of copies) {
  const expected = readFileSync(resolve(root, source), "utf8");
  let current = "";
  try {
    current = readFileSync(resolve(root, target), "utf8");
  } catch {
    current = "";
  }
  if (current === expected) continue;
  if (check) {
    console.error(`drift: ${target} differs from ${source}`);
    drift++;
  } else {
    writeFileSync(resolve(root, target), expected);
    console.log(`updated ${target}`);
  }
}
if (check && drift > 0) process.exit(1);
