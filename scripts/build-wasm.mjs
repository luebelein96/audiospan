#!/usr/bin/env node
// Build every reference plugin under plugins/ with the Audiospan CLI.
// C++ requires emcc; Rust requires cargo + wasm32-unknown-unknown. Missing
// toolchains skip that plugin with a warning unless --strict is passed.
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = resolve(root, "packages/cli/dist/index.js");
const strict = process.argv.includes("--strict");
const only = process.argv.filter((a) => !a.startsWith("--")).slice(2);

if (!existsSync(cli)) {
  const tsc = spawnSync(resolve(root, "node_modules/.bin/tsc"), ["-b", "packages/cli/tsconfig.json"], { cwd: root, stdio: "inherit" });
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
}

const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const tools = { cpp: has("emcc"), rust: has("cargo") };

let failed = false;
for (const name of readdirSync(resolve(root, "plugins")).sort()) {
  if (only.length && !only.includes(name)) continue;
  const dir = resolve(root, "plugins", name);
  const configPath = resolve(dir, "audiospan.config.json");
  if (!existsSync(configPath)) continue;
  const { language } = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(configPath, "utf8")));
  if (!tools[language]) {
    const msg = `skip ${name}: ${language === "cpp" ? "emcc" : "cargo"} not found`;
    if (strict) {
      console.error(msg);
      failed = true;
    } else {
      console.warn(msg);
    }
    continue;
  }
  console.log(`building ${name} (${language})`);
  const result = spawnSync(process.execPath, [cli, "build", "--root", dir], { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
