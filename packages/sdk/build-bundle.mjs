import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(`${here}package.json`, "utf8"));

// Single-file ESM bundle of the SDK (manifest + runtime protocol inlined) for
// buildless usage from a <script type="module">.
await build({
  entryPoints: [`${here}src/index.ts`],
  outfile: `${here}dist/audiospan-sdk.bundle.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: false,
  sourcemap: true,
  legalComments: "none",
  banner: { js: `/* @audiospan/sdk v${pkg.version} */` },
  logLevel: "info",
});

// Ship the worklet next to the SDK so apps can copy a single directory.
mkdirSync(`${here}dist`, { recursive: true });
copyFileSync(`${here}../runtime/dist/audiospan-worklet.js`, `${here}dist/audiospan-worklet.js`);
