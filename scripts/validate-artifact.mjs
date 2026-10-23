#!/usr/bin/env node
// Validate one or more artifact directories: node scripts/validate-artifact.mjs plugins/gain-cpp/dist
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = resolve(root, "packages/cli/dist/index.js");
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: validate-artifact.mjs <artifact-dir> [...]");
  process.exit(2);
}
let code = 0;
for (const dir of dirs) {
  if (!existsSync(resolve(dir, "plugin.json"))) {
    console.warn(`skip ${dir}: no plugin.json (not built?)`);
    continue;
  }
  const result = spawnSync(process.execPath, [cli, "validate", dir], { stdio: "inherit" });
  if (result.status !== 0) code = result.status ?? 1;
}
process.exit(code);
