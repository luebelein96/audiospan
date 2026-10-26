---
title: "Browser support"
description: "What a browser needs, what has been tested, and a few things to know."
---

## Requirements

- `AudioWorklet` (Chrome 66+, Firefox 76+, Safari 14.1+). It needs a secure context: HTTPS or localhost.
- WebAssembly, with `WebAssembly.compile` and `WebAssembly.instantiate` available inside the worklet.
- An `AudioContext` created or resumed from a user gesture, because of autoplay rules.

The runtime itself needs no cross-origin isolation, `SharedArrayBuffer`, WASM threads or browser flags. The browser test checks that `crossOriginIsolated` is false and `SharedArrayBuffer` is undefined while a plugin is processing audio. Plugins built by the CLI use WebAssembly SIMD by default, which every current browser supports; set `cpp.simd: false` in `audiospan.config.json` (or drop `+simd128` for Rust) if you need to reach older browsers.

## Tested

| Browser | How | Status |
| --- | --- | --- |
| Chromium 153 (Playwright 1.63) | `pnpm test:browser` renders through the worklet with an `OfflineAudioContext`, then runs the examples and the docs demo with a real-time context | Passing |
| Firefox | Not in the test matrix yet | Expected to work, untested |
| Safari / WebKit | Not in the test matrix yet | Expected to work, untested. Older Safari versions fire `messageerror` for some cloned types; the default byte transfer avoids that path |

## Known behaviours

- The render quantum is 128 frames in every current browser. The host's `maxFrames` defaults to 128. Raise it if you use Chrome's `renderSizeHint`. A larger quantum than configured is passed through untouched, with a `frames-unsupported` diagnostic.
- Not every `AudioWorkletGlobalScope` has `performance.now()`. The `processing-stats` and `processing-over-budget` diagnostics are only sent where it exists.
- Chromium cannot receive a `WebAssembly.Module` posted into a worklet (it fires `messageerror`). The SDK transfers the bytes instead by default.
- The worklet script is loaded from a blob URL by default, since the SDK embeds it. Chromium is covered by the browser suite. If a browser or your Content Security Policy refuses `blob:` scripts for `addModule`, serve `audiospan-worklet.js` and pass its URL as `workletUrl`.
- Chromium's `AudioWorkletGlobalScope` has no `TextDecoder`, `fetch`, timers or `performance`. The runtime bundle avoids them, and `packages/runtime/test/worklet-scope.test.ts` fails if that changes.
- A trap inside a plugin is caught by the runtime. A trap in the processor itself fires `onprocessorerror`, which the SDK reports as `WORKLET_PROCESSOR_ERROR`.
