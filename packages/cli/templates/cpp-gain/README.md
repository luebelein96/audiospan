# __PLUGIN_NAME__

An Audiospan audio effect written in C++: the smallest complete plugin, a gain.

## Layout

```
plugin.json                    manifest: parameters, ports, presets
audiospan.config.json          build settings used by the Audiospan CLI
src/plugin.cpp                 your effect (edit this)
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
audiospan validate dist
audiospan pack           # dist/<id>-<version>.audiospan.tar.gz with checksums
```

## Next steps

1. Add parameters to `plugin.json`; `audiospan build` regenerates `plugin::kName` constants and the ranges.
2. Implement `process()`. It must be allocation-free and must write every output sample. `params_.value(i)` is the smoothed value for this block; `params_.ramp(i, frames)` gives a per-sample ramp.
3. Add cases to `test/vectors.json`, or leave out `expect` and run `audiospan test --update` to record them.
4. Copy `dist/` into your web app; the guide "From your DSP to a web app" in the Audiospan docs covers the rest.
