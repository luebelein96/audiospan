---
title: "Architecture"
description: "The packages, the two threads and their messages, the memory bridge, and how a chain runs."
---

```
Web application
  └─ @audiospan/sdk  (main thread)
       AudiospanHost ── PluginDescriptor registry ── PluginInstance ── AudioChain
       loader (fetch + validate) · policy · RuntimeConnection (request/response, timeouts)
       │  AudioWorkletTransport (MessagePort)           ← or an in-process transport in tests
       ▼
  AudioWorkletNode "audiospan-processor"  (audio rendering thread)
       AudiospanProcessor → AudiospanRuntime
         handleMessage(): INIT · LOAD_PLUGIN · CREATE/DESTROY_INSTANCE · SET_PARAMETER · SET_BYPASS ·
                          REPLACE_CHAIN · RESET · GET/SET_STATE · GET_PARAMETER · PING · DISPOSE
         posts: READY · PLUGIN_READY · INSTANCE_READY · ACK · STATE · STATE_APPLIED · PARAMETER_VALUE · ERROR ·
                DIAGNOSTIC · OUTPUT_VALUES · LATENCY_CHANGED · LOG
         process(inputs, outputs): empty-chain pass-through | serial chain, each stage fed from the previous one's memory
         WasmPluginInstance (one per plugin instance): memory bridge over a WebAssembly.Instance
           └─ plugin module: audiospan_* exports (C++ via effect.hpp, Rust via abi.rs, or plain C)
```

## Packages

- **manifest**: pure functions and types. No DOM, no Node APIs. Used on both sides of the boundary and by the CLI.
- **runtime**: the worklet processor and everything it needs, bundled by esbuild into one IIFE (`dist/audiospan-worklet.js`). The core, `AudiospanRuntime`, uses no worklet globals, so Node tests drive it directly with real WASM.
- **sdk**: the public API. It depends on the runtime only for protocol types, constants and the binary inspector. The worklet bundle is embedded as a string (`src/generated/worklet-source.ts`, produced by `scripts/embed-worklet.mjs` before `tsc`), so `AudiospanHost.create` can load it from a blob URL with no served file.
- **ui**: a DOM renderer over a pure control model derived from the descriptor.
- **react**: `useAudiospanHost`, `usePlugin` (which wraps the SDK's `createPluginStore` with `useSyncExternalStore`), `useAudioSource`, React controls and `<PluginPanel>`. It re-exports the SDK and UI packages. Nothing else depends on React.
- **cli**: project generation (the `filter` and `gain` templates, a Vite/React app, and `init` for existing React projects), code generation from `plugin.json` (C++ header, Rust module, TypeScript declarations), builds, validation, packaging, a test runner that can record expectations, and a dev server with watch mode.

## Threads and messages

The main thread fetches, validates, compiles, handles user events and renders UI. The audio thread does everything the runtime does, including control-plane commands, because `MessagePort` handlers in an `AudioWorkletGlobalScope` run on the rendering thread between render quanta. That is the "block boundary": a command never interleaves with `process()`, so replacing the chain is one array swap and a parameter update is a plain export call. Sequence numbers still reject stale `SET_PARAMETER` and `SET_BYPASS` messages.

Messages are versioned discriminated unions (`protocolVersion: 3`). The version goes up whenever the wire format changes, so a stale worklet fails at `INIT` with a clear error. The worklet validates every field. Lifecycle and chain commands carry a `requestId` and get an answer with the same id: `READY`, `PLUGIN_READY`, `INSTANCE_READY`, `ACK`, `STATE`, `STATE_APPLIED`, `PARAMETER_VALUE` or `ERROR`. `STATE_APPLIED` answers `SET_STATE` with every parameter value the plugin holds afterwards, so the SDK's mirror stays correct even when an opaque blob changed parameters the request did not mention. Parameter and bypass updates are fire-and-forget. Unsolicited `ERROR`, `DIAGNOSTIC` and `LOG` messages are rate limited by separate token buckets on the worklet side. The one-shot `INSTANCE_ERRORED` transition and `LATENCY_CHANGED` skip the limiter. `OUTPUT_VALUES` (meter values) is posted at the configured `outputsPerSecond`.

Module transfer: the SDK inspects the binary and runs the synchronous `WebAssembly.validate` on the main thread, then transfers a copy of the bytes. The worklet compiles once and instantiates asynchronously; `WebAssembly.compile` and `instantiate` do their work off the rendering thread. Posting a precompiled `WebAssembly.Module` is opt-in, because Chromium cannot clone one into an AudioWorklet (decision 0002).

## Memory bridge

`WasmPluginInstance` uses the plugin's own `audiospan_alloc` to allocate the host config, the process descriptor, a scratch slot, channel pointer tables, and `2 × channels` sample buffers of `maxFrames` floats. Pointer tables are written once. For each block it copies the input channels in, sets `frame_count` and the channel counts, and calls `process`. The output stays in module memory (`outputViews`) and the next stage copies straight from it. Views over `memory.buffer` are cached and only refreshed when the buffer identity changes (growth) or the frame count changes. See the [ABI](../abi/).

## Chain execution

```
src = worklet inputs (0..maxChannels channels)
for plugin in chain:
    if bypassed or errored, or process(src) fails:
        dst = scratch[k % 2]; copyChannels(src → dst); src = dst   (record the failure)
    else:
        src = plugin.outputViews   (its output buffers in module memory, no copy)
copyChannels(src → worklet outputs)
```

Channel mapping (`copyChannels`): mono is duplicated to every channel; otherwise channel *n* maps to channel *n*, extra source channels are dropped and missing target channels are zeroed. Each instance processes a fixed channel count agreed at creation, `min(maxChannels, port.max)`, checked against the port minimum.

Error policy: a status other than `AS_OK`, a trap, or memory growth during `process` marks the block as failed (pass-through), increments `consecutiveErrors` and posts an `audio-processing-error` diagnostic. After `processErrorBypassThreshold` failures (3) the instance is marked `errored` and `INSTANCE_ERRORED` is posted. `RESET` or `SET_STATE` clears it.

## Allocation discipline

Allocation happens at init (scratch buffers), at instance creation (module memory), during state calls (staging buffers, freed right away) and when the frame count changes. In steady state, `AudiospanRuntime.process` and `WasmPluginInstance.process` allocate nothing. A test checks this.

## Versioning

These numbers move independently: package versions (semver), the protocol version (3), the manifest schema version (1), the ABI version (1) and each plugin's own version. The runtime checks the protocol and ABI versions before use. The manifest validator checks the schema version.
