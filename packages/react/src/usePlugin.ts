import { createPluginStore, type AddPluginOptions, type AudiospanError, type AudiospanHost, type PluginDescriptor, type PluginInstance, type PluginSnapshot, type PluginSourceInput, type PluginStore } from "@audiospan/sdk";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type PluginStatus = "idle" | "loading" | "ready" | "error" | "disposed";

/** The parameter ids of a (typed) plugin instance; `string` for an untyped `PluginInstance`. */
export type ParameterIdOf<T> = T extends { setParameter(id: infer P, value: number): void } ? Extract<P, string> : string;
/** The output ids of a (typed) plugin instance. */
export type OutputIdOf<T> = T extends { getOutput(id: infer O): number } ? Extract<O, string> : string;
/** The preset ids of a (typed) plugin instance. */
export type PresetIdOf<T> = T extends { loadPreset(id: infer R): Promise<void> } ? Extract<R, string> : string;

/**
 * What `usePlugin` returns. With a generated plugin type as the type
 * argument (`usePlugin<LowpassPlugin>(…)`), every id below is checked at
 * compile time.
 */
export interface PluginHandle<T extends PluginInstance = PluginInstance> {
  /** The instance once ready, otherwise null. */
  plugin: T | null;
  descriptor: PluginDescriptor | null;
  status: PluginStatus;
  error: AudiospanError | null;
  /** Parameter values by id, kept in sync with the instance (empty until ready). */
  values: Readonly<Partial<Record<ParameterIdOf<T>, number>>>;
  /** Read-only output values (meters) by id, refreshed while audio runs. */
  outputs: Readonly<Partial<Record<OutputIdOf<T>, number>>>;
  bypassed: boolean;
  latencyFrames: number;
  setParameter(id: ParameterIdOf<T>, value: number): void;
  setParameterNormalized(id: ParameterIdOf<T>, normalized: number): void;
  setBypassed(bypassed: boolean): void;
  loadPreset(presetId: PresetIdOf<T>): Promise<void>;
  reset(): Promise<void>;
}

const IDLE: PluginSnapshot = Object.freeze({ plugin: null, descriptor: null, status: "loading", error: null, values: Object.freeze({}), outputs: Object.freeze({}), bypassed: false, latencyFrames: 0 });
const getIdle = () => IDLE;
const noopSubscribe = () => () => {};

/**
 * Load a plugin into `host` (through `host.addPlugin`, so it joins the active
 * chain) and mirror its values and events into React state. The instance is
 * disposed when the component unmounts, when `source` changes, or when `host`
 * becomes null. Pass `null` as `source` to wait. Safe under StrictMode and
 * hot reloading: each mount owns exactly one instance.
 */
export function usePlugin<T extends PluginInstance = PluginInstance>(host: AudiospanHost | null, source: PluginSourceInput | null, options: AddPluginOptions = {}): PluginHandle<T> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sourceKey = typeof source === "string" ? source : source instanceof URL ? source.href : source;
  const [store, setStore] = useState<PluginStore<T> | null>(null);

  useEffect(() => {
    if (!host || !source) {
      setStore(null);
      return;
    }
    const created = createPluginStore<T>(host, source, optionsRef.current);
    setStore(created);
    return () => {
      setStore((current) => (current === created ? null : current));
      void created.dispose();
    };
    // sourceKey stands in for `source` so an equivalent URL does not reload the plugin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, sourceKey]);

  const snapshot = useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.getSnapshot : getIdle, store ? store.getSnapshot : getIdle) as PluginSnapshot<T>;
  const plugin = snapshot.plugin;

  const setParameter = useCallback((id: ParameterIdOf<T>, value: number) => plugin?.setParameter(id, value), [plugin]);
  const setParameterNormalized = useCallback((id: ParameterIdOf<T>, normalized: number) => plugin?.setParameterNormalized(id, normalized), [plugin]);
  const setBypassed = useCallback((bypassed: boolean) => plugin?.setBypassed(bypassed), [plugin]);
  const loadPreset = useCallback(async (presetId: PresetIdOf<T>) => plugin?.loadPreset(presetId), [plugin]);
  const reset = useCallback(async () => plugin?.reset(), [plugin]);

  return {
    plugin,
    descriptor: snapshot.descriptor,
    status: store ? snapshot.status : "idle",
    error: snapshot.error,
    values: snapshot.values as PluginHandle<T>["values"],
    outputs: snapshot.outputs as PluginHandle<T>["outputs"],
    bypassed: snapshot.bypassed,
    latencyFrames: snapshot.latencyFrames,
    setParameter,
    setParameterNormalized,
    setBypassed,
    loadPreset,
    reset,
  };
}
