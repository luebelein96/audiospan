# @audiospan/runtime

The Audiospan AudioWorklet runtime: `dist/audiospan-worklet.js` (self-contained; the SDK embeds it, or serve it and pass its URL as `workletUrl`), the message protocol, the WASM memory bridge (`WasmPluginInstance`), the binary inspector (`inspectWasmModule`), and `AudiospanRuntime`, the processor core that can also run in Node.

Docs: [architecture](../../docs/architecture.md), [ABI](../../docs/abi.md).
