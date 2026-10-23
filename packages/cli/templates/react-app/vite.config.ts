import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Nothing Audiospan-specific is needed: the plugin artifact under public/plugins/ is served as static files,
// .wasm gets the right MIME type, and the AudioWorklet script is embedded in @audiospan/react.
export default defineConfig({
  plugins: [react()],
});
