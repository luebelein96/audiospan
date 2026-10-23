# Contributing

## Setup

```sh
pnpm install
pnpm build
pnpm build:wasm        # needs emcc and/or cargo; missing toolchains are skipped
pnpm test
```

`pnpm test` runs vitest across every package plus `tests/abi` (conformance against each built plugin under `plugins/*/dist`). Tests that need a compiled plugin skip with a warning if `plugins/gain-cpp/dist/module.wasm` is absent, so build the WASM first for full coverage.

Browser tests:

```sh
pnpm build:examples
npx playwright install chromium     # once
pnpm test:browser
```

## Layout

- `abi/` is the source of truth for the C ABI (`abi/include/audiospan/`) and the Rust bindings (`abi/rust/abi.rs`). `pnpm sync:abi` copies both into the CLI templates and the reference plugins; `tests/abi/header-sync.test.ts` fails on drift and checks export names and constants across the header, the Rust file and the TypeScript constants.
- `packages/runtime/src/runtime.ts` is the audio hot path. Keep it small, allocation-free in steady state (there is a test for that), and free of logging.
- `packages/sdk` must never expose WASM pointers or memory; everything crosses the worklet boundary as validated messages (`packages/runtime/src/protocol.ts`).
- Every public API needs a test and a doc entry. Docs describe shipped behaviour only.

## Coding standards

TypeScript strict with `exactOptionalPropertyTypes`; no `any` in public APIs; exhaustive `switch` over discriminated unions; typed errors (`AudiospanError`, `RuntimeError`, `CliError`); no hidden network access in runtime code; no unbounded logging from processing.

`pnpm build` (and `pnpm test`) first bundle the worklet and embed it into `packages/sdk/src/generated/worklet-source.ts`; that file is generated and ignored by git. `abi/include/audiospan/*` and `abi/rust/abi.rs` are canonical; `pnpm sync:abi` copies them into both templates of each language and the reference plugins, and CI fails on drift. Templates live under `packages/cli/templates/<language>-<template>`.

`@audiospan/runtime` is bundled into an AudioWorkletGlobalScope, which has only the JavaScript builtins (including `WebAssembly`) plus `console`, `registerProcessor`, `sampleRate` and friends: no `TextDecoder`/`TextEncoder`, `fetch`, timers, `performance` or DOM. Nothing the runtime evaluates at module load or in the hot path may use them; decode and format on the main thread instead (log lines cross as raw bytes for that reason). `packages/runtime/test/worklet-scope.test.ts` bundles the worklet and runs it in a sandbox with exactly that surface, so a violation fails `pnpm test` and not just the browser suite; `addModule` would otherwise resolve while the processor silently fails to register.

## Changing the ABI

The ABI is frozen at version 1: `AUDIOSPAN_ABI_VERSION` in the header, reported by `audiospan_get_abi_version`. Additive changes extend the descriptor structs through `struct_size` or add optional exports that the host detects at load (`audiospan_get_latency` and `audiospan_get_output` are the pattern: absent or `AS_ERROR_UNSUPPORTED` means "not provided"); breaking changes bump the version constant, and the host rejects modules that report a different one. Update the header, the C++ helper, the Rust bindings, `packages/runtime/src/abi.ts`, `docs/abi.md`, and the conformance suite together.

## Pull requests

Keep changes small and vertical. Include the test that demonstrates the behaviour, update `KNOWN_LIMITATIONS.md` if you add or remove a limitation, and note user-facing changes in the PR description.
