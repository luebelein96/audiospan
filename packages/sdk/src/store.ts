/**
 * A framework-neutral view of one plugin instance: load it into a host,
 * mirror its values and events into an immutable snapshot, and notify
 * subscribers. React consumes it through `useSyncExternalStore`; other
 * frameworks subscribe directly. Nothing here depends on the DOM.
 */
import type { AudiospanHost, AddPluginOptions } from "./host.js";
import type { AudiospanError } from "./errors.js";
import { AudiospanError as AudiospanErrorClass } from "./errors.js";
import type { PluginSourceInput } from "./loader.js";
import type { PluginDescriptor, PluginInstance } from "./types.js";

export type PluginStoreStatus = "loading" | "ready" | "error" | "disposed";

export interface PluginSnapshot<T extends PluginInstance = PluginInstance> {
  /** The instance once ready, otherwise null. */
  readonly plugin: T | null;
  readonly descriptor: PluginDescriptor | null;
  readonly status: PluginStoreStatus;
  readonly error: AudiospanError | null;
  /** Parameter values by id, kept in sync with the instance. */
  readonly values: Readonly<Record<string, number>>;
  /** Read-only output values (meters) by id, refreshed while audio runs. */
  readonly outputs: Readonly<Record<string, number>>;
  readonly bypassed: boolean;
  readonly latencyFrames: number;
}

export interface PluginStore<T extends PluginInstance = PluginInstance> {
  /** Notified after every snapshot change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** The current snapshot; the same object until something changes. */
  getSnapshot(): PluginSnapshot<T>;
  /** Resolves when the plugin is ready (or rejects with the load error). */
  ready(): Promise<T>;
  /** Unsubscribe from the instance and dispose it. Idempotent. */
  dispose(): Promise<void>;
}

const EMPTY: Readonly<Record<string, number>> = Object.freeze({});

function toError(error: unknown): AudiospanError {
  return error instanceof AudiospanErrorClass ? error : new AudiospanErrorClass("RUNTIME_ERROR", error instanceof Error ? error.message : String(error), { cause: error });
}

/**
 * Load `source` into `host` with `host.addPlugin` (so the instance joins the
 * active chain) and track it. Dispose the store to remove the instance.
 */
export function createPluginStore<T extends PluginInstance = PluginInstance>(host: AudiospanHost, source: PluginSourceInput, options: AddPluginOptions = {}): PluginStore<T> {
  const listeners = new Set<() => void>();
  let snapshot: PluginSnapshot<T> = { plugin: null, descriptor: null, status: "loading", error: null, values: EMPTY, outputs: EMPTY, bypassed: false, latencyFrames: 0 };
  let disposed = false;
  let instance: T | null = null;
  const unsubscribe: (() => void)[] = [];

  const update = (patch: Partial<PluginSnapshot<T>>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of Array.from(listeners)) listener();
  };
  const readValues = (plugin: T): Record<string, number> => {
    const values: Record<string, number> = {};
    for (const p of plugin.descriptor.parameters) values[p.id] = plugin.getParameter(p.id);
    return values;
  };

  const ready: Promise<T> = host
    .addPlugin<T>(source, options)
    .then((created) => {
      if (disposed) {
        void created.dispose();
        throw new AudiospanErrorClass("DISPOSED", "plugin store disposed while loading");
      }
      instance = created;
      unsubscribe.push(
        created.on("parameterchange", (e) => update({ values: { ...snapshot.values, [e.parameterId]: e.value } })),
        created.on("outputs", (e) => update({ outputs: { ...snapshot.outputs, ...e.values } })),
        created.on("bypasschange", (e) => update({ bypassed: e.bypassed })),
        created.on("latencychange", (e) => update({ latencyFrames: e.latencyFrames })),
        created.on("statechange", () => update({ values: readValues(created) })),
        created.on("statuschange", (e) => {
          if (e.status === "error") update({ status: "error" });
          else if (e.status === "ready") update({ status: "ready" });
          else if (e.status === "disposed") update({ status: "disposed", plugin: null });
        }),
        created.on("error", (e) => update({ error: e.error })),
      );
      update({
        plugin: created,
        descriptor: created.descriptor,
        status: "ready",
        error: null,
        values: readValues(created),
        outputs: { ...created.getOutputs() },
        bypassed: created.isBypassed(),
        latencyFrames: created.latencyFrames,
      });
      return created;
    })
    .catch((error: unknown) => {
      const err = toError(error);
      if (!disposed) update({ status: "error", error: err });
      throw err;
    });
  // Consumers that never call ready() must not see an unhandled rejection.
  ready.catch(() => undefined);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    ready: () => ready,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribe.splice(0)) off();
      const current = instance;
      instance = null;
      update({ status: "disposed", plugin: null });
      listeners.clear();
      if (current && host.status === "ready") await current.dispose().catch(() => undefined);
    },
  };
}
