import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createTarGz, sha256, type TarEntry } from "../tar.js";
import { CliError } from "../errors.js";
import { validateArtifact } from "./validate.js";

export const PACKAGE_FORMAT_VERSION = 1;

export interface PackOptions {
  /** Directory to write the archive into (default: the artifact dir's parent). */
  outDir?: string;
  /** Include a `source/` tree (default false). */
  includeSource?: { dir: string } | undefined;
  /** Identifier recorded as the packaging tool. */
  createdWith?: string;
}

export interface PackResult {
  archivePath: string;
  checksumPath: string;
  sha256: string;
  files: { path: string; bytes: number; sha256: string }[];
  bytes: number;
}

async function listRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listRecursive(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

/**
 * Package a validated artifact directory into a deterministic
 * `<id>-<version>.audiospan.tar.gz` with an embedded `audiospan-package.json`
 * (format version, file list, SHA-256 per file) and a sidecar `.sha256`.
 */
export async function packArtifact(artifactDir: string, options: PackOptions = {}): Promise<PackResult> {
  const root = resolve(artifactDir);
  const report = await validateArtifact(root);
  if (!report.ok || !report.manifest) {
    const lines = report.errors.map((e) => `  ${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}`).join("\n");
    throw new CliError(`cannot pack: artifact failed validation:\n${lines}`, 3);
  }
  const manifest = report.manifest;
  const include = new Set<string>(report.files);
  // Approved optional directories: assets/ and ui/ (ui only if custom UI is declared).
  for (const sub of ["assets", ...(manifest.capabilities.customUI ? ["ui"] : [])]) {
    const dir = resolve(root, sub);
    try {
      if ((await stat(dir)).isDirectory()) for (const f of await listRecursive(dir)) include.add(relative(root, f).split("\\").join("/"));
    } catch {
      // optional
    }
  }
  const entries: TarEntry[] = [];
  const files: PackResult["files"] = [];
  let assetBytes = 0;
  for (const path of [...include].sort()) {
    const data = new Uint8Array(await readFile(resolve(root, path)));
    if (path.startsWith("assets/")) assetBytes += data.byteLength;
    entries.push({ path, data });
    files.push({ path, bytes: data.byteLength, sha256: sha256(data) });
  }
  if (assetBytes > manifest.resources.maxAssetBytes) {
    throw new CliError(`assets/ totals ${assetBytes} bytes but plugin.json allows ${manifest.resources.maxAssetBytes}`, 3);
  }
  if (options.includeSource) {
    const srcRoot = resolve(options.includeSource.dir);
    for (const f of await listRecursive(srcRoot)) {
      const rel = relative(srcRoot, f).split("\\").join("/");
      if (rel.startsWith("dist/") || rel.startsWith("target/") || rel.startsWith("node_modules/") || rel.startsWith(".git/")) continue;
      const data = new Uint8Array(await readFile(f));
      entries.push({ path: `source/${rel}`, data });
      files.push({ path: `source/${rel}`, bytes: data.byteLength, sha256: sha256(data) });
    }
  }
  const packageInfo = {
    formatVersion: PACKAGE_FORMAT_VERSION,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    abi: manifest.entry.abi,
    manifestSchemaVersion: manifest.schemaVersion,
    createdWith: options.createdWith ?? "@audiospan/cli",
    files,
  };
  const infoBytes = new TextEncoder().encode(JSON.stringify(packageInfo, null, 2) + "\n");
  entries.push({ path: "audiospan-package.json", data: infoBytes });
  const checksums = files.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n";
  entries.push({ path: "checksums.sha256", data: new TextEncoder().encode(checksums) });

  const archive = createTarGz(entries);
  const outDir = resolve(options.outDir ?? resolve(root, ".."));
  await mkdir(outDir, { recursive: true });
  const base = `${manifest.id}-${manifest.version}.audiospan.tar.gz`;
  const archivePath = resolve(outDir, base);
  const digest = sha256(archive);
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(archivePath, archive);
  await writeFile(checksumPath, `${digest}  ${base}\n`);
  return { archivePath, checksumPath, sha256: digest, files, bytes: archive.byteLength };
}
