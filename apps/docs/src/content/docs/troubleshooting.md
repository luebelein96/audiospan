---
title: "Troubleshooting"
description: "Error codes and symptoms, what usually causes them, and what to do."
tableOfContents: false
---

Every SDK failure is an `AudiospanError` with a `code`. CLI failures print an `error:` line and a `hint:` line, and exit with 2 (usage), 3 (validation) or 4 (toolchain). Find your symptom in the first column.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `WORKLET_INIT_FAILED: failed to load the embedded Audiospan worklet (blob URL)` | The page's Content Security Policy forbids `blob:` in `script-src`, or the browser refuses blob URLs for `addModule` | Add `blob:` to `script-src`, or serve `@audiospan/runtime/dist/audiospan-worklet.js` and pass its URL as `workletUrl`. |
| `WORKLET_INIT_FAILED: failed to load the Audiospan worklet from …` | Wrong `workletUrl`, served as HTML (404 page), wrong MIME type, cross-origin without CORS, or not a secure context | Open the URL in a tab: it must return the JS file. Serve it same-origin, as `text/javascript`, over HTTPS or localhost. |
| `WORKLET_INIT_FAILED: … 'audiospan-processor' is not defined in AudioWorkletGlobalScope` | The worklet file loaded but threw while evaluating, so it never registered its processor: a modified or re-bundled worklet that uses an API the worklet scope lacks (`TextDecoder`, `fetch`, timers), or a corrupted copy | Serve the unmodified `audiospan-worklet.js` from `@audiospan/runtime`; check the browser console for the thrown error. |
| `MODULE_INVALID: … this browser does not support WebAssembly SIMD` | The module was built with SIMD (the default) and the browser predates it | Update the browser, or build without SIMD: `cpp.simd: false` in `audiospan.config.json`, or remove `target-feature=+simd128` for Rust. `wasmSimdSupported()` from the SDK checks up front. |
| `MODULE_INVALID: … imports the development-only "env.audiospan_log"` | A plugin built with `audiospan build --dev` loaded by a host without `pluginLogging: true` | Rebuild without `--dev` for distribution, or enable `pluginLogging` on the host while developing. |
| `MODULE_INVALID: … manifest declares outputs but the module does not export "audiospan_get_output"` | `plugin.json` has an `outputs` array but the effect class has no `getOutput` / `get_output` | Implement the method (the helper exports it) or remove the array. |
| `WORKLET_INIT_FAILED: the Audiospan runtime did not become ready` | The worklet file is from a different version than the SDK, or the processor threw at construction | Copy `audiospan-worklet.js` from the same `@audiospan/runtime` version as the SDK; check the console for worklet errors. |
| `NOT_SUPPORTED: AudioWorklet is not available` | Insecure context or an unsupported browser | Use HTTPS or localhost and a browser listed under [Browser support](../browser-support/). |
| `MANIFEST_FETCH_FAILED` | 404, CORS, redirect (`redirect: "error"`), or a relative URL in a non-browser host | Check the network tab. Serve from the same origin, or allow the origin in the policy. Avoid redirects. |
| `MANIFEST_INVALID` | `plugin.json` fails validation; `error.issues` lists `{ code, path, message }` | Run `audiospan validate dist` to see the same issues with paths. |
| `MODULE_INVALID: … not a valid WebAssembly binary` | The `.wasm` URL returned HTML or was served with the wrong bytes | Confirm `Content-Type: application/wasm` and that the file is the built module. |
| `MODULE_INVALID: … does not export required function` | Built without the ABI exports (missing `AUDIOSPAN_DEFINE_EFFECT` / macro, symbols stripped) | Use the helper or mark exports with `AUDIOSPAN_EXPORT`; `audiospan validate` lists missing names. |
| `MODULE_INVALID: … must declare a maximum memory size` | Linked without a memory maximum | emcc: `-sMAXIMUM_MEMORY=<bytes>` with `-sALLOW_MEMORY_GROWTH=1`; Rust: `-C link-arg=--max-memory=<bytes>`. |
| `MODULE_INVALID: … imports "env.foo"` | The module needs host functions (printf to a custom env, JS glue) | Build standalone (`-sSTANDALONE_WASM`), remove the dependency; only WASI stubs and `env.memory` are provided. |
| `POLICY_VIOLATION` | Remote origin, oversize manifest/module, memory beyond policy, or `allowPlugin` rejected it | Change `pluginPolicy` on purpose (`allowedPluginOrigins`, `maxModuleBytes`, …). |
| `ABI_VERSION_MISMATCH` (as `MODULE_INVALID`) | `audiospan_get_abi_version` returns something other than 1 | Rebuild against the current header. |
| `INSTANCE_LIMIT` | More instances than `maxPlugins` | Dispose unused instances or raise `maxPlugins`. |
| `INSTANCE_CREATE_FAILED: plugin supports N frames per process but the host delivers up to M` | `audio.maxFramesPerProcess` below the host's `maxFrames` | Raise the manifest value (plugins should support at least 128; the template uses 4096). |
| `INSTANCE_CREATE_FAILED: plugin requires more channels` | Port `channels.min` above the host's `maxChannels` | Lower the port minimum or raise `maxChannels`. |
| Silent audio | Chain not connected, source not started, context suspended, gain 0, or instance bypassed/errored | Check `host.getActiveChain()`, `audioContext.state`, `plugin.status` and `plugin.isBypassed()`. Turn on `diagnostics` and watch for `audio-processing-error`. |
| `INSTANCE_ERRORED` host error, `plugin.status === "error"` | `process` returned an error or trapped three times in a row | Read the `audio-processing-error` diagnostics (status name or trap message) and fix the plugin. `plugin.reset()` re-enables it. |
| Clicks when calling `getState()`/`setState()` | Control-plane work on the audio thread for large states | Keep state small and do not call these in tight loops. |
| `INVALID_STATE` | Wrong `pluginId`, bad base64, over `maxStateBytes`, NaN values, or unknown parameter in strict mode | Validate with `validatePluginState` from `@audiospan/manifest` to see the issues. |
| `REQUEST_TIMEOUT` | The worklet is not processing messages (context closed, processor crashed) | Check `audioContext.state`, listen for `WORKLET_PROCESSOR_ERROR`, and recreate the host. |
| CLI `emcc (Emscripten) was not found on PATH` | Toolchain not installed or not activated | Install the emsdk and run `source emsdk_env.sh`. `audiospan doctor` shows what the CLI can see. |
| CLI `expected cargo output … was not produced` | Crate is not a `cdylib` or the name differs | Keep `crate-type = ["cdylib"]`; set `rust.crateName` if the package name is not the file name. |
| `audiospan dev` page loads but nothing plays | Plugin path wrong (`?plugin=`), or audio blocked until a click | The sandbox logs the exact load error. Always click **Start audio** first. |
| Clicks or zipper noise when turning a knob | Parameter applied instantly to a coefficient or gain | Smooth towards the target in the plugin. See [Parameters](../porting-dsp/#parameters) under porting. |
| `audiospan test` vector fails only on the first few samples | Parameter smoothing ramps from the default before the first block | Apply parameter values instantly until the first `process()` call, as the tutorial adapter does, or test at the defaults. |
| C++ build: `M_PI` undeclared, or `<iostream>` pulls in tens of kilobytes | `-std=c++17` is strict about POSIX macros; stdio has no implementation in the module | Define your own constant; log with `audiospan::logInfo` in `--dev` builds instead of streams. |
| Plugin gets slow after a few seconds of silence | Denormals in recursive filters: WebAssembly has no flush-to-zero | Add a tiny offset to feedback paths, or clamp small state values to zero. See [Real-time rules in WebAssembly](../porting-dsp/#real-time-rules-in-webassembly). |
| C++ build: `audiospan_params.h` not found, or `plugin::kFoo` undeclared | The generated header is missing or stale; a custom build system did not add `-Igenerated` | Run `audiospan build` or `audiospan generate`, and add `-Igenerated` to your own compiler command. Rust: keep `#[path = "../generated/audiospan_params.rs"] mod params;` in `lib.rs`. |
| Build error: two ids `generate the identifier …` | Two manifest ids differ only in separators or case (`dry-wet`, `dry_wet`) | Rename one of them in `plugin.json`. |
| `audiospan test`: `no expectation; run audiospan test --update` | A vector case has no `expect` | Run `audiospan test --update` to record the current output, then review the numbers it wrote. |
| `useAudioSource`: `the microphone is unavailable` | Insecure context (no HTTPS/localhost), no gesture yet, or `getUserMedia` denied | Serve over HTTPS, call `audio.start()` from a click (the hook connects once the host runs), and check the browser's permission prompt. `source.error` carries the reason. |
| `audiospan init`: `has no react dependency` | Run outside a React project, or React is installed elsewhere in a monorepo | Run it in the app package that depends on `react`, or pass `--force`. |
| Hot reload creates duplicate plugin instances | A hand-written effect that does not dispose on cleanup | Use `usePlugin` (one instance per mount, StrictMode-safe) or dispose the instance in your effect's cleanup. |
