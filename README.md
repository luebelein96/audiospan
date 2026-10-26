# Audiospan

**Build audio plugins for the web.**

Audiospan is an SDK and runtime for building, packaging, and running audio-processing plugins in web applications. Implement a DSP effect once in C++ or Rust against a small C ABI, compile it to WebAssembly, describe it in `plugin.json`, and load it from TypeScript through one host API. The runtime executes plugins inside a single `AudioWorkletProcessor` as a serial effect chain, with host-managed buffers, bypass, state, presets, resource limits, and typed errors.

Status: **0.1.0, MVP**. Web-first, serial effects only.

## What you get

| Piece | Package / path | What it does |
| --- | --- | --- |
| Host SDK | `@audiospan/sdk` | `AudiospanHost`, plugin descriptors, instances, chains, state/presets, typed errors and diagnostics |
| Runtime | `@audiospan/runtime` | The AudioWorklet processor, WASM memory bridge, message protocol, module inspection |
| Manifest | `@audiospan/manifest` | `plugin.json` types, JSON schema, validation, parameter math, state validation |
| Default UI | `@audiospan/ui` | Framework-agnostic controls rendered from manifest metadata (knobs, sliders, meters, presets) |
| React | `@audiospan/react` | `useAudiospanHost`, `usePlugin`, `useAudioSource`, knobs, sliders, meters, presets, `<PluginPanel>`; re-exports the SDK and UI |
| CLI | `@audiospan/cli` | `audiospan create [--app react] / init / build / generate / test / validate / pack / dev / doctor` |
| ABI | `abi/include/audiospan/abi.h` | The C contract plus a C++ helper (`effect.hpp`) and Rust bindings (`abi/rust/abi.rs`) |
| Reference plugins | `plugins/gain-cpp`, `plugins/gain-rust` | The same gain effect in both languages, used by the conformance suite |
| Examples | `examples/vanilla-web`, `examples/react` | Buildless browser example and a React hook |

New here? [From your DSP to a web app](https://luebelein96.github.io/audiospan/from-dsp-to-web/) takes an existing C++ or Rust filter class to a running React app, with every file complete.

## Quickstart: a new plugin and a React app, one command

```sh
npm install -g @audiospan/cli
audiospan create lowpass --language cpp --app react    # plugin project + Vite/React app, wired together
cd lowpass-app && npm install
npm run plugin                                          # audiospan build -> public/plugins/lowpass/, src/plugins/lowpass.d.ts
npm run dev                                             # click "Start audio"
```

The generated component is the whole integration:

```tsx
import { Meters, ParameterControls, useAudioSource, useAudiospanHost, usePlugin } from "@audiospan/react";
import type { LowpassPlugin } from "../plugins/lowpass.js";   // generated: ids checked at compile time

export function Lowpass() {
  const audio = useAudiospanHost();                            // owns the AudioContext and host; start() from a click
  const plugin = usePlugin<LowpassPlugin>(audio.host, "/plugins/lowpass/plugin.json"); // load + instance + chain
  useAudioSource(audio, "microphone");                         // or an <audio> element, a stream, a buffer, a node
  return (
    <>
      <button onClick={() => void audio.start()}>Start audio</button>
      <ParameterControls plugin={plugin} />                    {/* knobs and sliders from the manifest */}
      <Meters plugin={plugin} />                               {/* the plugin's level meter */}
    </>
  );
}
```

## Quickstart: an existing React project

```sh
cd my-react-app
npx @audiospan/cli init --language cpp --name lowpass     # plugin project in audiospan/lowpass/, component in src/audiospan/Lowpass.tsx
npm install && npm run plugin                              # @audiospan/react and @audiospan/cli were added; build the plugin into public/plugins/
```

Then render `<Lowpass />` anywhere. Your DSP goes in `audiospan/lowpass/src/`; `npm run plugin:watch` rebuilds on every save.

## Quickstart: plugin only

```sh
audiospan create my-filter --language cpp   # or --language rust; --template gain for the smallest plugin
cd my-filter
audiospan build          # emcc or cargo -> dist/, regenerates generated/audiospan_params.* and dist/plugin.d.ts from plugin.json
audiospan test           # generic ABI checks + test/vectors.json in Node; --update records missing expectations
audiospan dev --watch    # sandbox with knobs, meters, presets, state and diagnostics; rebuilds on every save
audiospan pack           # deterministic dist/<id>-<version>.audiospan.tar.gz with checksums
```

Your plugin is a class with a constructor, `process()` and a `parameters()` accessor. Ranges and defaults are declared once in `plugin.json`. The helper clamps, smooths, saves and resets parameters for you.

## Without React

```ts
import { AudiospanHost } from "@audiospan/sdk";
import { renderPluginPanel } from "@audiospan/ui";

const host = await AudiospanHost.create({ audioContext });               // the worklet is embedded; nothing to copy
const plugin = await host.addPlugin<LowpassPlugin>("/plugins/lowpass/plugin.json");
host.connectSource(someAudioNode);
host.connectDestination(audioContext.destination);
renderPluginPanel(document.querySelector("#panel")!, plugin);
```

`createPluginStore(host, source)` in the SDK is the framework-neutral core behind the React hooks (subscribe / getSnapshot); adapters for other frameworks are thin wrappers over it.

## Working in this repository

Requirements: Node 20+, pnpm 11, Emscripten (`emcc`) for C++ plugins, Rust with the `wasm32-unknown-unknown` target for Rust plugins.

```sh
pnpm install
pnpm build            # worklet bundle (embedded into the SDK), TypeScript packages, SDK/UI bundles
pnpm build:wasm       # reference plugins (skips languages whose toolchain is missing)
pnpm test             # unit, ABI conformance, SDK end-to-end (Node, real WASM)
pnpm build:examples
pnpm test:browser     # Playwright + headless Chromium: real AudioWorklet rendering
pnpm bench            # Node benchmark of the processing loop
pnpm dev              # serve examples/vanilla-web
pnpm docs:dev         # documentation site at http://localhost:4321/audiospan/
```

## Documentation

Full documentation: https://luebelein96.github.io/audiospan/ (source in `apps/docs/`, an Astro Starlight site with a live demo; `pnpm docs:dev` serves it locally).

Start here:

- [From your DSP to a web app](https://luebelein96.github.io/audiospan/from-dsp-to-web/): the end-to-end tutorial, from an existing filter class to a deployed page
- [Getting started](https://luebelein96.github.io/audiospan/getting-started/): hear the reference plugin in five minutes

Writing plugins:

- [Porting existing DSP](https://luebelein96.github.io/audiospan/porting-dsp/): interleaved buffers, fixed block sizes, JUCE and VST3 concepts, denormals, dependencies
- [Plugin authoring (C++)](https://luebelein96.github.io/audiospan/plugin-authoring/) and [Rust](https://luebelein96.github.io/audiospan/rust-plugin-authoring/): the effect class contract and build options
- [Manifest schema](https://luebelein96.github.io/audiospan/manifest-schema/), [Real-time safety](https://luebelein96.github.io/audiospan/realtime-safety/), [CLI reference](https://luebelein96.github.io/audiospan/cli/)

Building apps:

- [Web app integration](https://luebelein96.github.io/audiospan/web-app-integration/): bundlers and frameworks, audio sources, chains, custom controls, persistence, deployment
- [Host integration](https://luebelein96.github.io/audiospan/host-integration/): the `@audiospan/sdk` API
- [Troubleshooting](https://luebelein96.github.io/audiospan/troubleshooting/), [Browser support](https://luebelein96.github.io/audiospan/browser-support/)

Under the hood:

- [ABI](https://luebelein96.github.io/audiospan/abi/), [Architecture](https://luebelein96.github.io/audiospan/architecture/), [Security model](https://luebelein96.github.io/audiospan/security-model/), [Future features](docs/future-features.md)

## License

MIT. See [LICENSE](LICENSE).
