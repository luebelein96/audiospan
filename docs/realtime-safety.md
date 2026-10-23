# Real-time safety

The AudioWorklet calls `process()` roughly every 2.7 ms at 48 kHz with 128-frame quanta. Missing the deadline is audible. These rules apply to plugin `process` implementations and to the Audiospan runtime's own hot path.

## Allowed in `audiospan_process`

- Arithmetic over the provided buffers, reads of parameter values set earlier, fixed-size stack temporaries, lookups in tables allocated at `create`.
- Writing every sample of every output channel. Silence must be written explicitly.
- Returning a status immediately.

## Not allowed

- Heap allocation (`malloc`, `new`, `Vec::push` beyond capacity, `Box`), `free`, or anything that can grow memory. Memory growth during `process` is detected and treated as a block failure.
- Blocking: locks, waits, sleeps, atomics spin-loops, synchronous I/O.
- Filesystem, network, timers, or any host API. The runtime provides none; WASI stubs return `ENOSYS` and `proc_exit` traps.
- Logging. The runtime never logs from the audio thread (diagnostics are posted as rate-limited messages, 20/s by default). Development builds may call `audiospan_log` from control-plane exports; inside `process` it costs a host call per line and is rate limited away, so keep it out.
- Exceptions, panics, `unreachable`, out-of-bounds access. These trap; the runtime catches the trap, passes the input through for that block, and bypasses the instance after three consecutive failures.
- Retaining `inputs`/`outputs` pointers or the descriptor after returning.
- Unbounded work: anything whose cost depends on more than `frame_count × channels`.

## Parameters

`audiospan_set_parameter` is called by the runtime on the same thread as `process`, between blocks, never concurrently. Plugins may store the value directly. Smoothing, if desired, belongs inside `process`. Control-plane parameter messages arriving mid-block take effect at the next block boundary. The optional `audiospan_get_output` and `audiospan_get_latency` are called on the same thread, between blocks, so they may read members that `process` writes without synchronisation; keep them to a copy. `audiospan_get_latency` runs after every parameter change, so it must be cheap.

## Control-plane calls

`create`, `destroy`, `reset`, `get_state_size`, `get_state`, `set_state`, and `audiospan_alloc` run between render quanta on the worklet thread. They may allocate and take variable time, which can cause a glitch while they run. Keep them bounded (state size is limited by `resources.maxStateBytes`) and avoid calling them in tight loops.

## What the runtime does per block

1. If the chain is empty: copy input to output.
2. If `frame_count` exceeds the configured `maxFrames`: pass through and post a `frames-unsupported` diagnostic.
3. For each plugin in order: copy the current block's channels into the plugin's input buffers in module memory and call `process`; the next stage reads straight from that plugin's output buffers. If the plugin is bypassed or errored, or the call fails, the block is copied through a scratch buffer instead and the failure recorded.
4. Copy the last stage's output to the worklet outputs.

Scratch buffers are allocated once per frame count and only touched by pass-through stages. Typed-array views are cached. The steady-state loop constructs no objects; `packages/runtime/test/runtime.test.ts` fails if a `Float32Array` is constructed during 100 consecutive blocks.

## Numerical behaviour

The host does not clip. Plugins may exceed ±1. With the host option `scanNonFinite: true`, NaN/Infinity samples are replaced with zero after each plugin (and reported as `non-finite-output` when `diagnostics` is also on); it is off by default and independent of `diagnostics`, so without it they propagate unchanged and plugins must not emit them. Bit-exact output across platforms is not guaranteed; tests use tolerances (`1e-6` for the gain vectors).
