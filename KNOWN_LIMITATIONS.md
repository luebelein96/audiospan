# Known limitations (0.1.0)

Kept current during implementation. Each entry says what is missing or constrained and where the behaviour is defined.

## Verification gaps

- **Rust code not compiled in the authoring environment.** `plugins/gain-rust`, the `rust-filter` and `rust-gain` templates and the canonical bindings in `abi/rust/abi.rs` were written against the C header and checked for export names/constants (`tests/abi/header-sync.test.ts`), but no `cargo` toolchain was available when this repository was produced, so none of it has been compiled or run through the conformance suite yet. CI builds the reference plugin with `dtolnay/rust-toolchain`, runs the same vectors, and creates, builds and tests both Rust templates; until that run is green, treat the Rust path as unverified. Local repro: `rustup target add wasm32-unknown-unknown && pnpm build:wasm && pnpm test`.
- **Browser tests run on Chromium only.** Firefox and WebKit are not in the Playwright matrix yet (`tests/browser/playwright.config.ts`).
- **Performance numbers are reported, not enforced.** The Node harness (`tests/performance`) has no baseline thresholds; browser timing uses `performance.now()` only where the AudioWorkletGlobalScope exposes it.

## Runtime and audio

- **Serial chain only.** One input, one output, plugins in sequence. No parallel routing, buses, sidechains, feedback, or latency compensation. `latencyFrames` is validated and exposed on the descriptor but not compensated.
- **Fixed channel count per instance.** Each instance processes `min(host maxChannels, port max)` channels for both input and output. Mono sources are duplicated to every channel; extra channels are dropped; missing channels are silence (`copyChannels` in `packages/runtime/src/runtime.ts`).
- **Parameter changes apply at block boundaries, not sample-accurately.** Updates are coalesced by message order; there is no automation timeline.
- **Control-plane calls run on the worklet thread between render quanta.** State get/set and plugin instantiation can take longer than one quantum and may cause a glitch during that call; they never run inside `process()`.
- **No per-plugin CPU quota.** A plugin that overruns the callback budget causes glitches for the whole chain; repeated *errors* lead to bypass, slowness does not.
- **No SIMD/threads/SharedArrayBuffer requirement, and no support for modules that need them.** Shared memory modules are rejected.
- **`WebAssembly.Module` transfer is opt-in.** Chromium cannot structured-clone a module into an AudioWorklet; the default transfers bytes and compiles in the worklet (see `docs/decisions/0002-module-transfer.md`).

## Manifest and packaging

- Exactly one input port and one output port per plugin.
- Parameter types: float, integer, boolean, enum. No string, colour, file, or ranged-list parameters.
- Custom plugin UI is declared in the manifest (`capabilities.customUI`, `ui.entry`) but **not executed** by this runtime; the default host-generated panel is the only UI path. Hosts deny `customUI` by default.
- Presets must be JSON files inside the artifact. Remote preset stores and signatures are not implemented; archives carry SHA-256 checksums only.
- Packaging produces `.tar.gz` (ustar). No ZIP output.

## SDK

- Fetch-based loading refuses redirects (`redirect: "error"`) and non-`http(s)`/`blob:`/`file:` URLs.
- `loadPlugin`'s `AbortSignal` is honoured while fetching, validating and compiling; once the module has been posted to the runtime the load completes and the plugin stays registered.
- The React example is a hook plus a page; there is no published React component package.

## CLI

- `audiospan build` shells out to `emcc` or `cargo`; it does not install toolchains. Minimum versions are advisory (`doctor` reports them).
- `audiospan dev` prints the sandbox URL rather than launching a browser.
- Templates ship two effects ("filter" and "gain") and a React app. No instrument/MIDI template, no Vue/Svelte/Solid adapters yet (the SDK's `createPluginStore` is the intended base for them).
- **The generated React app was not installed and built in the authoring environment** (no registry access): its component and `App.tsx` were type-checked against the real packages, and the same hooks and components run in the browser suite through `examples/react`, but `npm install && npm run build` of a scaffolded `--app react` project has not been executed here. The dependency ranges (Vite 7, `@vitejs/plugin-react` 5, React 19) are current majors; adjust if your environment pins others.
