import type { MainToWorkletMessage, RuntimeDiagnostic, WorkletToMainMessage } from "@audiospan/runtime";
import { AudiospanError, mapRuntimeErrorCode } from "./errors.js";
import type { WorkletTransport } from "./transport.js";

type ResponseType = Exclude<WorkletToMainMessage["type"], "ERROR" | "DIAGNOSTIC" | "LATENCY_CHANGED" | "OUTPUT_VALUES" | "LOG">;
type ResponseOf<T extends ResponseType> = Extract<WorkletToMainMessage, { type: T }>;
type ErrorMessage = Extract<WorkletToMainMessage, { type: "ERROR" }>;
export type LogMessage = Extract<WorkletToMainMessage, { type: "LOG" }>;

interface Pending {
  expect: readonly ResponseType[];
  resolve: (message: WorkletToMainMessage) => void;
  reject: (error: AudiospanError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface ConnectionHandlers {
  onError: (error: AudiospanError, raw: ErrorMessage) => void;
  onDiagnostic: (event: RuntimeDiagnostic) => void;
  onLatency: (instanceId: string, latencyFrames: number) => void;
  onOutputs: (values: readonly [instanceId: string, values: number[]][]) => void;
  onLog: (message: LogMessage) => void;
}

/** Correlates requests with responses over a transport; owns request ids. */
export class RuntimeConnection {
  private readonly transport: WorkletTransport;
  private readonly timeoutMs: number;
  private readonly handlers: ConnectionHandlers;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private sequence = 0;
  private closed = false;
  private readonly cloneFailureListeners = new Set<() => boolean>();

  constructor(transport: WorkletTransport, timeoutMs: number, handlers: ConnectionHandlers) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.handlers = handlers;
    transport.onMessage((message) => this.receive(message));
  }

  nextRequestId(): number {
    return this.nextId++;
  }

  nextSequence(): number {
    return this.sequence++;
  }

  /**
   * Register a listener for PROTOCOL_CLONE_FAILED errors from the worklet.
   * Return true from the listener to mark the failure handled (no host error).
   */
  onCloneFailure(listener: () => boolean): () => void {
    this.cloneFailureListeners.add(listener);
    return () => this.cloneFailureListeners.delete(listener);
  }

  /** Fire-and-forget (parameter and bypass updates). */
  send(message: MainToWorkletMessage): void {
    if (this.closed) return;
    this.transport.postMessage(message);
  }

  /** Send a message carrying a requestId and wait for one of the expected responses. */
  request<T extends ResponseType>(message: MainToWorkletMessage & { requestId: number }, expect: readonly T[], transfer?: Transferable[]): Promise<ResponseOf<T>> {
    if (this.closed) return Promise.reject(new AudiospanError("DISPOSED", "host has been disposed"));
    return new Promise<ResponseOf<T>>((resolve, reject) => {
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(message.requestId);
              reject(new AudiospanError("REQUEST_TIMEOUT", `runtime did not answer ${message.type} within ${this.timeoutMs} ms`));
            }, this.timeoutMs)
          : undefined;
      this.pending.set(message.requestId, { expect, resolve: resolve as (m: WorkletToMainMessage) => void, reject, timer });
      try {
        this.transport.postMessage(message, transfer);
      } catch (error) {
        this.pending.delete(message.requestId);
        if (timer !== undefined) clearTimeout(timer);
        // postMessage throws DataCloneError when the payload cannot be structured-cloned at all.
        const cloneFailed = typeof error === "object" && error !== null && (error as { name?: unknown }).name === "DataCloneError";
        reject(
          new AudiospanError("RUNTIME_ERROR", `failed to post ${message.type} to the runtime: ${(error as Error).message}`, {
            cause: error,
            ...(cloneFailed ? { runtimeCode: "PROTOCOL_CLONE_FAILED" as const } : {}),
          }),
        );
      }
    });
  }

  /** Reject a pending request locally, for example when the runtime can never answer it. */
  cancel(requestId: number, error: AudiospanError): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.reject(error);
  }

  private receive(message: WorkletToMainMessage): void {
    if (this.closed) return;
    if (message.type === "DIAGNOSTIC") {
      this.handlers.onDiagnostic(message.event);
      return;
    }
    if (message.type === "LATENCY_CHANGED") {
      this.handlers.onLatency(message.instanceId, message.latencyFrames);
      return;
    }
    if (message.type === "OUTPUT_VALUES") {
      this.handlers.onOutputs(message.values);
      return;
    }
    if (message.type === "LOG") {
      this.handlers.onLog(message);
      return;
    }
    if (message.type === "ERROR") {
      const error = new AudiospanError(mapRuntimeErrorCode(message.code), message.message, {
        runtimeCode: message.code,
        ...(message.instanceId !== undefined ? { instanceId: message.instanceId } : {}),
        ...(message.pluginId !== undefined ? { pluginId: message.pluginId } : {}),
      });
      if (message.code === "PROTOCOL_CLONE_FAILED") {
        let handled = false;
        for (const listener of Array.from(this.cloneFailureListeners)) handled = listener() || handled;
        if (handled) return;
      }
      if (message.requestId !== undefined) {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          pending.reject(error);
          return;
        }
      }
      this.handlers.onError(error, message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return; // stale or unknown response; ignore
    if (!pending.expect.includes(message.type)) {
      this.pending.delete(message.requestId);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new AudiospanError("RUNTIME_ERROR", `unexpected ${message.type} response for request ${message.requestId}`));
      return;
    }
    this.pending.delete(message.requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.resolve(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new AudiospanError("DISPOSED", `host disposed while request ${id} was pending`));
    }
    this.pending.clear();
    this.transport.close();
  }
}
