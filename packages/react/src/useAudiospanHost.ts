import { AudiospanError, AudiospanHost, type AudiospanHostOptions } from "@audiospan/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

export type AudiospanHostStatus = "idle" | "starting" | "running" | "error";

export interface UseAudiospanHostOptions extends Omit<AudiospanHostOptions, "audioContext"> {
  /**
   * The AudioContext to use, or a factory called inside `start()`. Default: a
   * new `AudioContext`, which the hook closes again in `stop()`. Not used when
   * a custom `transport` is given.
   */
  audioContext?: BaseAudioContext | (() => BaseAudioContext);
  /** Connect the chain output to `audioContext.destination` on start (default true). */
  connectDestination?: boolean;
}

export interface AudiospanHostHandle {
  /** The host while running, otherwise null. */
  host: AudiospanHost | null;
  /** The AudioContext while running (null with a custom transport). */
  audioContext: BaseAudioContext | null;
  status: AudiospanHostStatus;
  error: AudiospanError | null;
  /** Create the AudioContext (if needed) and the host. Call it from a user gesture. Resolves with the host. */
  start(): Promise<AudiospanHost>;
  /** Dispose the host and close the AudioContext the hook created. */
  stop(): Promise<void>;
}

function toError(error: unknown): AudiospanError {
  return error instanceof AudiospanError ? error : new AudiospanError("RUNTIME_ERROR", error instanceof Error ? error.message : String(error), { cause: error });
}

/**
 * Owns an `AudiospanHost` (and, unless you supply one, an `AudioContext`) for
 * the lifetime of a component. Everything is torn down on unmount. Options
 * are read when `start()` runs, so an inline options object is fine.
 */
export function useAudiospanHost(options: UseAudiospanHostOptions = {}): AudiospanHostHandle {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [host, setHost] = useState<AudiospanHost | null>(null);
  const [audioContext, setAudioContext] = useState<BaseAudioContext | null>(null);
  const [status, setStatus] = useState<AudiospanHostStatus>("idle");
  const [error, setError] = useState<AudiospanError | null>(null);
  const live = useRef<{ host: AudiospanHost | null; context: BaseAudioContext | null; ownsContext: boolean; starting: Promise<AudiospanHost> | null }>({ host: null, context: null, ownsContext: false, starting: null });

  const stop = useCallback(async () => {
    const r = live.current;
    r.starting = null;
    const { host: h, context, ownsContext } = r;
    r.host = null;
    r.context = null;
    r.ownsContext = false;
    setHost(null);
    setAudioContext(null);
    setStatus("idle");
    if (h) await h.dispose();
    if (context && ownsContext && "close" in context && typeof (context as AudioContext).close === "function") {
      await (context as AudioContext).close().catch(() => undefined);
    }
  }, []);

  const start = useCallback((): Promise<AudiospanHost> => {
    const r = live.current;
    if (r.host) return Promise.resolve(r.host);
    if (r.starting) return r.starting;
    const run = async (): Promise<AudiospanHost> => {
      const { audioContext: contextOption, connectDestination = true, onError, ...hostOptions } = optionsRef.current;
      setStatus("starting");
      setError(null);
      let context: BaseAudioContext | null = null;
      let ownsContext = false;
      try {
        if (!hostOptions.transport) {
          if (typeof contextOption === "function") context = contextOption();
          else if (contextOption) context = contextOption;
          else {
            context = new AudioContext();
            ownsContext = true;
          }
          if (context.state === "suspended" && "resume" in context) await (context as AudioContext).resume();
        }
        const created = await AudiospanHost.create({
          ...hostOptions,
          ...(context ? { audioContext: context } : {}),
          onError: (e) => {
            setError(e);
            onError?.(e);
          },
        });
        if (r.starting !== pending) {
          // stop() ran while we were starting.
          await created.dispose();
          if (ownsContext && context) await (context as AudioContext).close().catch(() => undefined);
          throw new AudiospanError("DISPOSED", "host stopped while starting");
        }
        if (context && connectDestination) created.connectDestination(context.destination);
        r.host = created;
        r.context = context;
        r.ownsContext = ownsContext;
        r.starting = null;
        setHost(created);
        setAudioContext(context);
        setStatus("running");
        return created;
      } catch (e) {
        const err = toError(e);
        if (r.starting === pending) {
          r.starting = null;
          if (ownsContext && context) await (context as AudioContext).close().catch(() => undefined);
          setError(err);
          setStatus("error");
        }
        throw err;
      }
    };
    const pending = run();
    r.starting = pending;
    return pending;
  }, []);

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  return { host, audioContext, status, error, start, stop };
}
