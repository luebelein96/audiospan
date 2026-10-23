import type { MainToWorkletMessage, WorkletToMainMessage } from "@audiospan/runtime";

/**
 * The narrow seam between the SDK and the audio runtime. The default
 * implementation wraps an AudioWorkletNode's MessagePort; tests use an
 * in-process transport (see ./testing.ts).
 */
export interface WorkletTransport {
  postMessage(message: MainToWorkletMessage, transfer?: Transferable[]): void;
  onMessage(listener: (message: WorkletToMainMessage) => void): void;
  close(): void;
}

export class AudioWorkletTransport implements WorkletTransport {
  private readonly port: MessagePort;
  private listener: ((message: WorkletToMainMessage) => void) | null = null;

  constructor(node: AudioWorkletNode) {
    this.port = node.port;
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== "object" || data === null || typeof (data as { type?: unknown }).type !== "string") return;
      this.listener?.(data as WorkletToMainMessage);
    };
  }

  postMessage(message: MainToWorkletMessage, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) this.port.postMessage(message, transfer);
    else this.port.postMessage(message);
  }

  onMessage(listener: (message: WorkletToMainMessage) => void): void {
    this.listener = listener;
  }

  close(): void {
    this.listener = null;
    this.port.onmessage = null;
    this.port.close();
  }
}
