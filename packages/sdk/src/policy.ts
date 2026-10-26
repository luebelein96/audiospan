import type { NormalizedPluginManifest } from "@audiospan/manifest";

export type UiMode = "none" | "hosted-ui" | "trusted-custom-ui";

/**
 * Limits the host applies to every plugin it loads. Defaults are conservative
 * and documented at https://luebelein96.github.io/audiospan/security-model/.
 */
export interface PluginPolicy {
  /** Maximum size of plugin.json in bytes. */
  maxManifestBytes: number;
  /** Maximum size of the WASM module in bytes. */
  maxModuleBytes: number;
  /** Maximum linear memory a plugin may declare, in bytes. */
  maxMemoryBytes: number;
  /** Maximum opaque state size in bytes. */
  maxStateBytes: number;
  /** Maximum size of a single preset file in bytes. */
  maxPresetBytes: number;
  /** Maximum number of live plugin instances. */
  maxInstances: number;
  /** UI modes the host is willing to run. v1 only implements "none" (host-generated controls). */
  allowedUiModes: readonly UiMode[];
  /** Origins (e.g. "https://plugins.example.com") from which plugins may be loaded. */
  allowedPluginOrigins: readonly string[];
  /** Allow loading plugins from any origin. Off by default. */
  allowRemotePlugins: boolean;
  /** Application hook for allowlists/blocklists. Return false or a reason string to reject. */
  allowPlugin?: ((manifest: NormalizedPluginManifest, sourceUrl: string) => boolean | string) | undefined;
}

export const DEFAULT_PLUGIN_POLICY: Readonly<PluginPolicy> = Object.freeze({
  maxManifestBytes: 256 * 1024,
  maxModuleBytes: 8 * 1024 * 1024,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxStateBytes: 1024 * 1024,
  maxPresetBytes: 64 * 1024,
  maxInstances: 8,
  allowedUiModes: Object.freeze(["none"]) as readonly UiMode[],
  allowedPluginOrigins: Object.freeze([]) as readonly string[],
  allowRemotePlugins: false,
  allowPlugin: undefined,
});

export function resolvePolicy(overrides: Partial<PluginPolicy> | undefined): PluginPolicy {
  const policy: PluginPolicy = { ...DEFAULT_PLUGIN_POLICY, ...(overrides ?? {}) };
  for (const key of ["maxManifestBytes", "maxModuleBytes", "maxMemoryBytes", "maxStateBytes", "maxPresetBytes", "maxInstances"] as const) {
    const v = policy[key];
    if (!Number.isInteger(v) || v <= 0) throw new TypeError(`pluginPolicy.${key} must be a positive integer`);
  }
  return policy;
}

/**
 * Decide whether a plugin URL may be loaded under the policy. Returns a reason
 * string when denied.
 *
 * `pageOrigin` is the page's origin as the browser reports it, including the
 * opaque `"null"` of file:// and sandboxed pages, which only matches other
 * opaque URLs. `undefined` means there is no page at all (Node, workers
 * without a location); such hosts are allowed any origin unless an allowlist
 * is configured.
 */
export function checkOriginPolicy(url: URL, policy: PluginPolicy, pageOrigin: string | undefined): string | undefined {
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "blob:" && url.protocol !== "file:") {
    return `plugin URLs must use http(s), blob: or file:; got ${url.protocol}`;
  }
  if (policy.allowRemotePlugins) return undefined;
  if (pageOrigin !== undefined && url.origin === pageOrigin) return undefined;
  if (policy.allowedPluginOrigins.includes(url.origin)) return undefined;
  if (pageOrigin === undefined && policy.allowedPluginOrigins.length === 0) return undefined; // non-browser host with no origin
  return `plugin origin ${url.origin} is not allowed; add it to pluginPolicy.allowedPluginOrigins or set allowRemotePlugins`;
}
