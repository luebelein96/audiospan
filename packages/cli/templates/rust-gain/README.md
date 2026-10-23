# __PLUGIN_NAME__

An Audiospan audio effect written in Rust: the smallest complete plugin, a gain.

## Layout

```
plugin.json                     manifest: parameters, ports, presets
audiospan.config.json           build configuration used by the Audiospan CLI
Cargo.toml                      cdylib crate, panic = "abort", `audiospan-log` feature for `audiospan build --dev`
.cargo/config.toml              wasm32 target, +simd128, memory limits (keep in sync with plugin.json)
src/lib.rs                      your effect (edit this)
src/abi.rs                      ABI bindings, Parameters, Effect trait, export macro (do not edit)
generated/audiospan_params.rs   indices, ranges and defaults, regenerated from plugin.json on every build
presets/                        preset JSON documents referenced by plugin.json
test/vectors.json               known-input/known-output checks run by `audiospan test`
dist/                           build output (module.wasm, plugin.json, plugin.d.ts, presets/)
```

## Toolchain

- Rust stable 1.80+ with the `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`
- Node.js 20+ for the Audiospan CLI.

## Commands

```sh
audiospan build          # cargo build --release --target wasm32-unknown-unknown, regenerate generated/, validate
audiospan test           # generic ABI checks + test/vectors.json in Node
audiospan test --update  # record the current output for cases without "expect"
audiospan dev --watch    # local sandbox that rebuilds and reloads on every save
audiospan validate dist
audiospan pack
```

## Notes

- Add parameters to `plugin.json`; `audiospan build` regenerates the `params::NAME` constants and ranges.
- `self.params.value(i)` is the smoothed value for this block; `self.params.ramp(i, frames)` gives a per-sample ramp.
- `panic = "abort"` keeps the module small. A panic traps; the host bypasses the plugin and reports an error.
- Never allocate in `process`. `Vec`/`Box` belong in `create`.
