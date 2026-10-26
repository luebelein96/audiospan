---
title: "Getting started"
description: "Hear the reference plugin in five minutes, then add Audiospan to your own app."
---

## 1. From this repository

```sh
pnpm install
pnpm build              # TypeScript packages, worklet, SDK + UI bundles
pnpm build:wasm         # compiles plugins/gain-cpp (needs emcc) and plugins/gain-rust (needs cargo)
pnpm build:examples     # copies bundles + the gain artifact into examples/
pnpm dev                # serves examples/vanilla-web at http://127.0.0.1:8787/
```

Open the URL it prints, click **Start audio** and move the gain slider. The page is `examples/vanilla-web/index.html` plus `main.js`, about sixty lines in total.

While that server runs, the sandbox from `audiospan dev` is also available at `http://127.0.0.1:8787/__audiospan/demo/?plugin=/plugins/gain/plugin.json`.

## 2. In your application

React is the main path. Inside an existing React project:

```sh
npx @audiospan/cli init --language cpp --name lowpass
npm install && npm run plugin
```

This gives you:

- `@audiospan/react` and `@audiospan/cli` in `package.json`
- a plugin project in `audiospan/lowpass/` that builds into `public/plugins/lowpass/`
- typed ids in `src/plugins/lowpass.d.ts`
- `src/audiospan/Lowpass.tsx`, a component that starts audio, loads the plugin, connects the microphone and shows knobs and meters

Render `<Lowpass />` and click Start. There is nothing else to copy or serve. The AudioWorklet script ships inside the package.

Starting from nothing? `audiospan create lowpass --language cpp --app react` makes the plugin and a Vite + React app, already wired together.

Without React you need two packages and a few lines:

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

Serve the plugin's `dist/` folder as static files from your own origin, with `.wasm` sent as `application/wasm`.

## 3. Build your own plugin

```sh
npm install -g @audiospan/cli
audiospan doctor                              # shows which toolchains it can find
audiospan create my-effect --language cpp     # or --language rust; a resonant filter with a meter and presets
cd my-effect && audiospan build && audiospan test && audiospan dev --watch
```

From here, [From your DSP to a web app](../from-dsp-to-web/) shows how to swap the template's stand-in filter for your own code and ends with the plugin running in a React app. [Porting existing DSP](../porting-dsp/) covers code that is shaped differently. The full references are [C++ plugins](../plugin-authoring/) and [Rust plugins](../rust-plugin-authoring/).
