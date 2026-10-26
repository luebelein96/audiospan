---
title: "Host integration"
description: "The @audiospan/sdk API: creating a host, loading plugins, instances, chains, errors, diagnostics and disposal."
---

`@audiospan/sdk` is the host side of Audiospan. It owns one `AudioWorkletNode` running the runtime, a plugin registry, the plugin instances, and the active chain. Host code never touches WASM memory. Everything crosses to the audio thread as validated messages.

## Creating a host

```ts
const host = await AudiospanHost.create({
  audioContext,                       // your AudioContext or OfflineAudioContext
  workletUrl: undefined,              // default: the worklet embedded in the SDK, loaded through a blob URL
  maxPlugins: 8,                      // default 8 (policy.maxInstances)
  maxChannels: 2,                     // default 2; channel count of the chain
  maxFrames: 128,                     // default 128; largest render quantum accepted
  diagnostics: false,                 // default false
  scanNonFinite: false,               // default false; zero NaN/Infinity output samples after each plugin
  processErrorBypassThreshold: 3,     // default 3; failed blocks in a row before an instance is bypassed
  diagnosticsPerSecond: 20,           // default 20; rate limit for unsolicited messages from the audio thread
  outputsPerSecond: 30,               // default 30; how often plugin output values (meters) are delivered; 0 disables
  pluginLogging: false,               // default false; accept `audiospan build --dev` modules and surface their log lines
  onError: (error) => {},
  onDiagnostic: (event) => {},
  pluginPolicy: { allowedPluginOrigins: ["https://plugins.example.com"] },
  requestTimeoutMs: 10_000,
});
```

`create()` loads the worklet with `audioContext.audioWorklet.addModule(...)`, builds the node (`numberOfInputs: 1`, `numberOfOutputs: 1`, `outputChannelCount: [maxChannels]`, explicit channel count), sends `INIT` and waits for `READY`. Without `workletUrl`, the SDK uses the copy of `audiospan-worklet.js` embedded in it, through a short-lived blob URL, so there is nothing to copy or serve. Pass `workletUrl` when a Content Security Policy forbids `blob:` scripts; point it at `@audiospan/runtime/dist/audiospan-worklet.js` from the same version as the SDK. Failures reject with `WORKLET_INIT_FAILED` (including a worklet built for a different protocol version) or `NOT_SUPPORTED`. The SDK never creates an `AudioContext` itself. `useAudiospanHost` in `@audiospan/react` does.

`pluginLogging` is for development. It grants the `env.audiospan_log` import that `audiospan build --dev` modules carry and delivers their lines through `host.on("pluginlog")` and the instance's `log` event, or to the console when nobody listens. Leave it off in production; modules that import the log function are then rejected at load.

For non-browser hosts and tests there are `transport` (a `WorkletTransport`) with `sampleRate`, and `fetch`. `@audiospan/sdk/testing` provides `createInProcessRuntime()`, which runs the real runtime in-process. The SDK's own tests use it with the compiled gain plugin.

## Loading plugins

```ts
const plugin = await host.addPlugin("/plugins/gain/plugin.json");        // load + createPlugin + active chain, in one call
const plugin = await host.addPlugin<GainPlugin>(url, { initialState, index: 0 }); // typed ids from dist/plugin.d.ts

const descriptor = await host.loadPlugin("/plugins/gain/plugin.json");   // or step by step: URL
const descriptor = await host.loadPlugin({ manifest, moduleBytes, presets, sourceUrl }); // inline
const descriptor = await host.loadPlugin(url, { signal: controller.signal }); // abortable
```

`addPlugin` loads the plugin unless this host already has it (same URL or same plugin id), creates an instance with the given `CreatePluginOptions`, and adds it to the active chain at `index`, creating and connecting a chain if there is none. Disposing the instance removes it again. The type parameter takes a `TypedPluginInstance`, like the ones `audiospan build` writes to `dist/plugin.d.ts`, which narrows `setParameter`, `getOutput`, `loadPreset` and friends to the plugin's ids.

`createPluginStore(host, source, options)` wraps `addPlugin` in a framework-neutral store with `subscribe(listener)`, `getSnapshot()`, `ready()` and `dispose()`. The snapshot is an immutable `{ plugin, descriptor, status, error, values, outputs, bypassed, latencyFrames }` that only changes identity when something changed. `usePlugin` in `@audiospan/react` is `useSyncExternalStore` over it, and adapters for other frameworks can be built the same way.

Loading goes like this. The manifest is fetched and validated (size, schema, policy). `entry.wasm` and the preset paths are resolved relative to the manifest, with traversal rejected. The module is fetched, with the size limit enforced while the body streams, so an oversize download is abandoned at the limit. The binary is inspected for the required exports, the allowed imports and a memory maximum within `min(manifest.resources.maxMemoryBytes, policy.maxMemoryBytes)`, then run through `WebAssembly.validate`. The bytes go to the worklet, which compiles once, probe-instantiates and acknowledges. Presets are fetched at the same time. Those that fail validation are dropped, with warnings on `descriptor.warnings` and a `plugin-load-warning` diagnostic, and never block the plugin. An `AbortSignal` rejects the load with `ABORTED` up to the point where the module is handed to the runtime.

`PluginDescriptor` has `id`, `name`, `version`, `vendor`, `parameters` (normalized, with `index`, `min`, `max`, `default`, `step`, `options`, `scale`, `skew`, `automatable`, `display`), `outputs` (normalized read-only values with `index`, `min`, `max`, `display`), `audioInputs`, `audioOutputs`, `capabilities`, `resources`, `latencyFrames` (the manifest's static declaration), `presets`, `sourceUrl`, `moduleByteLength`, `warnings`, and the normalized `manifest`.

Modules built by the Audiospan CLI use WebAssembly SIMD. Every current browser supports it. Where it is missing, loading fails with `MODULE_INVALID` and a message that names SIMD, and `wasmSimdSupported()` lets an application check first.

Also available: `host.getPlugin(id)`, `host.listPlugins()`, and `host.unloadPlugin(id)`, which fails with `PLUGIN_IN_USE` while instances exist.

## Instances

```ts
const plugin = await host.createPlugin(descriptor.id, { initialState, instanceId });
const typed = await host.createPlugin<GainPlugin>(descriptor.id);   // same, with compile-time checked ids
```

Creation is rejected with `INSTANCE_LIMIT` at `maxPlugins`, and with `INVALID_STATE` if `initialState` is invalid. When `initialState` has an `opaqueState`, the runtime applies the blob first and the explicit parameters after it, so parameter values always win.

`PluginInstance`:

| Member | Behaviour |
| --- | --- |
| `setParameter(id, value)` | Synchronous. Throws `INVALID_PARAMETER` for unknown ids or non-finite values. Clamps to `[min, max]`, quantizes to `step`, rounds integers and snaps enums to the nearest option. If it had to adjust the value, it emits `parameterchange` with `clamped: true` and a `parameter-clamped` diagnostic. Posts `SET_PARAMETER` with a sequence number. |
| `getParameter(id)` | The last applied value, from the control-plane mirror. No round trip. |
| `readParameter(id)` | Asks the runtime for the value the plugin holds right now (one round trip). Useful for checking; does not change the mirror. |
| `setParameterNormalized` / `getParameterNormalized` | `[0, 1]` to and from the real value. Enums map by option index. |
| `resetParameters()` | Every parameter back to its manifest default. |
| `getOutput(id)` / `getOutputs()` | The latest read-only output values (manifest `outputs`: meters, gain reduction). Refreshed `outputsPerSecond` times a second while audio runs; each refresh raises `outputs` with the values keyed by id. Values start at each output's `min`. `INVALID_PARAMETER` for unknown ids. |
| `latencyFrames` | The latency the plugin reports through the optional `audiospan_get_latency`, or the manifest's `audio.latencyFrames`. Updated after parameter and state changes; `latencychange` fires when it moves. The runtime does not compensate for it. |
| `setBypassed(bool)` / `isBypassed()` | Host-managed bypass. The runtime copies input to output without calling the plugin. |
| `reset()` | `audiospan_reset`: clears DSP history, keeps parameters, and clears an `error` status. |
| `getState()` | `{ schemaVersion: 1, pluginId, pluginVersion, parameters, opaqueState? }`. The opaque part is the plugin's own bytes, base64 encoded, and only present if `capabilities.state`. |
| `setState(state, { strict })` | Validates first (plugin id, schema version, finite values, size). The runtime then applies it as one unit, opaque bytes first and parameters second, after snapshotting the instance, so a refused blob or parameter restores the previous state. The reply carries every parameter as the plugin now holds it, so parameters an opaque blob changed are mirrored on the control plane too, with `parameterchange` events (source `state` or `preset`), even when the document did not list them. Unknown parameters are ignored with warnings unless `strict`. |
| `loadPreset(id)` | Applies a packaged preset, or fails with `PRESET_NOT_FOUND`. |
| `on(event, listener)` | `parameterchange`, `bypasschange`, `statechange`, `statuschange`, `error`, `outputs`, `latencychange`, and `log` (development builds with `pluginLogging`). Returns an unsubscribe function. All listeners are dropped on dispose. |
| `status` | `created` → `ready` → (`error`) → `disposed`. `error` means the runtime bypassed the instance after repeated processing failures. `reset()` or `setState()` returns it to `ready`. |
| `dispose()` | Destroys the runtime instance and removes it from any chain. |

## Chains and the audio graph

```ts
const chain = host.createChain();
chain.add(pluginA);
chain.add(pluginB, 0);        // insert at index
chain.move(pluginB.id, 1);
chain.remove(pluginA.id);
await chain.flush();          // wait for pending runtime acknowledgements
await host.connectChain(chain);
```

`add`, `move` and `remove` return at once and throw `CHAIN_ERROR` for bad arguments. Each edit sends a `REPLACE_CHAIN` command, which the runtime applies atomically at a block boundary and acknowledges in order. A commit the runtime refuses is reported through `host.on("error")`; `flush()` itself never rejects. Edits on a chain that is not connected stay local until `connectChain`. Only one chain is active per host. Connecting another replaces it, and disposing the active chain empties it in the runtime and leaves the host without an active chain. Disposing an instance removes it from its chain. An empty chain passes audio through.

`host.connectSource(node)`, `host.connectDestination(node)` and their `disconnect*` counterparts wire the worklet node into your graph. `host.node` is the `AudioWorkletNode` if you need it directly, for example to attach an analyser.

`await host.sync()` resolves once the runtime has processed every message sent so far. That is useful before `OfflineAudioContext.startRendering()`.

## Errors and diagnostics

`host.on("error", listener)` receives unsolicited runtime errors (for example `INSTANCE_ERRORED`) and chain-commit failures. Request failures reject the returned promise instead. All of them are `AudiospanError` with `code`, optional `issues` (validation), `runtimeCode`, `pluginId` and `instanceId`. If an error arrives and nothing is listening, on the host or on the instance it concerns, the SDK prints a `console.warn` rather than dropping it.

`host.on("pluginlog", listener)` receives `PluginLogEvent` (`pluginId`, `instanceId`, `level`, `message`, `dropped`) from plugins built with `audiospan build --dev`, when `pluginLogging` is on. The same line also reaches the instance's `log` listeners. With no listener on either, the SDK prints it to the console, so development output is never lost. Lines are rate limited on the audio thread with their own token bucket; `dropped` counts what was discarded before the delivered line.

`host.on("diagnostic", listener)` receives `AudiospanDiagnostic` events when `diagnostics: true`: load start, success, failure and warning; instance created and disposed; `parameter-update`, `parameter-clamped`, `state-restore`, `audio-processing-error`, `processing-over-budget`, `processing-stats` (median, p95, p99 and max per second), `non-finite-output`, `memory-growth`, `chain-replaced`, `frames-unsupported` and `diagnostics-dropped`. Runtime-side diagnostics are rate limited (20 per second by default) and never involve console logging from the audio thread.

## Disposal

`await host.dispose()` sends `DISPOSE`, marks every instance and chain as disposed, clears listeners, disconnects the node and closes the message port. Pending requests reject with `DISPOSED`. The host does not close your `AudioContext`.
