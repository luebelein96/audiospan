// Copy the built reference gain plugin into public/ for the live demo on the landing page.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const artifact = `${here}../../plugins/gain-cpp/dist`;
const destination = `${here}public/plugins/gain`;

if (existsSync(`${artifact}/module.wasm`)) {
  rmSync(destination, { recursive: true, force: true });
  cpSync(artifact, destination, { recursive: true });
  console.log("copied plugins/gain-cpp/dist -> apps/docs/public/plugins/gain");
} else {
  console.warn("plugins/gain-cpp/dist is not built, so the live demo will fail to load; run `pnpm build:wasm gain-cpp` first.");
}
