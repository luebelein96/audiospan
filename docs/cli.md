# CLI reference

`audiospan --help`, `audiospan <command> --help`. Exit codes: 0 ok, 1 failure, 2 usage error, 3 validation failed, 4 toolchain missing or failed.

| Command | Purpose |
| --- | --- |
| `create <name> --language cpp\|rust [--template filter\|gain] [--app react] [--app-dir <path>] [--directory <path>] [--vendor <name>] [--id <plugin.id>] [--force]` | Generate a project from a template and its `generated/` bindings. `filter` (default): a resonant low-pass with a level meter and presets around a stand-in DSP class; `gain`: the smallest complete plugin. `--app react` also generates a Vite + React + TypeScript app (default `<directory>-app`) wired to the plugin: `outDir` and `typesOut` point into it, `src/audiospan/<Name>.tsx` is the integration, and `npm run plugin` / `npm run plugin:watch` build the plugin. Names: lowercase, digits, hyphens. Refuses to overwrite existing files without `--force`. |
| `init [--root <react-project>] [--name <plugin-name>] [--language cpp\|rust] [--template filter\|gain] [--vendor <name>] [--id <plugin.id>] [--install] [--force]` | Add Audiospan to an existing React project: a plugin project under `audiospan/<name>/` building into `public/plugins/<name>/`, typed declarations in `src/plugins/` (or `app/plugins/` for a Next.js app router), a ready `"use client"` component in `src/audiospan/<Name>.tsx`, the `@audiospan/react` dependency and the `plugin` / `plugin:watch` scripts in `package.json`. Detects npm, pnpm, yarn or bun from the lockfile; `--install` runs it. Refuses projects without a `react` dependency unless `--force`. Never edits your source files. |
| `build [--root <dir>] [--dev] [--verbose] [--no-validate]` | Regenerate `generated/audiospan_params.h` or `.rs` from `plugin.json`, compile with emcc/cargo, assemble `dist/` (module, manifest, `plugin.d.ts`, presets/, assets/, ui/), write the `typesOut` declarations, validate. Prints the exact toolchain command. `--dev` compiles plugin logging in (`-DAUDIOSPAN_ENABLE_LOG=1` for C++, `--features audiospan-log` for Rust); the module then imports `env.audiospan_log`, which hosts accept only with `pluginLogging` on, and `validate` warns about it. |
| `generate [--root <dir>]` | Only the code generation step of `build`: the language bindings in `generated/` and the `typesOut` declarations. |
| `test [--root <dir>] [--vectors <file>] [--update]` | Instantiate `dist/module.wasm` in Node and run generic ABI checks (defaults round-trip, bad index rejected, finite output, varying frame counts, state round-trip + garbage rejection, reset, the optional latency and output exports, repeated create/destroy) plus `test/vectors.json`. `--update` records the current output (channel 0, nine significant digits) as `expect` for every case that has none and saves the file. Development builds are accepted; their log lines are discarded. |
| `validate <artifact-dir> [--json]` | Manifest schema + policy, module exports/imports/memory/`WebAssembly.validate` (including `audiospan_get_output` when the manifest declares outputs), preset files, UI entry, size limits. Warnings and errors are printed separately; a module that imports `env.audiospan_log` gets a `MODULE_DEV_LOGGING` warning. |
| `pack [<artifact-dir>] [--root <dir>] [--out <dir>] [--include-source]` | Deterministic `<id>-<version>.audiospan.tar.gz` (ustar, sorted, epoch mtimes, root ownership, zeroed gzip header) containing the artifact files plus `audiospan-package.json` (format version 1, file list with SHA-256) and `checksums.sha256`; a sidecar `.sha256` of the archive. Sources are excluded unless `--include-source`. |
| `dev [--root <dir>] [--watch] [--dev] [--port 8787] [--host 127.0.0.1] [--plugin dist/plugin.json] [--open <page>]` | Static server with `application/wasm`, `Cache-Control: no-cache`, CORS `*`, path containment, and virtual routes `/__audiospan/{sdk.js,ui.js,worklet.js,demo/}`. The sandbox polls `/__audiospan/mtime` and reloads the plugin when `module.wasm` changes, preserving state when the plugin id is unchanged. `--watch` rebuilds the project whenever a file outside `dist/`, `generated/`, `target/` and `node_modules/` changes (debounced, never overlapping, failures logged); `--dev` makes those rebuilds development builds so plugin log lines appear in the sandbox. |
| `doctor` | Report Node, emcc, cargo and the wasm32 target. |

## `audiospan.config.json`

```json
{
  "language": "cpp",
  "manifest": "plugin.json",
  "outDir": "dist",
  "sources": ["src/plugin.cpp"],
  "includeDirs": ["include"],
  "presetsDir": "presets",
  "assetsDir": "assets",
  "uiDir": "ui",
  "typesOut": "../my-app/src/plugins/my-plugin.d.ts",
  "cpp": { "standard": "c++17", "optimization": "-O2", "initialMemoryBytes": 1048576, "stackBytes": 65536, "simd": true, "lto": true, "extraFlags": [] },
  "rust": { "crateDir": ".", "profile": "release", "crateName": "optional" }
}
```

`cpp.simd` adds `-msimd128` and `cpp.lto` adds `-flto`; both default to true. For Rust, SIMD comes from `target-feature=+simd128` in the template's `.cargo/config.toml` and LTO from `Cargo.toml`. `typesOut` is optional: an extra copy of the generated TypeScript declarations, relative to the project, so an application's source tree gets typed plugin ids on every build.

## Generated files

| File | Written by | Contents |
| --- | --- | --- |
| `generated/audiospan_params.h` (C++) | `create`, `build`, `generate` | `namespace plugin`: `kId`, `kVersion`, an index enum (`kCutoff`, …, `kParamCount`), `kParameters` (an `audiospan::ParameterSpec` table), `Parameters` alias, output indices (`kOutLevel`, …, `kOutputCount`). Included as `"audiospan_params.h"`; `-Igenerated` is added to the emcc command. |
| `generated/audiospan_params.rs` (Rust) | `create`, `build`, `generate` | `ID`, `VERSION`, index constants (`CUTOFF`, …, `PARAMETER_COUNT`), `PARAMETERS: [ParameterSpec; N]`, output constants (`OUT_LEVEL`, …). Declared from `lib.rs` as `#[path = "../generated/audiospan_params.rs"] mod params;`. |
| `dist/plugin.d.ts`, `typesOut` | `build`, `generate` (`typesOut` only) | `<Name>PluginId`, `<Name>ParameterId`, `<Name>OutputId`, `<Name>PresetId` literal unions and `<Name>Plugin = TypedPluginInstance<…>` for `host.addPlugin<…>()`. `<Name>` is the last label of the plugin id in PascalCase. |

Identifiers come from ids: `dry-wet`, `dry_wet` and `dryWet` all become `kDryWet` / `DRY_WET`; two ids that collide after conversion fail the build with both names. The generated files are plain text you may commit; they are rewritten on every build so they never drift from `plugin.json`.

## Templates

| Template | Contents |
| --- | --- |
| `cpp-filter`, `rust-filter` (default) | Resonant low-pass around a stand-in `biquad` DSP file, two parameters with logarithmic knobs, a level meter, two presets, impulse-response vectors |
| `cpp-gain`, `rust-gain` | The smallest complete plugin: constructor, `process()`, `parameters()` |
| `react-app` | Vite + React + TypeScript app used by `create --app react`: `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, scripts `plugin` and `plugin:watch` |
| `react-component.tsx` | The generated `"use client"` component used by both `create --app react` and `init`: host, plugin and microphone hooks, controls, meters, presets, bypass, status and error lines |

## Programmatic use

`@audiospan/cli` also exports its building blocks: `createProject`, `buildPlugin`, `validateArtifact`, `packArtifact`, `testArtifact`, `startDevServer`, `startDev`, `createTarGz`, `inspect` helpers. The repository scripts (`scripts/build-wasm.mjs`, `scripts/validate-artifact.mjs`) and the ABI conformance suite use them.
