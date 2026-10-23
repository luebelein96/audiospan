# Host integration

The host side of Audiospan is `@audiospan/sdk`. It owns one `AudioWorkletNode` running the Audiospan runtime, a plugin registry, plugin instances, and the active serial chain. Host code never touches WASM memory; everything crosses to the audio thread as validated messages.

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

`create()` loads the worklet with `audioContext.audioWorklet.addModule(...)`, constructs the node (`numberOfInputs: 1`, `numberOfOutputs: 1`, `outputChannelCount: [maxChannels]`, explicit channel count), sends `INIT`, and waits for `READY`. Without `workletUrl` the SDK uses the copy of `audiospan-worklet.js` embedded in it, through a short-lived blob URL, so nothing needs copying or serving; pass `workletUrl` when a Content Security Policy forbids `blob:` scripts, pointing it at `@audiospan/runtime/dist/audiospan-worklet.js` (the same version as the SDK). Failures reject with `WORKLET_INIT_FAILED` (including a worklet file built for a different protocol version) or `NOT_SUPPORTED`. The SDK never creates an `AudioContext` itself; `@audiospan/react`'s `useAudiospanHost` does.

`pluginLogging` is a development aid: it grants the `env.audiospan_log` import that `audiospan build --dev` modules carry and delivers their lines through `host.on("pluginlog")` and the instance's `log` event, or to the console when nobody listens. Leave it off in production; modules importing the log function are then rejected at load.

Options for non-browser hosts and tests: `transport` (a `WorkletTransport`) with `sampleRate`, and `fetch`. `@audiospan/sdk/testing` provides `createInProcessRuntime()` which runs the real runtime in-process; the SDK's own tests use it with the compiled gain plugin.

## Loading plugins

```ts
const plugin = await host.addPlugin("/plugins/gain/plugin.json");        // load + createPlugin + active chain, in one call
const plugin = await host.addPlugin<GainPlugin>(url, { initialState, index: 0 }); // typed ids from dist/plugin.d.ts

const descriptor = await host.loadPlugin("/plugins/gain/plugin.json");   // or step by step: URL
const descriptor = await host.loadPlugin({ manifest, moduleBytes, presets, sourceUrl }); // inline
const descriptor = await host.loadPlugin(url, { signal: controller.signal }); // abortable
```

`addPlugin` loads the plugin unless this host already loaded it (same URL, or same plugin id), creates an instance with the given `CreatePluginOptions`, and appends it to the active chain at `index`, creating and connecting a chain when there is none. Disposing the instance removes it again. Its type parameter accepts a `TypedPluginInstance` such as the ones `audiospan build` writes to `dist/plugin.d.ts`, which narrows `setParameter`, `getOutput`, `loadPreset` and friends to the plugin's ids.

`createPluginStore(host, source, options)` wraps `addPlugin` in a framework-neutral store: `subscribe(listener)`, `getSnapshot()` (an immutable `{ plugin, descriptor, status, error, values, outputs, bypassed, latencyFrames }` that changes identity only when something changed), `ready()` and `dispose()`. `@audiospan/react`'s `usePlugin` is `useSyncExternalStore` over it; adapters for other frameworks can be too.

Loading fetches and validates the manifest (size, schema, policy), resolves `entry.wasm` and preset paths relative to the manifest (traversal rejected), fetches the module (the size limit is enforced while the body streams, so an oversize download is abandoned at the limit), inspects the binary (required exports, allowed imports, memory maximum within `min(manifest.resources.maxMemoryBytes, policy.maxMemoryBytes)`), runs `WebAssembly.validate`, then transfers the bytes to the worklet which compiles once, probe-instantiates, and acknowledges. Presets are fetched concurrently; those that fail validation are dropped with warnings on `descriptor.warnings` and a `plugin-load-warning` diagnostic and never block the plugin. An `AbortSignal` rejects the load with `ABORTED` until the module has been handed to the runtime.

`PluginDescriptor` exposes `id`, `name`, `version`, `vendor`, `parameters` (normalized, with `index`, `min`, `max`, `default`, `step`, `options`, `scale`, `skew`, `automatable`, `display`), `outputs` (normalized read-only values with `index`, `min`, `max`, `display`), `audioInputs`, `audioOutputs`, `capabilities`, `resources`, `latencyFrames` (the manifest's static declaration), `presets`, `sourceUrl`, `moduleByteLength`, `warnings`, and the normalized `manifest`.

Modules built by the Audiospan CLI use WebAssembly SIMD. Every current browser supports it; where it is missing, loading fails with `MODULE_INVALID` and a message naming SIMD, and `wasmSimdSupported()` lets an application check up front.

`host.getPlugin(id)`, `host.listPlugins()`, `host.unloadPlugin(id)` (fails with `PLUGIN_IN_USE` while instances exist).

## Instances

```ts
const plugin = await host.createPlugin(descriptor.id, { initialState, instanceId });
const typed = await host.createPlugin<GainPlugin>(descriptor.id);   // same, with compile-time checked ids
```

Creation is rejected with `INSTANCE_LIMIT` at `maxPlugins`, and with `INVALID_STATE` if `initialState` is invalid. When `initialState` has an `opaqueState`, the runtime applies the blob first and the explicit parameters afterwards, so parameter values always win.

`PluginInstance`:

| Member | Behaviour |
| --- | --- |
| `setParameter(id, value)` | Synchronous. Throws `INVALID_PARAMETER` for unknown ids or non-finite values. Clamps to `[min, max]`, quantizes to `step`, rounds integers, snaps enums to the nearest option. Emits `parameterchange` with `clamped: true` when adjusted and a `parameter-clamped` diagnostic. Posts `SET_PARAMETER` with a sequence number. |
| `getParameter(id)` | The last applied value (control-plane mirror; no round trip). |
| `readParameter(id)` | Asks the runtime for the value the plugin currently holds (one round trip). Useful for verification; does not change the mirror. |
| `setParameterNormalized` / `getParameterNormalized` | `[0, 1]` ↔ real value; enums map by option index. |
| `resetParameters()` | Every parameter back to its manifest default. |
| `getOutput(id)` / `getOutputs()` | Latest read-only output values (manifest `outputs`: meters, gain reduction), refreshed `outputsPerSecond` times per second while audio runs; each refresh raises `outputs` with the values keyed by id. Values start at each output's `min`. `INVALID_PARAMETER` for unknown ids. |
| `latencyFrames` | The latency the plugin currently reports through the optional `audiospan_get_latency`, or the manifest's `audio.latencyFrames`. Updated after parameter and state changes; `latencychange` fires when it moves. The runtime does not compensate latency. |
| `setBypassed(bool)` / `isBypassed()` | Host-managed bypass; the runtime copies input to output without calling the plugin. |
| `reset()` | `audiospan_reset`: clears DSP history, keeps parameters, clears an `error` status. |
| `getState()` | `{ schemaVersion: 1, pluginId, pluginVersion, parameters, opaqueState? }`; the opaque part is the plugin's own bytes, base64 encoded, only if `capabilities.state`. |
| `setState(state, { strict })` | Validates first (plugin id, schema version, finite values, size), then the runtime applies it as one unit: opaque bytes first, parameters second, with the instance snapshotted beforehand so a refused blob or parameter restores the previous state. The reply carries every parameter as the plugin now holds it, so parameters an opaque blob changed are mirrored on the control plane (with `parameterchange` events, source `state`/`preset`) even when the document did not list them. Unknown parameters are ignored with warnings unless `strict`. |
| `loadPreset(id)` | Applies a packaged preset; `PRESET_NOT_FOUND` otherwise. |
| `on(event, listener)` | `parameterchange`, `bypasschange`, `statechange`, `statuschange`, `error`, `outputs`, `latencychange`, `log` (development builds with `pluginLogging`). Returns an unsubscribe function. All listeners are dropped on dispose. |
| `status` | `created` → `ready` → (`error`) → `disposed`. `error` means the runtime bypassed the instance after repeated processing failures; `reset()` or `setState()` returns it to `ready`. |
| `dispose()` | Destroys the runtime instance, removes it from any chain. |

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

`add`, `move` and `remove` are synchronous for the caller and throw `CHAIN_ERROR` for bad arguments; each edit sends a `REPLACE_CHAIN` command that the runtime applies atomically at a block boundary and acknowledges in order. A commit the runtime refuses is reported through `host.on("error")`; `flush()` itself never rejects. Edits on a chain that is not connected are local until `connectChain`. Only one chain is active per host; connecting another replaces it, and disposing the active chain empties it in the runtime and leaves the host with no active chain. Disposing an instance removes it from its chain. An empty chain passes audio through.

`host.connectSource(node)`, `host.connectDestination(node)`, and their `disconnect*` counterparts wire the worklet node into your graph. `host.node` is the `AudioWorkletNode` if you need direct access (for example to connect an analyser).

`await host.sync()` resolves once the runtime has processed every message sent so far, which is useful before `OfflineAudioContext.startRendering()`.

## Errors and diagnostics

`host.on("error", listener)` receives unsolicited runtime errors (for example `INSTANCE_ERRORED`) and chain-commit failures. Request failures reject the returning promise instead. All are `AudiospanError` with `code`, optional `issues` (validation), `runtimeCode`, `pluginId`, `instanceId`. If an error arrives and nothing is listening, neither on the host nor on the instance it concerns, the SDK prints a `console.warn` rather than dropping it.

`host.on("pluginlog", listener)` receives `PluginLogEvent` (`pluginId`, `instanceId`, `level`, `message`, `dropped`) from plugins built with `audiospan build --dev` when `pluginLogging` is on. The same line also reaches the instance's `log` listeners; with no listener on either, the SDK prints it to the console so development output is never lost. Lines are rate limited on the audio thread with their own token bucket; `dropped` counts what was discarded before the delivered line.

`host.on("diagnostic", listener)` receives `AudiospanDiagnostic` events when `diagnostics: true`: load start/success/failure/warning, instance created/disposed, `parameter-update`, `parameter-clamped`, `state-restore`, `audio-processing-error`, `processing-over-budget`, `processing-stats` (median/p95/p99/max per second), `non-finite-output`, `memory-growth`, `chain-replaced`, `frames-unsupported`, `diagnostics-dropped`. Runtime-side diagnostics are rate limited (20 per second by default) and never include console logging from the audio thread.

## Disposal

`await host.dispose()` sends `DISPOSE`, marks every instance and chain disposed, clears listeners, disconnects the node, and closes the message port. Pending requests reject with `DISPOSED`. The host does not close your `AudioContext`.
