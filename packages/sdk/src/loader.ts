import {
  parseManifest,
  resolveArtifactUrl,
  validateManifest,
  validatePreset,
  type ManifestPolicy,
  type NormalizedPluginManifest,
  type PresetDescriptor,
  type PresetReference,
  type ValidationIssue,
} from "@audiospan/manifest";
import { inspectWasmModule, validateWasmModuleInfo, type WasmModuleInfo } from "@audiospan/runtime";
import { AudiospanError } from "./errors.js";
import { checkOriginPolicy, type PluginPolicy } from "./policy.js";

/** An artifact supplied directly instead of fetched: useful for bundled or locally built plugins. */
export interface PluginSource {
  /** plugin.json as a parsed object or JSON text. */
  manifest: unknown;
  moduleBytes: ArrayBuffer | Uint8Array;
  /** Identifier reported in descriptors and diagnostics. Defaults to `inline:<id>`. */
  sourceUrl?: string;
  /** Preset documents keyed by their manifest path (e.g. "presets/default.json"). */
  presets?: Record<string, unknown>;
}

export type PluginSourceInput = string | URL | PluginSource;

export interface LoadedArtifact {
  manifest: NormalizedPluginManifest;
  moduleBytes: Uint8Array<ArrayBuffer>;
  moduleInfo: WasmModuleInfo;
  presets: PresetDescriptor[];
  warnings: ValidationIssue[];
  sourceUrl: string;
}

export interface LoaderOptions {
  policy: PluginPolicy;
  manifestPolicy: ManifestPolicy;
  fetch: typeof fetch;
  /** The page's origin (`"null"` for opaque origins such as file://); undefined when there is no page. */
  pageOrigin: string | undefined;
  /** Accept modules that import the development-only `env.audiospan_log` (host option `pluginLogging`). */
  allowLogging: boolean;
  signal?: AbortSignal;
}

// A module using i8x16.popcnt: validates only where WebAssembly SIMD is supported.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
let simdSupport: boolean | undefined;

/** Whether this engine accepts WebAssembly SIMD (v128) modules, which Audiospan builds use by default. Cached. */
export function wasmSimdSupported(): boolean {
  if (simdSupport === undefined) {
    try {
      simdSupport = typeof WebAssembly !== "undefined" && WebAssembly.validate(SIMD_PROBE);
    } catch {
      simdSupport = false;
    }
  }
  return simdSupport;
}

/** Appended to validation failures so a missing SIMD engine is not mistaken for a corrupt file. */
export function simdHint(): string {
  return wasmSimdSupported()
    ? ""
    : "; this browser does not support WebAssembly SIMD, which Audiospan builds enable by default (set cpp.simd to false in audiospan.config.json, or drop target-feature=+simd128 for Rust, to build without it)";
}

/** Throws ABORTED once the signal has fired. */
export function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted) throw new AudiospanError("ABORTED", `${what} was aborted`, { cause: signal.reason });
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * Fetch a resource of at most `maxBytes`. The body is read incrementally so
 * a server that under-reports Content-Length cannot make the host download
 * more than the policy allows: the download is abandoned at the limit.
 */
async function fetchWithLimit(
  fetchFn: typeof fetch,
  url: URL,
  maxBytes: number,
  what: string,
  code: "MANIFEST_FETCH_FAILED" | "MODULE_FETCH_FAILED",
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  throwIfAborted(signal, `fetching ${what}`);
  const aborted = (cause: unknown) => new AudiospanError("ABORTED", `fetching ${what} from ${url.href} was aborted`, { cause });
  const tooLarge = (size: number) => new AudiospanError("POLICY_VIOLATION", `${what} at ${url.href} is at least ${size} bytes; policy allows ${maxBytes}`);
  let response: Response;
  try {
    response = await fetchFn(url.href, { credentials: "same-origin", redirect: "error", ...(signal ? { signal } : {}) });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw aborted(error);
    throw new AudiospanError(code, `failed to fetch ${what} from ${url.href}: ${(error as Error).message}. Check that the file exists, that CORS allows it, and that the server does not redirect.`, { cause: error });
  }
  if (!response.ok) {
    throw new AudiospanError(code, `failed to fetch ${what} from ${url.href}: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw tooLarge(declared);

  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw tooLarge(buffer.byteLength);
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(received);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AudiospanError) throw error;
    if (isAbortError(error) || signal?.aborted) throw aborted(error);
    throw new AudiospanError(code, `failed to read ${what} from ${url.href}: ${(error as Error).message}`, { cause: error });
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function toManifestResult(result: ReturnType<typeof validateManifest>, sourceUrl: string): { manifest: NormalizedPluginManifest; warnings: ValidationIssue[] } {
  if (!result.ok) {
    const summary = result.errors.map((e) => `${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}`).join("; ");
    throw new AudiospanError("MANIFEST_INVALID", `plugin manifest ${sourceUrl} is invalid: ${summary}`, { issues: result.errors });
  }
  return { manifest: result.manifest, warnings: result.warnings };
}

function validateModuleBytes(bytes: Uint8Array<ArrayBuffer>, manifest: NormalizedPluginManifest, policy: PluginPolicy, sourceUrl: string, allowLogging: boolean): WasmModuleInfo {
  if (bytes.byteLength > policy.maxModuleBytes) {
    throw new AudiospanError("POLICY_VIOLATION", `module for ${manifest.id} is ${bytes.byteLength} bytes; policy allows ${policy.maxModuleBytes}`);
  }
  let info: WasmModuleInfo;
  try {
    info = inspectWasmModule(bytes);
  } catch (error) {
    throw new AudiospanError("MODULE_INVALID", `module for ${manifest.id} (${sourceUrl}) is not a valid WebAssembly binary: ${(error as Error).message}. If it was served over HTTP, verify the file is the .wasm artifact and not an HTML error page.`, { cause: error });
  }
  const issues = validateWasmModuleInfo(info, { maxMemoryBytes: Math.min(manifest.resources.maxMemoryBytes, policy.maxMemoryBytes), allowLogging, requireOutputs: manifest.outputs.length > 0 });
  if (issues.length > 0) {
    throw new AudiospanError("MODULE_INVALID", `module for ${manifest.id} is not a usable Audiospan ABI module: ${issues.map((i) => i.message).join("; ")}`);
  }
  return info;
}

function collectPresets(manifest: NormalizedPluginManifest, documents: { path: string; document: unknown }[], warnings: ValidationIssue[]): PresetDescriptor[] {
  const presets: PresetDescriptor[] = [];
  for (const ref of manifest.presets) {
    const entry = documents.find((d) => d.path === ref.path);
    if (!entry) {
      warnings.push({ code: "PRESET_MISSING", path: `/presets/${ref.id}`, message: `preset file ${ref.path} was not provided` });
      continue;
    }
    const result = validatePreset(entry.document, manifest);
    if (!result.ok) {
      warnings.push(...result.errors.map((e) => ({ ...e, path: `/presets/${ref.id}${e.path}` })));
      continue;
    }
    warnings.push(...result.warnings.map((w) => ({ ...w, path: `/presets/${ref.id}${w.path}` })));
    presets.push({ ...result.preset, id: ref.id, name: result.preset.name || ref.name });
  }
  return presets;
}

export async function loadArtifact(input: PluginSourceInput, options: LoaderOptions): Promise<LoadedArtifact> {
  if (typeof input === "string" || input instanceof URL) return loadFromUrl(input, options);
  return loadInline(input, options);
}

async function loadInline(source: PluginSource, options: LoaderOptions): Promise<LoadedArtifact> {
  throwIfAborted(options.signal, "loading the plugin");
  const text = typeof source.manifest === "string" ? source.manifest : undefined;
  const sourceUrlHint = source.sourceUrl ?? "inline";
  const result = text !== undefined ? parseManifest(text, { ...options.manifestPolicy, maxBytes: options.policy.maxManifestBytes }) : validateManifest(source.manifest, options.manifestPolicy);
  const { manifest, warnings } = toManifestResult(result, sourceUrlHint);
  const sourceUrl = source.sourceUrl ?? `inline:${manifest.id}`;
  applyAllowHook(manifest, sourceUrl, options.policy);
  const moduleBytes = new Uint8Array(source.moduleBytes instanceof Uint8Array ? source.moduleBytes : new Uint8Array(source.moduleBytes));
  const moduleInfo = validateModuleBytes(moduleBytes, manifest, options.policy, sourceUrl, options.allowLogging);
  const documents = Object.entries(source.presets ?? {}).map(([path, document]) => ({ path, document }));
  const presets = manifest.capabilities.presets ? collectPresets(manifest, documents, warnings) : [];
  return { manifest, moduleBytes, moduleInfo, presets, warnings, sourceUrl };
}

function applyAllowHook(manifest: NormalizedPluginManifest, sourceUrl: string, policy: PluginPolicy): void {
  if (!policy.allowPlugin) return;
  const verdict = policy.allowPlugin(manifest, sourceUrl);
  if (verdict === true) return;
  throw new AudiospanError("POLICY_VIOLATION", `plugin ${manifest.id} rejected by host policy${typeof verdict === "string" ? `: ${verdict}` : ""}`, { pluginId: manifest.id });
}

type PresetFetch = { ref: PresetReference; document: unknown } | { ref: PresetReference; error: Error };

async function loadFromUrl(input: string | URL, options: LoaderOptions): Promise<LoadedArtifact> {
  const { signal } = options;
  let manifestUrl: URL;
  try {
    manifestUrl = input instanceof URL ? input : new URL(input, typeof globalThis.location !== "undefined" ? globalThis.location.href : undefined);
  } catch (error) {
    throw new AudiospanError("MANIFEST_FETCH_FAILED", `invalid plugin URL ${JSON.stringify(String(input))}: ${(error as Error).message}`, { cause: error });
  }
  const denied = checkOriginPolicy(manifestUrl, options.policy, options.pageOrigin);
  if (denied) throw new AudiospanError("POLICY_VIOLATION", denied);

  const manifestBuffer = await fetchWithLimit(options.fetch, manifestUrl, options.policy.maxManifestBytes, "plugin manifest", "MANIFEST_FETCH_FAILED", signal);
  const manifestText = new TextDecoder().decode(manifestBuffer);
  const { manifest, warnings } = toManifestResult(parseManifest(manifestText, { ...options.manifestPolicy, maxBytes: options.policy.maxManifestBytes }), manifestUrl.href);
  applyAllowHook(manifest, manifestUrl.href, options.policy);

  const moduleUrl = resolveArtifactUrl(manifestUrl, manifest.entry.wasm);
  const moduleBuffer = await fetchWithLimit(options.fetch, moduleUrl, options.policy.maxModuleBytes, "plugin module", "MODULE_FETCH_FAILED", signal);
  const moduleBytes = new Uint8Array(moduleBuffer);
  const moduleInfo = validateModuleBytes(moduleBytes, manifest, options.policy, moduleUrl.href, options.allowLogging);

  const documents: { path: string; document: unknown }[] = [];
  if (manifest.capabilities.presets) {
    // Presets are independent files: fetch them concurrently, report in manifest order.
    const results: PresetFetch[] = await Promise.all(
      manifest.presets.map(async (ref): Promise<PresetFetch> => {
        try {
          const url = resolveArtifactUrl(manifestUrl, ref.path);
          const buffer = await fetchWithLimit(options.fetch, url, options.policy.maxPresetBytes, `preset ${ref.id}`, "MANIFEST_FETCH_FAILED", signal);
          return { ref, document: JSON.parse(new TextDecoder().decode(buffer)) as unknown };
        } catch (error) {
          if (AudiospanError.is(error, "ABORTED")) throw error;
          return { ref, error: error as Error };
        }
      }),
    );
    for (const result of results) {
      if ("error" in result) warnings.push({ code: "PRESET_LOAD_FAILED", path: `/presets/${result.ref.id}`, message: result.error.message });
      else documents.push({ path: result.ref.path, document: result.document });
    }
  }
  const presets = manifest.capabilities.presets ? collectPresets(manifest, documents, warnings) : [];
  return { manifest, moduleBytes, moduleInfo, presets, warnings, sourceUrl: manifestUrl.href };
}
