export type Unsubscribe = () => void;

/** Minimal typed event emitter. Listener errors are isolated and reported. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();
  private readonly onListenerError: ((error: unknown) => void) | undefined;

  constructor(onListenerError?: (error: unknown) => void) {
    this.onListenerError = onListenerError;
  }

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set?.delete(listener as (payload: never) => void);
    };
  }

  once<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of Array.from(set)) {
      try {
        (listener as (payload: Events[K]) => void)(payload);
      } catch (error) {
        if (this.onListenerError) this.onListenerError(error);
        else throw error;
      }
    }
  }

  listenerCount(event?: keyof Events): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  clear(): void {
    this.listeners.clear();
  }
}
