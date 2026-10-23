# Manifest schema (version 1)

`plugin.json` describes an artifact. JSON Schema: [`packages/manifest/schema/plugin.schema.json`](../packages/manifest/schema/plugin.schema.json). The reference validator `validateManifest()` in `@audiospan/manifest` enforces the schema plus cross-field rules and host policy; it is what the SDK and CLI use. A manifest is untrusted input: every field is checked before use.

## Example

```json
{
  "schemaVersion": 1,
  "id": "com.example.gain",
  "name": "Gain",
  "version": "0.1.0",
  "vendor": "Example Audio",
  "description": "A simple gain effect.",
  "category": "utility",
  "license": "MIT",
  "entry": { "wasm": "module.wasm", "abi": "audiospan-c" },
  "audio": {
    "inputs":  [{ "id": "in",  "name": "Input",  "channels": { "min": 1, "max": 2 } }],
    "outputs": [{ "id": "out", "name": "Output", "channels": { "min": 1, "max": 2 } }],
    "maxFramesPerProcess": 2048,
    "latencyFrames": 0
  },
  "parameters": [
    { "id": "gain", "name": "Gain", "type": "float", "unit": "linear", "min": 0, "max": 2, "default": 1, "step": 0.01,
      "display": { "style": "knob", "format": "linear", "precision": 2 } },
    { "id": "cutoff", "name": "Cutoff", "type": "float", "min": 20, "max": 20000, "default": 1000, "scale": "logarithmic",
      "display": { "format": "hertz", "precision": 0 } },
    { "id": "mode", "name": "Mode", "type": "enum", "default": 0, "options": [{ "value": 0, "label": "Clean" }, { "value": 1, "label": "Warm" }] }
  ],
  "outputs": [
    { "id": "level", "name": "Output level", "min": 0, "max": 2, "display": { "format": "linear", "precision": 2 } }
  ],
  "capabilities": { "state": true, "presets": true, "customUI": false, "midiInput": false, "sidechain": false, "network": false, "filesystem": false },
  "resources": { "maxMemoryBytes": 16777216, "maxStateBytes": 1048576, "maxAssetBytes": 1048576 },
  "presets": [{ "id": "default", "name": "Default", "path": "presets/default.json" }]
}
```

## Fields

| Field | Rules |
| --- | --- |
| `schemaVersion` | Must be `1`. Anything else → `MANIFEST_SCHEMA_VERSION_UNSUPPORTED`. |
| `id` | Reverse-DNS style: lowercase labels separated by dots, `[a-z0-9]` with single `-`/`_` inside labels, ≥ 2 labels, ≤ 128 chars. |
| `name` | 1–256 chars. `vendor`, `description`, `category`, `license` optional strings. |
| `version` | Semantic version (`1.2.3`, `1.0.0-beta.1+build`). |
| `entry.wasm` | Safe relative path: no leading `/`, no scheme, no `..` or `.` segments, no backslash, `//`, `?`, `#`, `%`, or control chars. `entry.abi` must be `audiospan-c`. |
| `audio.inputs` / `audio.outputs` | Exactly one port each in v1 (inputs may be empty only for the schema; the runtime treats a missing input port as silence). Port `id` matches `[A-Za-z][A-Za-z0-9_-]{0,63}`, unique; `channels.min ≤ channels.max`, 1..32; `min` must not exceed the host's `maxChannels` (policy). |
| `audio.maxFramesPerProcess` | Integer 1..65536, default 4096. Must be ≥ the host's `maxFrames` or the plugin is rejected. |
| `audio.latencyFrames` | Non-negative integer, default 0. Exposed, not compensated (warning). |
| `parameters` | Array (may be empty, ≤ 512). Ids unique and `[A-Za-z][A-Za-z0-9_-]*`. Order defines ABI indices and must stay stable within a compatible plugin version. |
| `outputs` | Optional array (≤ 128) of read-only values the plugin computes (meters, gain reduction, readouts): `{ id, name, unit?, description?, min?, max?, display? }`. Ids unique among outputs; `min < max`, defaults 0..1; `display` takes `format` and `precision`. Order defines the indices passed to the optional `audiospan_get_output` export, which must exist when this array is non-empty. Values are polled by the host while audio runs. |
| `capabilities` | Booleans. Defaults: `state: true`, everything else `false`. `midiInput`, `sidechain`, `network`, `filesystem` must be `false` (unsupported → error). `customUI: true` is an error unless host policy allows it. Unknown keys warn. |
| `resources` | Positive integers with hard caps: `maxMemoryBytes` ≤ 1 GiB (default 16 MiB), `maxStateBytes` ≤ 64 MiB (default 1 MiB), `maxAssetBytes` ≤ 256 MiB (default 1 MiB). Also checked against host policy (`MANIFEST_POLICY_*`). |
| `presets` | ≤ 256 entries of `{ id, name, path, description? }`; safe relative paths; unique ids. Ignored with a warning when `capabilities.presets` is false. |
| `ui.entry` | Safe relative path; ignored with a warning when `customUI` is false. |

Unknown top-level fields produce a warning and are ignored (forward compatibility).

## Parameters

| `type` | Required | Normalized defaults | Control |
| --- | --- | --- | --- |
| `float` | `min`, `max`, `default` (min ≤ default ≤ max), optional positive `step` | `display.style` slider (or knob), format linear, precision 2 | slider / knob |
| `integer` | integer `min`, `max`, `default`, optional integer `step` | step 1, style stepper, format integer | number input |
| `boolean` | `default` 0 or 1 | min 0, max 1, step 1, style toggle | checkbox |
| `enum` | `options` (≥ 1 `{ value, label }`, unique values), `default` ∈ values | min/max = option range, style select | select |

`display.style` ∈ knob, slider, stepper, toggle, select. `display.format` ∈ linear, decibel, percent, hertz, milliseconds, seconds, integer, semitones, cents, beats. `display.precision` 0..10. `display.bipolar` (default false) tells controls to rest at zero, or at the centre when zero is outside the range: pan, a ±dB trim. Values are always set and stored as real values; `@audiospan/manifest` provides `clampParameterValue`, `toNormalized`, `fromNormalized`, `formatParameterValue`.

Float and integer parameters also accept:

| Field | Rules |
| --- | --- |
| `scale` | `linear` (default) or `logarithmic`. Logarithmic maps equal ratios to equal control travel, so a 20 Hz to 20 kHz cutoff sits at mid-travel near 632 Hz; it requires `min > 0`. Applied by `toNormalized`/`fromNormalized`, which the default UI's knobs and sliders use; the real value crossing the ABI is unchanged. |
| `skew` | Power curve on the normalized position (default 1 = none, allowed 0 < skew ≤ 100): `normalized = linear^skew`. Below 1 spreads the low end of the range over more of the control (a 0 to 1000 ms time with `skew: 0.5` puts 250 ms at mid-travel). Not combined with the logarithmic scale. |
| `automatable` | Boolean, default true. Set false for parameters hosts should not automate, such as an oversampling mode that changes latency. Exposed on the descriptor; the runtime does not enforce it. |

## State and presets

```json
{ "schemaVersion": 1, "pluginId": "com.example.gain", "pluginVersion": "0.1.0",
  "parameters": { "gain": 0.5 }, "opaqueState": "base64…" }
```

A preset file is `{ "id", "name", "description"?, "state": <PluginState> }`. Validation (`validatePluginState`, `validatePreset`): matching `pluginId`, schema version 1, semantic `pluginVersion` (mismatch warns, or errors with `requireSameVersion`), finite parameter values clamped to range (warning, or error in strict mode), unknown parameter ids ignored (warning) or rejected (strict), `opaqueState` valid base64 no larger than `resources.maxStateBytes`.

## Validation API

```ts
import { parseManifest, validateManifest, assertManifest } from "@audiospan/manifest";
const result = parseManifest(text, { maxBytes, maxMemoryBytes, maxChannels, maxFramesPerProcess, allowedCapabilities });
if (!result.ok) console.log(result.errors);   // [{ code, path, message }]
else use(result.manifest, result.warnings);
```

Issue codes are stable strings (`MANIFEST_ID_INVALID`, `MANIFEST_PATH_UNSAFE`, `MANIFEST_PARAM_DEFAULT_OUT_OF_RANGE`, …) with JSON-pointer-like paths such as `/parameters/0/min`.
