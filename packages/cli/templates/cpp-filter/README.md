# __PLUGIN_NAME__

An Audiospan audio effect written in C++: a resonant low-pass filter with a level meter and two presets.

## Layout

```
plugin.json                    manifest: parameters, outputs (meters), ports, presets
audiospan.config.json          build settings used by the Audiospan CLI
src/biquad.h                   the DSP; replace with your own code
src/plugin.cpp                 the adapter between your DSP and the ABI (edit this)
generated/audiospan_params.h   indices, ranges and defaults, regenerated from plugin.json on every build
include/audiospan/             ABI header + C++ helper (do not edit; copied from the SDK)
presets/                       preset JSON documents referenced by plugin.json
test/vectors.json              known-input/known-output checks run by `audiospan test`
dist/                          build output (module.wasm, plugin.json, plugin.d.ts, presets/)
```

## Toolchain

- Emscripten (`emcc`) 3.1.50 or newer on your PATH. Install from https://emscripten.org/docs/getting_started/downloads.html and run `source ./emsdk_env.sh`.
- Node.js 20+ for the Audiospan CLI.

## Commands

```sh
audiospan build          # compile src/ -> dist/module.wasm, regenerate generated/, write dist/plugin.d.ts, validate
audiospan test           # generic ABI checks + test/vectors.json in Node
audiospan test --update  # record the current output for cases without "expect"
audiospan dev --watch    # local sandbox that rebuilds and reloads on every save
audiospan build --dev    # logging compiled in (audiospan::logInfo reaches the sandbox log)
audiospan validate dist
audiospan pack           # dist/<id>-<version>.audiospan.tar.gz with checksums
```

## Next steps

1. Replace `src/biquad.h` with your DSP and adapt `src/plugin.cpp`: construct per-channel state from `HostConfig`, read parameters with `params_.value(plugin::kName)`, write every output sample.
2. Edit the parameters in `plugin.json`; `audiospan build` regenerates `plugin::kName` constants and the ranges. Nothing is declared twice.
3. Add cases to `test/vectors.json` (leave out `expect` and run `audiospan test --update` to record them).
4. Copy `dist/` into your web app; the guide "From your DSP to a web app" in the Audiospan docs covers the rest.
