# Performance harness

`bench.mjs` drives the real runtime core (`AudiospanRuntime`) and the compiled
C++ gain plugin in Node, outside the browser, so numbers are repeatable and
can be compared across commits. It measures what the AudioWorklet would do per
render quantum: copy input, call `audiospan_process` for each plugin in the
chain, copy output.

```sh
pnpm build:wasm && pnpm build          # once
pnpm bench                             # 20k blocks per scenario
node tests/performance/bench.mjs --blocks 50000 --json tests/performance/results/local.json
```

Scenarios: pass-through (0 plugins), 1, 4 and 8 gain plugins; 44.1 kHz and
48 kHz; mono and stereo; 128-frame quanta plus one 1024-frame case; diagnostics
on and off. Reported per scenario: median / p95 / p99 / max block duration, the
percentage of the real-time budget (`frames / sampleRate`) those represent,
plugin load time (compile + probe instantiate), and state serialization time.

What the numbers mean:

- **Correctness is gated elsewhere.** Unit, ABI and browser tests fail CI; the
  benchmark is reported, not enforced, until baselines are stable on a defined
  reference machine (see docs/roadmap.md).
- **Node is not the browser.** V8's WASM tier and the lack of audio-thread
  scheduling mean absolute numbers differ from Chrome/Firefox/Safari. Use the
  harness for relative comparisons (regressions in the bridge or chain loop),
  and the browser `processing-stats` diagnostic for in-situ measurements.
- **Zero allocations** in the steady-state hot path is asserted by
  `packages/runtime/test/runtime.test.ts`, not inferred from timings.

Record the machine, OS, browser/Node version and commit alongside any numbers
you publish. Results in `results/` are git-ignored.
