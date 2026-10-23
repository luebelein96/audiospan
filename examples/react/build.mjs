import { build } from "esbuild";
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = `${here}../../`;
await build({
  entryPoints: [`${here}src/main.tsx`],
  outfile: `${here}dist/app.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: true,
  logLevel: "info",
});
const artifact = `${root}plugins/gain-cpp/dist`;
if (existsSync(`${artifact}/module.wasm`)) cpSync(artifact, `${here}plugins/gain`, { recursive: true });
else console.warn("plugins/gain-cpp/dist not built; run `pnpm build:wasm` first");
