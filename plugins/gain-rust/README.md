# Gain (Rust)

An Audiospan audio effect written in Rust against the Audiospan C ABI.

## Layout

```
plugin.json            Manifest: metadata, ports, parameters, limits, presets
audiospan.config.json  Build configuration used by the Audiospan CLI
Cargo.toml             cdylib crate, panic = "abort", `audiospan-log` feature for `audiospan build --dev`
.cargo/config.toml     wasm32 target, +simd128, memory limits (keep in sync with plugin.json)
src/lib.rs             Your DSP (edit this)
src/abi.rs             ABI bindings + export macro (mirrors abi.h; do not edit)
presets/               Preset JSON documents referenced by plugin.json
test/vectors.json      Known-input/known-output checks run by `audiospan test`
dist/                  Build output (module.wasm, plugin.json, presets/)
```

## Toolchain

- Rust stable 1.80+ with the `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`
- Node.js 20+ for the Audiospan CLI.

## Commands

```sh
audiospan build        # cargo build --release --target wasm32-unknown-unknown, then validate
audiospan test         # run test/vectors.json against dist/module.wasm in Node
audiospan validate dist
audiospan pack
audiospan dev
```

## Notes

- `panic = "abort"` keeps the module small. A panic traps; the host bypasses the plugin and reports an error.
- Never allocate in `process`. `Vec`/`Box` belong in `create`.
- Keep `write_state`/`read_state` versioned.
- `latency_frames` and `get_output` are optional trait methods; this plugin reports latency 0 and a `level` output (peak of the last block) declared in `plugin.json`.
- `abi::log(level, text)` is a no-op unless built with `--features audiospan-log` (`audiospan build --dev`).
