---
title: "Security model"
description: "Where trust ends, what the host checks, what it cannot promise, and what your server has to do."
---

Plugins, manifests, presets and everything else inside an artifact are **untrusted**. WebAssembly isolates memory. Everything beyond that is the host's job.

## Trust boundaries

```
Application (trusted)
  └─ @audiospan/sdk (main thread): validation, policy, control plane
       └─ MessagePort (validated discriminated messages, both directions)
            └─ @audiospan/runtime in the AudioWorklet: command handling, chain, memory bridge
                 └─ WebAssembly instance per plugin: linear memory only, no imports beyond stubs (plus a log sink in development)
```

The only thing a plugin ever receives is a call to one of its own exports, with host-allocated buffers inside its own memory. It never holds a reference to a JavaScript object.

## Protections (implemented)

| Area | Mechanism |
| --- | --- |
| Manifest | A size limit (256 KiB by default) before parsing. Schema and cross-field validation. Reverse-DNS ids and semantic versions. Only safe relative paths: no traversal, schemes or encoded dots. A capability allowlist: network, filesystem, MIDI and sidechain are always denied, `customUI` unless policy grants it. Resource caps checked against hard limits and host policy. |
| Module | A size limit (8 MiB by default), enforced while the body streams, so a server that under-reports `Content-Length` cannot push more. The binary is inspected before compilation: required exports present (plus `audiospan_get_output` when the manifest declares outputs), every import on the allowlist, memory declared with a maximum of at most `min(manifest, policy)` or imported so the host creates it with that cap, no shared memory. `WebAssembly.validate` runs on the main thread. The worklet compiles, checks exports and imports again with the JS API, and probe-instantiates before the plugin is advertised. The development-only `env.audiospan_log` import is refused unless the host sets `pluginLogging`. |
| Worklet | Loaded from the SDK's embedded copy through a short-lived blob URL (revoked after `addModule`), or from `workletUrl` when given. A CSP without `blob:` in `script-src` must use `workletUrl`. If the script throws while evaluating, the processor never registers; the SDK names that case in `WORKLET_INIT_FAILED`. |
| Origins | Plugin URLs must be same-origin or in `allowedPluginOrigins`, unless `allowRemotePlugins` is set. Only `http(s)`, `blob:` and `file:` URLs. Redirects are refused. Requests use `credentials: same-origin`. A page with an opaque origin (`file://`, sandboxed) counts as origin `"null"`, so it can load `file:` plugins but not arbitrary remote ones. |
| Application hook | `pluginPolicy.allowPlugin(manifest, sourceUrl)` for your own allow or block list. |
| Instances | `maxPlugins` (8 by default) is enforced on both sides, including against creations still in flight. Duplicate ids are rejected. The memory limit is checked again after allocation, after state calls and after growth. |
| State | Base64 is validated and the decoded size must be at most `maxStateBytes` (1 MiB by default) before anything is transferred. The plugin's `set_state` must validate too. The runtime rejects oversized `get_state` results. Validation happens before application, and the runtime snapshots the instance first, so a refused blob or parameter restores the previous state. |
| Messages | Every main-to-worklet message is parsed field by field (`parseMainMessage`). Unknown types, wrong protocol versions, non-finite numbers and bad ids or indices are rejected with `PROTOCOL_MESSAGE_INVALID`. Stale sequence numbers are ignored. Request ids are unique per session. Worklet-to-main messages are matched by request id; unexpected responses are dropped. |
| Failure containment | A trap or error status from `process` means pass-through for that block. Three failures in a row (`processErrorBypassThreshold`) bypass the instance until reset. Unsolicited errors, diagnostics and plugin log lines are rate limited by separate token buckets (20 per second each, `diagnosticsPerSecond`). The one-shot `INSTANCE_ERRORED` and `LATENCY_CHANGED` messages are never dropped. A failing `audiospan_get_output` is reported once and not polled again. Output values arrive at a bounded `outputsPerSecond`. |
| Logging | Nothing is written to the console from the audio thread. Error messages carry plugin ids and status names, never application data. Plugin log lines (`pluginLogging`, development builds only) are copied out of plugin memory with a 1024-byte cap, decoded leniently, rate limited by their own token bucket and delivered as events. A listener that throws never reaches the plugin. |
| Packaging | Deterministic archives with a SHA-256 per file and for the archive. Sources are excluded by default. No environment files are read. |
| Dev server | Binds to `127.0.0.1` by default, GET and HEAD only, strict path containment (any `..` segment is rejected), no credentials, no proxying. |

## Not guaranteed

- **CPU.** A plugin can spend as long as it likes inside `process`. Browsers have no per-module quota. A hostile or slow plugin will cause glitches. Turn on `diagnostics` to see `processing-over-budget`, and think about stronger isolation before loading third-party plugins at scale.
- **Memory pressure in the worklet.** Each instance is capped, but the total can reach `maxPlugins × maxMemoryBytes`.
- **Custom UI.** Not executed in this release. When it arrives it will run in a sandboxed iframe with a narrow postMessage bridge, never in the host's main world.
- **Signatures.** Archives are hashed, not signed. Verify where they came from some other way.

## Hosting requirements

Serve the worklet and the artifacts from your own origin, or from an origin listed in `allowedPluginOrigins` with CORS headers. Send `.wasm` as `application/wasm`. Use HTTPS, since `AudioWorklet` needs a secure context. Cross-origin isolation (COOP/COEP) is **not** required; the runtime uses no `SharedArrayBuffer`.

Report vulnerabilities as described in [SECURITY.md](https://github.com/luebelein96/audiospan/blob/main/SECURITY.md).
