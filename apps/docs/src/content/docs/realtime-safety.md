---
title: "Real-time safety"
description: "What process() may and may not do, what the runtime does for each block, and how numbers behave."
---

At 48 kHz with 128-frame quanta, the AudioWorklet calls `process()` about every 2.7 ms. Miss that deadline and you hear it. These rules apply to your plugin's `process` and to the runtime's own hot path.

## Allowed in `audiospan_process`

- Arithmetic over the buffers you are given, reading parameter values set earlier, fixed-size temporaries on the stack, and lookups in tables you allocated in `create`.
- Writing every sample of every output channel. Silence has to be written too.
- Returning a status right away.

## Not allowed

- Heap allocation: `malloc`, `new`, `Vec::push` past capacity, `Box`, `free`, or anything else that can grow memory. If memory grows during `process`, the runtime treats that block as failed.
- Blocking: locks, waits, sleeps, spinning on atomics, synchronous I/O.
- Filesystem, network, timers, or any host API. The runtime provides none of them. WASI stubs return `ENOSYS` and `proc_exit` traps.
- Logging. The runtime never logs from the audio thread; diagnostics go out as rate-limited messages, 20 per second by default. Development builds can call `audiospan_log` from control-plane exports, but inside `process` each line costs a host call and gets rate limited away. Keep it out.
- Exceptions, panics, `unreachable`, out-of-bounds access. All of these trap. The runtime catches the trap, passes the input through for that block, and bypasses the instance after three failures in a row.
- Keeping `inputs`, `outputs` or the descriptor after you return.
- Unbounded work: anything whose cost depends on more than `frame_count × channels`.

## Parameters

The runtime calls `audiospan_set_parameter` on the same thread as `process`, between blocks, never at the same time. Your plugin can store the value directly. If you want smoothing, do it inside `process`. A parameter message that arrives mid-block takes effect at the next block.

The optional `audiospan_get_output` and `audiospan_get_latency` run on that same thread, between blocks, so they can read members that `process` writes without any locking. Keep them to a plain copy. `audiospan_get_latency` runs after every parameter change, so it has to be cheap.

## Control-plane calls

`create`, `destroy`, `reset`, `get_state_size`, `get_state`, `set_state` and `audiospan_alloc` run between render quanta on the worklet thread. They may allocate and may take a while, which can cause a glitch while they run. Keep them bounded (state size is capped by `resources.maxStateBytes`) and do not call them in tight loops.

## What the runtime does per block

1. Empty chain: copy input to output.
2. `frame_count` above the configured `maxFrames`: pass through and post a `frames-unsupported` diagnostic.
3. For each plugin in order: copy the block's channels into the plugin's input buffers in module memory and call `process`. The next stage reads straight from this plugin's output buffers. If the plugin is bypassed or errored, or the call fails, the block goes through a scratch buffer instead and the failure is recorded.
4. Copy the last stage's output to the worklet outputs.

Scratch buffers are allocated once per frame count and only used by pass-through stages. Typed-array views are cached. The steady-state loop creates no objects; `packages/runtime/test/runtime.test.ts` fails if a `Float32Array` is constructed during 100 consecutive blocks.

## Numerical behaviour

The host does not clip. Plugins may go beyond ±1. With the host option `scanNonFinite: true`, NaN and Infinity samples are replaced with zero after each plugin, and reported as `non-finite-output` if `diagnostics` is on too. The option is off by default and independent of `diagnostics`. Without it, non-finite values pass through unchanged, so plugins must not produce them. Bit-exact output across platforms is not guaranteed; the tests use tolerances (`1e-6` for the gain vectors).
