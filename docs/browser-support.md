# Browser support

## Requirements

- `AudioWorklet` (Chrome 66+, Firefox 76+, Safari 14.1+), which needs a secure context (HTTPS or localhost).
- WebAssembly with `WebAssembly.compile`/`instantiate` in the worklet global scope.
- `AudioContext` created or resumed from a user gesture (autoplay policy).

Not required: cross-origin isolation, `SharedArrayBuffer`, WASM threads, SIMD, or any flag. The browser test asserts `crossOriginIsolated === false` and `SharedArrayBuffer` undefined while the plugin processes audio.

## Tested

| Browser | How | Status |
| --- | --- | --- |
| Chromium 153 (Playwright 1.63) | `pnpm test:browser`: OfflineAudioContext rendering through the worklet, plus the vanilla example with a real-time context | Passing |
| Firefox | Not in the matrix yet | Expected to work; untested |
| Safari / WebKit | Not in the matrix yet | Expected to work; untested. Safari historically delivers `messageerror` for some cloned types; the default byte transfer avoids that path |

## Known behaviours

- Render quantum is 128 frames in all current browsers. The host's `maxFrames` defaults to 128; raise it if you use Chrome's `renderSizeHint`. Larger quanta than configured are passed through with a `frames-unsupported` diagnostic rather than processed.
- `performance.now()` is not available in every AudioWorkletGlobalScope; `processing-stats` and `processing-over-budget` diagnostics are emitted only where it is.
- Posting a `WebAssembly.Module` into the worklet fails in Chromium (`messageerror`); the SDK's default is to transfer bytes.
- The worklet script is loaded from a blob URL by default (the SDK embeds it). Chromium is covered by the browser suite; if a browser or a Content Security Policy refuses `blob:` scripts for `addModule`, pass `workletUrl` pointing at the served `audiospan-worklet.js`.
- `AudioWorkletGlobalScope` lacks `TextDecoder`, `fetch`, timers and `performance` in Chromium; the runtime bundle avoids them and `packages/runtime/test/worklet-scope.test.ts` enforces that.
- A plugin trap inside the worklet is caught by the runtime; a trap in the processor itself would fire `onprocessorerror`, which the SDK surfaces as `WORKLET_PROCESSOR_ERROR`.
