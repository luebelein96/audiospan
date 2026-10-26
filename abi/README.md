# Audiospan ABI

- `include/audiospan/abi.h`: the normative C ABI (compiles as C and C++).
- `include/audiospan/effect.hpp`: C++ helper that generates all exports from a plain class (`AUDIOSPAN_DEFINE_EFFECT`).
- `examples/passthrough.c`: a complete plugin in plain C without the helper, with its manifest.

The Rust bindings live in `abi/rust/abi.rs`. `pnpm sync:abi` copies the headers to the C++ template and reference plugin; `pnpm sync:abi --check` (run by tests and CI) fails on drift.

Full contract: [the ABI reference](https://luebelein96.github.io/audiospan/abi/).

```sh
cd examples
emcc passthrough.c -I../include -O2 -sSTANDALONE_WASM=1 --no-entry \
  -sINITIAL_MEMORY=1048576 -sMAXIMUM_MEMORY=16777216 -sALLOW_MEMORY_GROWTH=1 -o passthrough.wasm
```
