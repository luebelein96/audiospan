# Security model

Plugins, manifests, presets, and anything inside an artifact are **untrusted**. WebAssembly gives memory isolation; everything else is the host's job.

## Trust boundaries

```
Application (trusted)
  └─ @audiospan/sdk (main thread): validation, policy, control plane
       └─ MessagePort (validated discriminated messages, both directions)
            └─ @audiospan/runtime in the AudioWorklet: command handling, chain, memory bridge
                 └─ WebAssembly instance per plugin: linear memory only, no imports beyond stubs (plus a log sink in development)
```

The plugin's only inputs are its own exports being called with host-allocated buffers inside its memory. It has no reference to any JavaScript object.

## Protections (implemented)

| Area | Mechanism |
| --- | --- |
| Manifest | Size limit (256 KiB default) before parsing; schema and cross-field validation; reverse-DNS ids; semantic versions; safe relative paths only (no traversal, schemes, encoded dots); capability allowlist (network/filesystem/midi/sidechain always denied, `customUI` denied unless policy grants); resource caps against hard limits and host policy. |
| Module | Size limit (8 MiB default), enforced while the body streams so a server that under-reports `Content-Length` cannot push more than the limit; binary inspection before compilation: required exports present (and `audiospan_get_output` when the manifest declares outputs), every import in the allowlist, memory declared with a maximum ≤ `min(manifest, policy)` or imported so the host creates it with that cap, no shared memory; `WebAssembly.validate` on the main thread; the worklet compiles, re-validates exports/imports with the JS API and probe-instantiates before advertising the plugin. The development-only `env.audiospan_log` import is refused unless the host sets `pluginLogging`. |
| Worklet | Loaded from the SDK's embedded copy through a short-lived blob URL (revoked after `addModule`), or from `workletUrl` when given. A CSP without `blob:` in `script-src` must use `workletUrl`. The processor never registers if the script throws while evaluating; the SDK names that case in `WORKLET_INIT_FAILED`. |
| Origins | Plugin URLs must be same-origin, in `allowedPluginOrigins`, or `allowRemotePlugins` must be set; `http(s)`/`blob:`/`file:` only; redirects refused; `credentials: same-origin`. A page with an opaque origin (`file://`, sandboxed) is treated as origin `"null"`, so it can load `file:` plugins but not arbitrary remote ones. |
| Application hook | `pluginPolicy.allowPlugin(manifest, sourceUrl)` for allow/block lists. |
| Instances | `maxPlugins` (8 default) enforced on both sides, including against creations still in flight; duplicate ids rejected; memory limit re-checked after allocation, state calls, and growth. |
| State | Base64 validated, decoded size ≤ `maxStateBytes` (1 MiB default) before transfer; plugin-side `set_state` must validate; the runtime rejects oversized `get_state` results; validation precedes application, and the runtime snapshots the instance before applying so a refused blob or parameter restores the previous state. |
| Messages | Every main→worklet message is parsed field by field (`parseMainMessage`); unknown types, wrong protocol versions, non-finite numbers, bad ids/indices are rejected with `PROTOCOL_MESSAGE_INVALID`; stale sequence numbers ignored; request ids unique per session. Worklet→main messages are correlated by request id; unexpected responses are dropped. |
| Failure containment | Traps and error statuses from `process` fall back to pass-through for the block; three consecutive failures (`processErrorBypassThreshold`) bypass the instance until reset; unsolicited errors, diagnostics and plugin log lines are rate limited by separate token buckets (20/s each, `diagnosticsPerSecond`), and the one-shot `INSTANCE_ERRORED` and `LATENCY_CHANGED` messages are never dropped. A failing `audiospan_get_output` is reported once and no longer polled; output values are delivered at a bounded `outputsPerSecond`. |
| Logging | No console output from the audio thread; error messages contain plugin ids and status names, never application data. Plugin log lines (`pluginLogging`, development builds only) are copied out of plugin memory with a 1024-byte cap, decoded leniently, rate limited by their own token bucket, and delivered as events; a throwing listener never reaches the plugin. |
| Packaging | Deterministic archives with SHA-256 per file and for the archive; sources excluded by default; no environment files are read. |
| Dev server | Local only by default (`127.0.0.1`), GET/HEAD only, strict path containment (any `..` segment is rejected), no credentials, no proxying. |

## Not guaranteed

- **CPU.** A plugin can spend arbitrary time inside `process`. Browsers provide no per-module quota. Expect glitches from a hostile or slow plugin; use `diagnostics` to observe `processing-over-budget`, and consider stronger isolation before loading third-party plugins at scale.
- **Memory pressure in the worklet.** Limits cap each instance; the total is `maxPlugins × maxMemoryBytes`.
- **Custom UI.** Not executed in this release. When implemented it will run in a sandboxed iframe with a narrow postMessage bridge, never in the host's main world.
- **Signatures.** Archives are hashed, not signed. Verify provenance out of band.

## Hosting requirements

Serve the worklet and artifacts from your origin or an origin in `allowedPluginOrigins` with CORS headers; `.wasm` as `application/wasm`; HTTPS (secure context) for `AudioWorklet`. Cross-origin isolation (COOP/COEP) is **not** required; the runtime uses no `SharedArrayBuffer`.

Report vulnerabilities per [SECURITY.md](../SECURITY.md).
