# Getting started

This walks through hearing the reference gain plugin in a browser, first from this repository, then from your own application.

## 1. From this repository

```sh
pnpm install
pnpm build              # TypeScript packages, worklet, SDK + UI bundles
pnpm build:wasm         # compiles plugins/gain-cpp (needs emcc) and plugins/gain-rust (needs cargo)
pnpm build:examples     # copies bundles + the gain artifact into examples/
pnpm dev                # serves examples/vanilla-web at http://127.0.0.1:8787/
```

Open the printed URL, click **Start audio**, and move the gain slider. The page is `examples/vanilla-web/index.html` with `main.js`: about sixty lines of integration code.

The developer sandbox used by `audiospan dev` is also available while that server runs: `http://127.0.0.1:8787/__audiospan/demo/?plugin=/plugins/gain/plugin.json`.

## 2. In your application

React is the first-class path. In an existing React project:

```sh
npx @audiospan/cli init --language cpp --name lowpass
npm install && npm run plugin
```

That adds `@audiospan/react` to `package.json`, a plugin project under `audiospan/lowpass/` that builds into `public/plugins/lowpass/`, typed ids in `src/plugins/lowpass.d.ts`, and `src/audiospan/Lowpass.tsx`, a component that starts audio, loads the plugin, connects the microphone, and renders knobs and meters. Render `<Lowpass />` and click Start. Nothing else is served or copied: the AudioWorklet script is embedded in the package.

Starting from scratch, `audiospan create lowpass --language cpp --app react` generates the plugin and a Vite + React app wired together.

Without React, two packages and a few lines:

```sh
npm install @audiospan/sdk @audiospan/ui
```

```ts
import { AudiospanHost } from "@audiospan/sdk";
import { renderPluginPanel } from "@audiospan/ui";

async function start(panel: HTMLElement) {
  const audioContext = new AudioContext();       // inside the click handler
  const host = await AudiospanHost.create({ audioContext, onError: (error) => console.error(error.code, error.message) });
  const plugin = await host.addPlugin("/plugins/gain/plugin.json");   // load + instance + chain
  const osc = audioContext.createOscillator();
  osc.start();
  host.connectSource(osc);
  host.connectDestination(audioContext.destination);
  renderPluginPanel(panel, plugin);              // default controls from the manifest
  return () => host.dispose();
}
```

Serve the plugin's `dist/` directory as static files from your origin, with `.wasm` as `application/wasm`.

## 3. Build your own plugin

```sh
npm install -g @audiospan/cli
audiospan doctor                              # shows which toolchains are available
audiospan create my-effect --language cpp     # or --language rust; a resonant filter with a meter and presets
cd my-effect && audiospan build && audiospan test && audiospan dev --watch
```

Then follow [From your DSP to a web app](from-dsp-to-web.md), which replaces the template's gain with a real filter and ends with the plugin running in a Vite app. [Porting existing DSP](porting-dsp.md) covers code with other shapes, and [plugin authoring](plugin-authoring.md) / [Rust plugin authoring](rust-plugin-authoring.md) are the full references.
