import { useEffect, useRef, useState } from "react";
import type { AudiospanHostHandle } from "./useAudiospanHost.js";

/**
 * What to feed into the chain: the microphone, a `MediaStream`, an `<audio>`
 * or `<video>` element, a decoded `AudioBuffer` (looped), any `AudioNode`, or
 * a factory that builds one from the context. `null` connects nothing.
 */
export type AudioSourceInput = "microphone" | MediaStream | HTMLMediaElement | AudioBuffer | AudioNode | ((context: BaseAudioContext) => AudioNode | Promise<AudioNode>) | null;

export interface UseAudioSourceOptions {
  /** `getUserMedia` audio constraints for `"microphone"` (default `true`). */
  constraints?: MediaTrackConstraints | boolean;
  /** Loop an `AudioBuffer` source (default true). */
  loop?: boolean;
}

export type AudioSourceStatus = "idle" | "connecting" | "connected" | "error";

export interface AudioSourceHandle {
  status: AudioSourceStatus;
  error: Error | null;
  /** The node connected to the chain while connected. */
  node: AudioNode | null;
}

export interface ResolvedSource {
  node: AudioNode;
  /** Stop and release whatever this hook created (tracks, buffer sources). */
  cleanup(): void;
}

// createMediaElementSource may be called once per element; remember the node so remounts reuse it.
const elementSources = new WeakMap<HTMLMediaElement, { context: BaseAudioContext; node: AudioNode }>();

/** Media sources exist on a real-time AudioContext only (not on OfflineAudioContext). */
function mediaContext(context: BaseAudioContext, what: string): AudioContext {
  if (!("createMediaStreamSource" in context)) throw new Error(`${what} needs a real-time AudioContext; an OfflineAudioContext cannot capture media`);
  return context as AudioContext;
}

/** Turn an `AudioSourceInput` into a connectable node. Exported for tests and for non-React callers. */
export async function resolveAudioSource(context: BaseAudioContext, source: Exclude<AudioSourceInput, null>, options: UseAudioSourceOptions = {}): Promise<ResolvedSource> {
  if (source === "microphone") {
    const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!devices?.getUserMedia) throw new Error("the microphone is unavailable: navigator.mediaDevices.getUserMedia is missing (insecure context or unsupported browser)");
    const stream = await devices.getUserMedia({ audio: options.constraints ?? true });
    const node = mediaContext(context, "the microphone").createMediaStreamSource(stream);
    return { node, cleanup: () => stream.getTracks().forEach((track) => track.stop()) };
  }
  if (typeof source === "function") {
    const node = await source(context);
    return { node, cleanup: () => {} };
  }
  if (typeof MediaStream !== "undefined" && source instanceof MediaStream) {
    return { node: mediaContext(context, "a MediaStream").createMediaStreamSource(source), cleanup: () => {} };
  }
  if (typeof HTMLMediaElement !== "undefined" && source instanceof HTMLMediaElement) {
    const cached = elementSources.get(source);
    if (cached && cached.context === context) return { node: cached.node, cleanup: () => {} };
    const node = mediaContext(context, "a media element").createMediaElementSource(source);
    elementSources.set(source, { context, node });
    return { node, cleanup: () => {} };
  }
  if (typeof AudioBuffer !== "undefined" && source instanceof AudioBuffer) {
    const node = context.createBufferSource();
    node.buffer = source;
    node.loop = options.loop ?? true;
    node.start();
    return {
      node,
      cleanup: () => {
        try {
          node.stop();
        } catch {
          // already stopped
        }
      },
    };
  }
  return { node: source as AudioNode, cleanup: () => {} };
}

/**
 * Connect an audio source to a running host and disconnect it again when the
 * host stops, the source changes, or the component unmounts. Microphone
 * tracks and buffer sources the hook created are stopped on cleanup; nodes
 * and streams you pass in are left running.
 *
 *   const audio = useAudiospanHost();
 *   useAudioSource(audio, "microphone");
 *   useAudioSource(audio, (ctx) => { const osc = ctx.createOscillator(); osc.start(); return osc; });
 *
 * A factory may be written inline: it is called once per connection, and a
 * new function identity on re-render does not reconnect. To switch sources,
 * pass a different kind of value (or a different element, stream or node).
 */
export function useAudioSource(audio: Pick<AudiospanHostHandle, "host" | "audioContext" | "status">, source: AudioSourceInput, options: UseAudioSourceOptions = {}): AudioSourceHandle {
  const [state, setState] = useState<AudioSourceHandle>({ status: "idle", error: null, node: null });
  const { host, audioContext, status } = audio;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Re-run only when the source *kind* (or a concrete element/stream/node) changes, never on a fresh inline closure or options object.
  const sourceKey = typeof source === "function" ? "factory" : source;
  const optionsKey = JSON.stringify([options.constraints ?? null, options.loop ?? null]);
  const loop = options.loop;
  useEffect(() => {
    const current = sourceRef.current;
    if (!host || !audioContext || status !== "running" || current === null) {
      setState({ status: "idle", error: null, node: null });
      return;
    }
    let cancelled = false;
    let resolved: ResolvedSource | null = null;
    const constraints = optionsRef.current.constraints;
    setState({ status: "connecting", error: null, node: null });
    resolveAudioSource(audioContext, current, { ...(constraints !== undefined ? { constraints } : {}), ...(loop !== undefined ? { loop } : {}) })
      .then((r) => {
        if (cancelled) {
          r.cleanup();
          return;
        }
        resolved = r;
        host.connectSource(r.node);
        setState({ status: "connected", error: null, node: r.node });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", error: error instanceof Error ? error : new Error(String(error)), node: null });
      });
    return () => {
      cancelled = true;
      if (resolved) {
        if (host.status === "ready") host.disconnectSource(resolved.node);
        resolved.cleanup();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, audioContext, status, sourceKey, optionsKey]);
  return state;
}
