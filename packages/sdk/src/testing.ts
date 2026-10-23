/**
 * Test utilities: run the Audiospan runtime in-process so the whole SDK can
 * be exercised in Node (or any JS environment) without an AudioWorklet.
 * Messages are structured-cloned and delivered asynchronously to mimic a
 * MessagePort, including ArrayBuffer transfer semantics.
 */
import { AudiospanRuntime, type MainToWorkletMessage, type WorkletToMainMessage } from "@audiospan/runtime";
import type { WorkletTransport } from "./transport.js";

export interface InProcessRuntime {
  transport: WorkletTransport;
  runtime: AudiospanRuntime;
  /** Process one block through the runtime (planar channels in/out). */
  process(inputs: readonly Float32Array[], outputs: readonly Float32Array[]): boolean;
  /** Wait until all queued messages in both directions have been delivered. */
  settle(): Promise<void>;
}

/** Mirrors MessagePort.postMessage: a value that cannot be cloned throws a DataCloneError synchronously. */
function clone<T>(value: T, transfer?: Transferable[]): T {
  return structuredClone(value, transfer ? { transfer } : undefined);
}

export function createInProcessRuntime(): InProcessRuntime {
  let listener: ((message: WorkletToMainMessage) => void) | null = null;
  let closed = false;
  let inflight = 0;
  const waiters: (() => void)[] = [];
  const done = () => {
    inflight--;
    if (inflight === 0) for (const w of waiters.splice(0)) w();
  };
  const runtime = new AudiospanRuntime((message, transfer) => {
    if (closed) return;
    const copy = clone(message, transfer);
    inflight++;
    queueMicrotask(() => {
      try {
        if (!closed) listener?.(copy);
      } finally {
        done();
      }
    });
  });
  const transport: WorkletTransport = {
    postMessage(message: MainToWorkletMessage, transfer?: Transferable[]) {
      if (closed) throw new Error("transport closed");
      const copy = clone(message, transfer);
      inflight++;
      queueMicrotask(() => {
        try {
          runtime.handleMessage(copy);
        } finally {
          done();
        }
      });
    },
    onMessage(fn) {
      listener = fn;
    },
    close() {
      closed = true;
      listener = null;
      runtime.dispose();
    },
  };
  return {
    transport,
    runtime,
    process: (inputs, outputs) => runtime.process(inputs, outputs),
    settle: async () => {
      for (let i = 0; i < 50; i++) {
        if (inflight === 0) break;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}
