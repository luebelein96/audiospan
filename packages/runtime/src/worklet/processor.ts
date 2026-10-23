/**
 * AudioWorklet entry point. Bundled by build-worklet.mjs into a single
 * self-contained file (dist/audiospan-worklet.js) that the host loads with
 * `audioContext.audioWorklet.addModule(url)`.
 */
import { PROCESSOR_NAME } from "../protocol.js";
import { AudiospanRuntime } from "../runtime.js";

const EMPTY: Float32Array[] = [];

class AudiospanProcessor extends AudioWorkletProcessor {
  private readonly runtime: AudiospanRuntime;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.runtime = new AudiospanRuntime((message, transfer) => {
      if (transfer && transfer.length > 0) this.port.postMessage(message, transfer);
      else this.port.postMessage(message);
    });
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      this.runtime.handleMessage(event.data);
    };
    // Fired when a message cannot be deserialized in this global scope (for
    // example a WebAssembly.Module in browsers that cannot clone one here).
    this.port.onmessageerror = () => {
      this.port.postMessage({ type: "ERROR", code: "PROTOCOL_CLONE_FAILED", message: "a message could not be deserialized in the AudioWorklet; the host falls back to transferring module bytes" });
    };
  }

  override process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    return this.runtime.process(inputs[0] ?? EMPTY, outputs[0] ?? EMPTY);
  }
}

registerProcessor(PROCESSOR_NAME, AudiospanProcessor);
