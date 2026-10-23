import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const here = fileURLToPath(new URL(".", import.meta.url));

await build({
  entryPoints: [`${here}src/worklet/processor.ts`],
  outfile: `${here}dist/audiospan-worklet.js`,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: { js: `/* @audiospan/runtime worklet v${pkg.version} */` },
  logLevel: "info",
});
