---
title: "Web app integration"
description: "Recipes for the app side: React first, then plain TypeScript and other frameworks, bundlers, audio sources, chains, custom controls, saving state, errors and deployment."
---

Recipes for the application side. React comes first, then the plain TypeScript path, bundlers, audio sources, running several plugins, your own controls, saving state, errors and deployment. [Host integration](../host-integration/) is the API reference behind all of this, and [From your DSP to a web app](../from-dsp-to-web/) walks one app through from start to finish.

## React

Two commands cover the common cases:

```sh
audiospan create lowpass --language cpp --app react   # new plugin + new Vite/React app, wired together
npx @audiospan/cli init --language cpp --name lowpass  # inside an existing React project (Vite, Next.js, CRA, …)
```

Both give you a component in `src/audiospan/` (or `app/audiospan/` in a Next.js app router project) that is the whole integration, typed declarations in `src/plugins/`, and a plugin project that builds straight into `public/plugins/<name>/`. `init` also adds `@audiospan/react`, `@audiospan/cli` as a devDependency, and the `plugin` and `plugin:watch` scripts to `package.json`. It never edits your source files. The component starts with `"use client"`, so it works unchanged as a Next.js client component.

If you would rather write your own, these are the hooks and components:

```tsx
import { BypassButton, Knob, Meter, Meters, ParameterControl, ParameterControls, PresetSelect, Slider, useAudioSource, useAudiospanHost, useParameter, usePlugin } from "@audiospan/react";
import type { LowpassPlugin } from "./plugins/lowpass.js";

function Effect() {
  const audio = useAudiospanHost({ onError: console.error });          // { host, audioContext, status, error, start, stop }
  const plugin = usePlugin<LowpassPlugin>(audio.host, "/plugins/lowpass/plugin.json"); // { plugin, descriptor, status, values, outputs, setParameter, loadPreset, … }
  const mic = useAudioSource(audio, "microphone");                      // or an <audio> element, MediaStream, AudioBuffer, AudioNode, (ctx) => node
  const cutoff = useParameter(plugin, "cutoff");                        // { value, normalized, set, setNormalized, format, model } for a custom control

  return (
    <>
      <button onClick={() => void audio.start()} disabled={audio.status !== "idle"}>Start audio</button>
      <Knob plugin={plugin} id="cutoff" />                              {/* or <Slider>, <Toggle>, <Select>, <Stepper> */}
      <ParameterControl plugin={plugin} id="q" />                       {/* label + fitting control + value */}
      <ParameterControls plugin={plugin} />                             {/* every parameter */}
      <Meter plugin={plugin} id="level" /> <Meters plugin={plugin} />
      <PresetSelect plugin={plugin} /> <BypassButton plugin={plugin} />
      <input type="range" min={0} max={1} step={0.001} value={cutoff.normalized} onChange={(e) => cutoff.setNormalized(Number(e.target.value))} />
      <p>{mic.status === "error" ? mic.error?.message : cutoff.format(cutoff.value)}</p>
    </>
  );
}
```

Pass the generated type to `usePlugin` and `plugin.values.cutoff`, `plugin.setParameter("cutoff", …)`, `plugin.outputs.level` and `plugin.loadPreset("dark")` are all checked at compile time. A typo is an error. `<PluginPanel plugin={plugin.plugin} />` renders the whole default panel when you do not want to compose controls yourself. The controls share the class names and stylesheet of the default panel, so they match it out of the box and you can restyle them with plain CSS. Every component takes `className`.

Lifecycle: call `start()` from a user gesture. `stop()` and unmounting dispose everything. The hooks are safe under StrictMode and hot reloading; each mount owns one instance, and a test pins that down. `useAudioSource` connects when the host is running and disconnects when it stops, when the source changes, or when the component unmounts. Microphone tracks and buffer sources it created are stopped; nodes and streams you pass in are left alone. Under the hooks sits `createPluginStore` from `@audiospan/sdk`, a framework-neutral `subscribe` and `getSnapshot` store. Vue, Svelte and Solid adapters are thin wrappers over it.

`@audiospan/react` re-exports everything from `@audiospan/sdk` and `@audiospan/ui`, so it is the only package a React app needs.

## What has to be served

| File | From | Served as |
| --- | --- | --- |
| A plugin artifact: `plugin.json`, `module.wasm`, `presets/` (and `plugin.d.ts` for your editor) | The `dist/` folder of `audiospan build`, or an unpacked `.audiospan.tar.gz` | `application/json`, `application/wasm`; same origin, or CORS plus `allowedPluginOrigins` |
| Your page and script | `npm install @audiospan/sdk @audiospan/ui` (`@audiospan/react` for the hooks) | As usual |

The AudioWorklet script is embedded in the SDK and loaded through a blob URL, so it is not a file you serve. If your Content Security Policy forbids `blob:` in `script-src`, serve `node_modules/@audiospan/runtime/dist/audiospan-worklet.js` as a static file and pass its URL as `workletUrl`. It has to come from the same version as the SDK, or host creation fails with `WORKLET_INIT_FAILED` and the protocol version in the message.

## Bundlers

**Vite.** Static files in `public/` are served at the root, so the plugin artifact goes there:

```sh
mkdir -p public/plugins
cp -r ../my-plugin/dist public/plugins/my-plugin
```

```ts
const host = await AudiospanHost.create({ audioContext });
const plugin = await host.addPlugin<MyPlugin>("/plugins/my-plugin/plugin.json");
```

Point `typesOut` in the plugin's `audiospan.config.json` at your app (`"typesOut": "../app/src/plugins/my-plugin.d.ts"`) and `audiospan build` keeps the typed ids in your source tree. Vite serves `.wasm` with the right type in development and production.

**Next.js.** Same layout under `public/`. Create the `AudioContext` and the host inside a client component (`"use client"`), from a click handler. Never do it at module scope, since the server render has no `AudioContext`. With `@audiospan/react`, call `useAudiospanHost` in the client component and `start()` from the button.

**webpack, Create React App, Angular.** Copy the artifact into the static assets folder the tool already serves (`public/`, or `src/assets/` with an `assets` entry in `angular.json`) and reference it by absolute URL.

**No bundler.** `@audiospan/sdk/bundle` and `@audiospan/ui/bundle` are single-file ES modules with the worklet embedded. Copy them next to your page and import them with relative paths. `examples/vanilla-web` does exactly this.

## Starting audio (without the hooks)

Browsers only start audio from a user gesture. Create or resume the `AudioContext` inside a click or key handler, and create the host there:

```ts
button.addEventListener("click", async () => {
  const audioContext = new AudioContext();   // or an existing one: await audioContext.resume()
  const host = await AudiospanHost.create({ audioContext, onError: console.error });
  …
});
```

One host per `AudioContext`. It owns one `AudioWorkletNode`, and every plugin instance runs inside that node as a serial chain. In React, `useAudiospanHost()` owns both and gives you `start()` for the click handler.

## Audio sources

Any `AudioNode` can feed the chain through `host.connectSource(node)`. The chain output goes wherever `host.connectDestination(node)` points, usually `audioContext.destination`.

```ts
// Microphone
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
host.connectSource(audioContext.createMediaStreamSource(stream));

// An <audio> or <video> element (same-origin, or served with CORS, or the output is silent)
host.connectSource(audioContext.createMediaElementSource(document.querySelector("audio")!));

// A decoded file
const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
const source = new AudioBufferSourceNode(audioContext, { buffer, loop: true });
source.start();
host.connectSource(source);

// Several sources: connect each; the node mixes them.
```

Set `maxChannels` on the host for more than stereo. The chain runs at that channel count and each plugin has to accept it (`channels.min` to `channels.max` in its manifest). Mono sources are duplicated to every channel.

## Loading plugins

```ts
const plugin = await host.addPlugin("/plugins/my-plugin/plugin.json");          // load + instance + chain in one call
const plugin = await host.addPlugin<MyPlugin>(url);                             // typed ids from dist/plugin.d.ts

const descriptor = await host.loadPlugin("/plugins/my-plugin/plugin.json");    // step by step: by URL
const descriptor = await host.loadPlugin({ manifest, moduleBytes, presets });   // inline, e.g. bundled or from IndexedDB
```

`addPlugin` is what most apps need, and what `usePlugin` and `createPluginStore` call. It loads the plugin if this host has not yet, creates an instance, and appends it to the active chain, creating and connecting one if needed. Loading validates the manifest, fetches and inspects the module, and hands the bytes to the worklet, which compiles once. The descriptor (`plugin.descriptor`, or the return value of `loadPlugin`) has everything the UI needs: `parameters` (with `index`, range, default, `scale`, `display`), `outputs`, `presets`, `latencyFrames`, capabilities, and the normalized `manifest`. Each plugin is loaded once per host; create as many instances as you need.

Plugins from another origin need both CORS headers on the files and `pluginPolicy: { allowedPluginOrigins: ["https://plugins.example.com"] }`. `allowRemotePlugins: true` turns the check off. The policy also caps manifest, module, memory and state sizes, and takes an `allowPlugin(manifest, url)` hook for your own allow or block list.

## Instances and chains

```ts
const eq = await host.addPlugin("/plugins/eq/plugin.json");                                   // first in the chain
const comp = await host.addPlugin("/plugins/comp/plugin.json", { initialState: savedCompState }); // appended after it

const chain = host.getActiveChain()!;
chain.move(comp.id, 0);        // reorder: edits apply atomically at a block boundary
await chain.flush();           // wait for the runtime to acknowledge pending edits
await eq.dispose();            // removes it from the chain too
```

For full control, `host.createChain()`, `chain.add(instance, index)`, `chain.remove(id)` and `host.connectChain(chain)` do the same steps by hand.

Up to `maxPlugins` instances (8 by default) can exist at once. An empty chain passes audio through. Bypass is per instance (`plugin.setBypassed(true)`) and handled by the runtime without calling the plugin.

## Controls: generated or your own

The quickest UI is the generated panel: header, bypass, reset, presets, one control per parameter, a meter per output, and a status line.

```ts
import { renderPluginPanel } from "@audiospan/ui";
const panel = renderPluginPanel(container, plugin, { header: false });
panel.destroy();   // on teardown
```

For your own design, use the pure models and the instance API:

```ts
import { createControlModels, createOutputModels } from "@audiospan/ui";

for (const control of createControlModels(descriptor)) {
  // control.kind: "knob" | "slider" | "stepper" | "toggle" | "select"
  // control.min/max/step/defaultValue/options, control.format(value), control.toNormalized/fromNormalized
  // control.scaled is true for logarithmic or skewed parameters: drive sliders in normalized space.
  // control.bipolar and control.automatable are display hints from the manifest.
}
plugin.setParameter("cutoff", 440);                 // real units, clamped
plugin.setParameterNormalized("cutoff", 0.5);       // control position, mapped through the scale
plugin.on("parameterchange", (e) => render(e.parameterId, e.value, e.normalized));

for (const meter of createOutputModels(descriptor)) { /* meter.min/max, meter.format(value) */ }
plugin.on("outputs", (e) => updateMeters(e.values));          // ~30 times per second while audio runs
plugin.on("latencychange", (e) => showLatency(e.latencyFrames));
```

In React, see the section at the top: `useParameter` gives you exactly this per parameter, and `<Knob>`, `<Slider>`, `<Meter>` and friends are ready to use. For Vue, Svelte or Solid, `createPluginStore(host, source)` from the SDK provides `subscribe`, `getSnapshot` (values, outputs, status, descriptor) and `dispose`. That is all a framework adapter needs, and the control models above are plain objects.

## Presets and persistence

```ts
await plugin.loadPreset("dark");                     // from the manifest's presets
const state = await plugin.getState();               // { schemaVersion, pluginId, pluginVersion, parameters, opaqueState? }
localStorage.setItem(key, JSON.stringify(state));    // JSON-safe; the plugin's bytes are base64 inside
await plugin.setState(JSON.parse(localStorage.getItem(key)!));
```

Pass a saved state as `initialState` to `createPlugin` to restore it before the first block. `setState` validates first (`INVALID_STATE` lists the problems), then the runtime applies the parameters and the blob as one unit and rolls back if the plugin refuses. Unknown parameters are ignored with warnings unless you pass `{ strict: true }`.

## Errors and diagnostics

Every failure is an `AudiospanError` with a stable `code`. Request failures reject the promise you awaited. Unsolicited ones, such as a plugin failing repeatedly and being bypassed, or a refused chain edit, reach `onError` or `host.on("error")` and the instance's own `error` event. With nothing listening, the SDK warns on the console rather than dropping them.

```ts
try {
  await host.loadPlugin(url);
} catch (error) {
  if (error instanceof AudiospanError) console.error(error.code, error.message, error.issues);
}
plugin.on("statuschange", (e) => { if (e.status === "error") offerReset(); });   // plugin.reset() recovers
```

`diagnostics: true` on the host adds a stream of `diagnostic` events: load timing, parameter clamping, processing time per block against the budget, non-finite output, memory growth. `pluginLogging: true` also accepts plugins built with `audiospan build --dev` and delivers their log lines (`host.on("pluginlog")`, or the console). Both are development aids. Leave them off in production. [Troubleshooting](../troubleshooting/) lists the common codes and what to do about them.

## Testing without a browser

`@audiospan/sdk/testing` runs the real runtime in-process in Node, with the real WASM, so you can unit-test your integration code:

```ts
import { createInProcessRuntime } from "@audiospan/sdk/testing";
const rt = createInProcessRuntime();
const host = await AudiospanHost.create({ transport: rt.transport, sampleRate: 48000 });
await host.loadPlugin({ manifest, moduleBytes });
…
rt.process(inputs, outputs);   // one block, planar Float32Arrays
```

For browser tests, render through an `OfflineAudioContext`. The host works unchanged, and `await host.sync()` before `startRendering()` guarantees every message has been applied. `tests/browser/pages/offline.html` in the repository is a working harness.

## Deployment checklist

- HTTPS or `localhost`. AudioWorklet needs a secure context.
- `.wasm` as `application/wasm`, `.js` as `text/javascript`, `.json` as `application/json`.
- Worklet and plugins on the page's origin, or CORS plus `allowedPluginOrigins`.
- CSP: `script-src` needs `'wasm-unsafe-eval'` so the worklet can compile modules, and `blob:` for the embedded worklet (or serve the worklet file and pass `workletUrl`). Cross-origin isolation, `SharedArrayBuffer` and WASM threads are not required.
- Put versions in plugin paths, or hash the files, so caches never mix a new manifest with an old module.
- Create the `AudioContext` from a gesture. Show a start button.
