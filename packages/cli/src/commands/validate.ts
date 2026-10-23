import { parseManifest, validatePreset, type NormalizedPluginManifest, type ValidationIssue } from "@audiospan/manifest";
import { IMPORT_LOG, IMPORT_LOG_MODULE, inspectWasmModule, validateWasmModuleInfo, type WasmModuleInfo } from "@audiospan/runtime";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface ArtifactPolicy {
  maxManifestBytes: number;
  maxModuleBytes: number;
  maxMemoryBytes: number;
  maxPresetBytes: number;
}

export const DEFAULT_ARTIFACT_POLICY: ArtifactPolicy = {
  maxManifestBytes: 256 * 1024,
  maxModuleBytes: 8 * 1024 * 1024,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxPresetBytes: 64 * 1024,
};

export interface ArtifactReport {
  ok: boolean;
  dir: string;
  manifest: NormalizedPluginManifest | undefined;
  module: WasmModuleInfo | undefined;
  /** Artifact-relative paths that make up the package. */
  files: string[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * Validate an artifact directory: manifest, module (exports, imports, memory
 * limits), presets, UI entry, and size policies. Never throws for artifact
 * problems; they are reported as errors/warnings.
 */
export async function validateArtifact(dir: string, policy: Partial<ArtifactPolicy> = {}): Promise<ArtifactReport> {
  const p = { ...DEFAULT_ARTIFACT_POLICY, ...policy };
  const root = resolve(dir);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const files: string[] = [];
  const report = (): ArtifactReport => ({ ok: errors.length === 0, dir: root, manifest, module, files, errors, warnings });
  let manifest: NormalizedPluginManifest | undefined;
  let module: WasmModuleInfo | undefined;

  try {
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    errors.push({ code: "ARTIFACT_DIR_MISSING", path: "", message: `${root} is not a directory` });
    return report();
  }
  const manifestBytes = await readIfExists(resolve(root, "plugin.json"));
  if (!manifestBytes) {
    errors.push({ code: "ARTIFACT_MANIFEST_MISSING", path: "", message: `${root}/plugin.json not found` });
    return report();
  }
  files.push("plugin.json");
  if (manifestBytes.byteLength > p.maxManifestBytes) {
    errors.push({ code: "ARTIFACT_MANIFEST_TOO_LARGE", path: "", message: `plugin.json is ${manifestBytes.byteLength} bytes; policy allows ${p.maxManifestBytes}` });
    return report();
  }
  const parsed = parseManifest(manifestBytes.toString("utf8"), { maxBytes: p.maxManifestBytes, maxMemoryBytes: p.maxMemoryBytes });
  warnings.push(...parsed.warnings);
  if (!parsed.ok) {
    errors.push(...parsed.errors);
    return report();
  }
  manifest = parsed.manifest;

  const moduleBytes = await readIfExists(resolve(root, manifest.entry.wasm));
  if (!moduleBytes) {
    errors.push({ code: "ARTIFACT_MODULE_MISSING", path: "/entry/wasm", message: `${manifest.entry.wasm} not found in ${root}` });
  } else {
    files.push(manifest.entry.wasm);
    if (moduleBytes.byteLength > p.maxModuleBytes) {
      errors.push({ code: "ARTIFACT_MODULE_TOO_LARGE", path: "/entry/wasm", message: `${manifest.entry.wasm} is ${moduleBytes.byteLength} bytes; policy allows ${p.maxModuleBytes}` });
    } else {
      try {
        module = inspectWasmModule(new Uint8Array(moduleBytes));
        // The development-only log import is structurally fine; flag it so a --dev build is not shipped by accident.
        for (const issue of validateWasmModuleInfo(module, { maxMemoryBytes: Math.min(manifest.resources.maxMemoryBytes, p.maxMemoryBytes), allowLogging: true, requireOutputs: manifest.outputs.length > 0 })) {
          errors.push({ code: issue.code, path: "/entry/wasm", message: issue.message });
        }
        if (module.imports.some((i) => i.module === IMPORT_LOG_MODULE && i.name === IMPORT_LOG)) {
          warnings.push({ code: "MODULE_DEV_LOGGING", path: "/entry/wasm", message: `development build: ${manifest.entry.wasm} imports ${IMPORT_LOG_MODULE}.${IMPORT_LOG}; hosts reject it unless pluginLogging is enabled. Rebuild without --dev before distributing.` });
        }
        if (typeof WebAssembly !== "undefined" && !WebAssembly.validate(new Uint8Array(moduleBytes))) {
          errors.push({ code: "MODULE_INVALID", path: "/entry/wasm", message: `${manifest.entry.wasm} failed WebAssembly.validate()` });
        }
      } catch (error) {
        errors.push({ code: "MODULE_INVALID", path: "/entry/wasm", message: `${manifest.entry.wasm} is not a valid WebAssembly binary: ${(error as Error).message}` });
      }
    }
  }

  for (const ref of manifest.presets) {
    const bytes = await readIfExists(resolve(root, ref.path));
    if (!bytes) {
      errors.push({ code: "ARTIFACT_PRESET_MISSING", path: `/presets/${ref.id}`, message: `preset file ${ref.path} not found` });
      continue;
    }
    files.push(ref.path);
    if (bytes.byteLength > p.maxPresetBytes) {
      errors.push({ code: "ARTIFACT_PRESET_TOO_LARGE", path: `/presets/${ref.id}`, message: `${ref.path} is ${bytes.byteLength} bytes; policy allows ${p.maxPresetBytes}` });
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      errors.push({ code: "ARTIFACT_PRESET_INVALID", path: `/presets/${ref.id}`, message: `${ref.path} is not valid JSON: ${(error as Error).message}` });
      continue;
    }
    const result = validatePreset(doc, manifest);
    if (!result.ok) errors.push(...result.errors.map((e) => ({ ...e, path: `/presets/${ref.id}${e.path}` })));
    else warnings.push(...result.warnings.map((w) => ({ ...w, path: `/presets/${ref.id}${w.path}` })));
  }

  if (manifest.ui) {
    const ui = await readIfExists(resolve(root, manifest.ui.entry));
    if (!ui) errors.push({ code: "ARTIFACT_UI_MISSING", path: "/ui/entry", message: `${manifest.ui.entry} not found` });
    else files.push(manifest.ui.entry);
  }

  return report();
}
