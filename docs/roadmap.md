# Roadmap

The long-form backlog with rationale, dependencies, and extension points per item is in [future-features.md](future-features.md).

## Shipped in 0.1.0 (MVP)

- ABI v1 header, C++ helper, Rust bindings, plain-C example, conformance suite
- Manifest schema v1 with validator, parameter math, state/preset validation
- AudioWorklet runtime: single processor, serial chain, bypass, pass-through, memory bridge, error policy, rate-limited diagnostics, zero-allocation hot path
- TypeScript SDK: host, descriptors, instances, chains, state/presets, typed errors, policy, in-process test transport
- Default UI panel (slider, knob, stepper, toggle, select, bypass, reset, presets, status)
- CLI: create, build, test, validate, pack, dev, doctor; C++ and Rust templates; sandbox page with live reload
- Vanilla and React examples; Playwright browser tests on Chromium; Node benchmark harness
- Documentation set and decision records

## Next (ordered by expected demand)

1. Firefox and WebKit in the browser test matrix; performance baselines on a named reference machine.
2. More DSP examples: biquad filter, delay, compressor; a `--template filter` for the CLI.
3. Sample-accurate parameter automation (timestamped events in the process descriptor via ABI v2 fields).
4. Custom UI sandbox: iframe isolation, narrow bridge, host policy `hosted-ui` / `trusted-custom-ui`.
5. Plugin metadata inspection tooling (`audiospan inspect`) and richer diagnostics overlay.
6. MIDI/event input for instruments (ABI extension behind a capability).
7. Graph routing, buses, sidechains, latency compensation.
8. Plugin registry / private distribution; signed archives.
9. CLAP/WASM compatibility research (WebCLAP) as a separately scoped adapter.
10. JUCE DSP porting helpers.

## Explicitly deferred

Desktop plugin hosting (VST3/AU), a DAW UI, marketplace/billing, threaded or SIMD-only runtimes, arbitrary plugin JavaScript in the host's main world, hard real-time guarantees.
