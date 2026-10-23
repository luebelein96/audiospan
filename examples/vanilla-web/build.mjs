// Copies the SDK/UI bundles, the worklet, and the reference gain artifact next to index.html.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = `${here}../../`;
mkdirSync(`${here}vendor`, { recursive: true });
cpSync(`${root}packages/sdk/dist/audiospan-sdk.bundle.js`, `${here}vendor/audiospan-sdk.bundle.js`);
cpSync(`${root}packages/sdk/dist/audiospan-sdk.bundle.js.map`, `${here}vendor/audiospan-sdk.bundle.js.map`);
cpSync(`${root}packages/ui/dist/audiospan-ui.bundle.js`, `${here}vendor/audiospan-ui.bundle.js`);
const artifact = `${root}plugins/gain-cpp/dist`;
if (existsSync(`${artifact}/module.wasm`)) {
  cpSync(artifact, `${here}plugins/gain`, { recursive: true });
} else {
  console.warn("plugins/gain-cpp/dist not built; run `pnpm build:wasm` first");
}
console.log("vanilla-web example assembled");
