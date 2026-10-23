import { AudiospanError } from "./errors.js";
import type { HostInternals } from "./internal.js";
import type { PluginInstanceImpl } from "./instance.js";
import type { AudioChain, PluginInstance } from "./types.js";

let chainCounter = 0;

function toChainError(error: unknown): AudiospanError {
  return error instanceof AudiospanError ? error : new AudiospanError("CHAIN_ERROR", `chain update failed: ${(error as Error).message}`, { cause: error });
}

export class AudioChainImpl implements AudioChain {
  readonly id: string;
  private readonly host: HostInternals;
  private plugins: PluginInstanceImpl[] = [];
  private active = false;
  private disposed = false;
  /** Commits are serialised so the runtime always ends on the latest order. Never rejects. */
  private pending: Promise<void> = Promise.resolve();
  private readonly isOwnInstance: (plugin: PluginInstance) => plugin is PluginInstanceImpl;

  constructor(host: HostInternals, isOwnInstance: (plugin: PluginInstance) => plugin is PluginInstanceImpl) {
    this.host = host;
    this.isOwnInstance = isOwnInstance;
    this.id = `chain-${++chainCounter}`;
  }

  /** @internal */
  get isActive(): boolean {
    return this.active;
  }

  /** @internal Make this the chain the runtime processes. Rejects if the runtime refuses it. */
  async activate(): Promise<void> {
    this.assertLive();
    this.active = true;
    await this.commit();
  }

  /** @internal */
  deactivate(): void {
    this.active = false;
  }

  private assertLive(): void {
    if (this.disposed) throw new AudiospanError("DISPOSED", `chain ${this.id} has been disposed`);
  }

  /** Send the current order after any earlier commit has settled. Rejects if the runtime refuses it. */
  private commit(): Promise<void> {
    if (!this.active) return Promise.resolve();
    const ids = this.plugins.map((p) => p.id);
    const run = () => this.host.connection.request({ type: "REPLACE_CHAIN", requestId: this.host.connection.nextRequestId(), instanceIds: ids }, ["ACK"]).then(() => undefined);
    const next = this.pending.then(run, run);
    this.pending = next.catch(() => undefined);
    return next;
  }

  /** Edits made through the synchronous API surface failures as host errors. */
  private commitInBackground(): void {
    this.commit().catch((error: unknown) => this.host.reportError(toChainError(error)));
  }

  add(plugin: PluginInstance, index?: number): void {
    this.assertLive();
    if (!this.isOwnInstance(plugin)) throw new AudiospanError("CHAIN_ERROR", "plugin was not created by this host");
    if (plugin.status === "disposed") throw new AudiospanError("DISPOSED", `plugin instance ${plugin.id} has been disposed`, { instanceId: plugin.id });
    if (this.plugins.includes(plugin)) throw new AudiospanError("CHAIN_ERROR", `plugin instance ${plugin.id} is already in chain ${this.id}`, { instanceId: plugin.id });
    const at = index === undefined ? this.plugins.length : Math.max(0, Math.min(this.plugins.length, Math.floor(index)));
    this.plugins = [...this.plugins.slice(0, at), plugin, ...this.plugins.slice(at)];
    this.commitInBackground();
  }

  remove(pluginId: string): void {
    this.assertLive();
    const before = this.plugins.length;
    this.plugins = this.plugins.filter((p) => p.id !== pluginId);
    if (this.plugins.length === before) throw new AudiospanError("CHAIN_ERROR", `plugin instance ${pluginId} is not in chain ${this.id}`, { instanceId: pluginId });
    this.commitInBackground();
  }

  move(pluginId: string, index: number): void {
    this.assertLive();
    const from = this.plugins.findIndex((p) => p.id === pluginId);
    if (from < 0) throw new AudiospanError("CHAIN_ERROR", `plugin instance ${pluginId} is not in chain ${this.id}`, { instanceId: pluginId });
    const to = Math.max(0, Math.min(this.plugins.length - 1, Math.floor(index)));
    if (from === to) return;
    const next = this.plugins.slice();
    const [plugin] = next.splice(from, 1);
    next.splice(to, 0, plugin!);
    this.plugins = next;
    this.commitInBackground();
  }

  getPlugins(): readonly PluginInstance[] {
    return this.plugins.slice();
  }

  /** @internal */
  dropInstance(instanceId: string): void {
    if (this.disposed) return;
    const before = this.plugins.length;
    this.plugins = this.plugins.filter((p) => p.id !== instanceId);
    if (this.plugins.length !== before) this.commitInBackground();
  }

  flush(): Promise<void> {
    return this.pending;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.plugins = [];
    this.host.onChainDisposed(this.id);
    if (this.active) {
      await this.commit().catch((error: unknown) => this.host.reportError(toChainError(error)));
      this.active = false;
    }
  }

  /** @internal */
  markDisposed(): void {
    this.disposed = true;
    this.active = false;
    this.plugins = [];
  }
}
