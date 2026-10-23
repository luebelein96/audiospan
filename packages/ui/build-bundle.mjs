import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(`${here}package.json`, "utf8"));

// Single-file ESM bundle (inlines the manifest helpers it uses; no SDK runtime code).
await build({
  entryPoints: [`${here}src/index.ts`],
  outfile: `${here}dist/audiospan-ui.bundle.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: false,
  sourcemap: true,
  legalComments: "none",
  banner: { js: `/* @audiospan/ui v${pkg.version} */` },
  logLevel: "info",
});
