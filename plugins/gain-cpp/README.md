# Gain (C++) — reference plugin

The canonical Audiospan ABI effect: one float parameter `gain` (0..2, default 1), linear multiplication, no clipping, no smoothing, zero latency, mono or stereo, 12-byte versioned state blob. It also shows the optional exports: an output `level` (peak absolute sample of the last block, declared under `outputs` and served by `getOutput`), `latencyFrames()` returning 0, and a `logDebug` call in the constructor that only `audiospan build --dev` compiles in.

```sh
pnpm build:wasm                 # or: node packages/cli/dist/index.js build --root plugins/gain-cpp
node packages/cli/dist/index.js test --root plugins/gain-cpp
```

`include/audiospan/` is a copy of `abi/include/audiospan/`; `pnpm sync:abi` refreshes it and `tests/abi/header-sync.test.ts` fails if it drifts.
