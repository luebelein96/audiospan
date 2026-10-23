# Security policy

## Reporting a vulnerability

Email security reports to **security@audiospan.dev** with a description, reproduction steps, affected versions, and your assessment of impact. Do not open public issues for undisclosed vulnerabilities. You will receive an acknowledgement within 5 business days and a remediation plan or status update within 30 days. We credit reporters in release notes unless asked not to.

## Scope

- `@audiospan/sdk`, `@audiospan/runtime`, `@audiospan/manifest`, `@audiospan/ui`, `@audiospan/cli`
- The ABI headers and reference plugins
- The developer server started by `audiospan dev` (intended for local use only)

## Trust model in brief

Plugins are untrusted input. The host validates manifests, artifact paths, module imports/exports, memory limits, state sizes, message shapes, and instance counts, and bypasses plugins that keep failing. WebAssembly isolates memory but is not a complete sandbox: a plugin can still burn CPU inside the audio callback. See [docs/security-model.md](docs/security-model.md) for the full list of protections and non-guarantees.
