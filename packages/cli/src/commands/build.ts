import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatIssues, parseManifest, type NormalizedPluginManifest } from "@audiospan/manifest";
import type { ProjectConfig } from "../config.js";
import { CliError } from "../errors.js";
import { GENERATED_DIR, writeBindings, writeTypes } from "../generate.js";
import { MIN_EMCC_VERSION, MIN_RUST_VERSION, compareVersions, detectCargo, detectEmcc, detectRustWasmTarget, run } from "../toolchain.js";
import { validateArtifact, type ArtifactReport } from "./validate.js";

export interface BuildOptions {
  /** Print the toolchain command and stream its output. */
  verbose?: boolean;
  /** Skip artifact validation after the build. */
  validate?: boolean;
  /**
   * Development build: define AUDIOSPAN_ENABLE_LOG (C++) or enable the
   * `audiospan-log` cargo feature (Rust) so the plugin's log calls reach a host
   * that has `pluginLogging` on. The module then imports `env.audiospan_log`,
   * which production hosts reject.
   */
  dev?: boolean;
  log?: (line: string) => void;
}

export interface BuildResult {
  outDir: string;
  modulePath: string;
  command: string[];
  report: ArtifactReport | undefined;
  /** Language bindings regenerated from plugin.json before compiling. */
  generated: string[];
  /** TypeScript declaration files written (dist/plugin.d.ts and `typesOut`). */
  types: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function roundUpPages(bytes: number): number {
  return Math.ceil(bytes / 65536) * 65536;
}

/** Read and validate the project's plugin.json. Build-time generation needs the normalized form. */
export async function loadManifest(config: ProjectConfig): Promise<NormalizedPluginManifest> {
  const text = await readFile(resolve(config.root, config.manifest), "utf8").catch(() => {
    throw new CliError(`manifest ${config.manifest} not found in ${config.root}`, 2);
  });
  const result = parseManifest(text);
  if (!result.ok) {
    throw new CliError(`${config.manifest} is invalid:\n${formatIssues(result.errors)}`, 3, "fix plugin.json; `audiospan validate` reports the same issues with paths");
  }
  return result.manifest;
}

export function emccCommand(config: ProjectConfig, maxMemoryBytes: number, outFile: string, dev = false): string[] {
  const initial = roundUpPages(Math.min(config.cpp.initialMemoryBytes, maxMemoryBytes));
  const maximum = roundUpPages(maxMemoryBytes);
  return [
    "emcc",
    ...config.sources,
    ...config.includeDirs.map((d) => `-I${d}`),
    `-I${GENERATED_DIR}`,
    config.cpp.optimization,
    `-std=${config.cpp.standard}`,
    "-fno-exceptions",
    "-fno-rtti",
    ...(config.cpp.simd ? ["-msimd128"] : []),
    ...(config.cpp.lto ? ["-flto"] : []),
    ...(dev ? ["-DAUDIOSPAN_ENABLE_LOG=1"] : []),
    "-sSTANDALONE_WASM=1",
    "--no-entry",
    `-sINITIAL_MEMORY=${initial}`,
    `-sMAXIMUM_MEMORY=${maximum}`,
    "-sALLOW_MEMORY_GROWTH=1",
    `-sSTACK_SIZE=${config.cpp.stackBytes}`,
    ...config.cpp.extraFlags,
    "-o",
    outFile,
  ];
}

async function crateName(config: ProjectConfig): Promise<string> {
  if (config.rust.crateName) return config.rust.crateName;
  const cargo = await readFile(resolve(config.root, config.rust.crateDir, "Cargo.toml"), "utf8").catch(() => {
    throw new CliError(`Cargo.toml not found in ${resolve(config.root, config.rust.crateDir)}`, 2);
  });
  const match = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo);
  if (!match) throw new CliError("could not read the package name from Cargo.toml; set rust.crateName in audiospan.config.json", 2);
  return match[1]!;
}

export async function buildPlugin(config: ProjectConfig, options: BuildOptions = {}): Promise<BuildResult> {
  const log = options.log ?? (() => {});
  const outDir = resolve(config.root, config.outDir);
  await mkdir(outDir, { recursive: true });
  const modulePath = resolve(outDir, "module.wasm");
  const manifest = await loadManifest(config);
  const maxMemoryBytes = manifest.resources.maxMemoryBytes;
  // Indices, ranges and defaults are declared once, in plugin.json; the compiled code reads them from here.
  const generated = await writeBindings(config.root, config.language, manifest);
  let command: string[];

  if (config.language === "cpp") {
    const emcc = await detectEmcc();
    if (!emcc.available) {
      throw new CliError("emcc (Emscripten) was not found on PATH", 4, "install the Emscripten SDK (https://emscripten.org) and run `source emsdk_env.sh` before building");
    }
    if (emcc.version && compareVersions(emcc.version, MIN_EMCC_VERSION) < 0) {
      log(`warning: emcc ${emcc.version} is older than the tested minimum ${MIN_EMCC_VERSION}`);
    }
    for (const source of config.sources) {
      if (!(await exists(resolve(config.root, source)))) throw new CliError(`source file ${source} not found`, 2);
    }
    command = emccCommand(config, maxMemoryBytes, modulePath, options.dev ?? false);
    log(`$ ${command.join(" ")}`);
    const result = await run(command[0]!, command.slice(1), { cwd: config.root, inherit: options.verbose });
    if (result.code !== 0) {
      throw new CliError(`emcc failed with exit code ${result.code}\n${result.stderr || result.stdout}`.trim(), 4, "fix the compiler errors above; the exact command is printed before the output");
    }
  } else {
    const cargo = await detectCargo();
    if (!cargo.available) {
      throw new CliError("cargo was not found on PATH", 4, "install Rust from https://rustup.rs and add the wasm target: rustup target add wasm32-unknown-unknown");
    }
    if (cargo.version && compareVersions(cargo.version, MIN_RUST_VERSION) < 0) {
      log(`warning: cargo ${cargo.version} is older than the tested minimum ${MIN_RUST_VERSION}`);
    }
    if (!(await detectRustWasmTarget())) {
      log("warning: rustup does not report the wasm32-unknown-unknown target; run `rustup target add wasm32-unknown-unknown` if the build fails");
    }
    const crateDir = resolve(config.root, config.rust.crateDir);
    const name = await crateName(config);
    command = ["cargo", "build", "--target", "wasm32-unknown-unknown", ...(config.rust.profile === "release" ? ["--release"] : []), ...(options.dev ? ["--features", "audiospan-log"] : [])];
    log(`$ (cd ${crateDir} && ${command.join(" ")})`);
    const result = await run(command[0]!, command.slice(1), { cwd: crateDir, inherit: options.verbose });
    if (result.code !== 0) {
      throw new CliError(`cargo failed with exit code ${result.code}\n${result.stderr || result.stdout}`.trim(), 4, "fix the compiler errors above");
    }
    const built = resolve(crateDir, "target", "wasm32-unknown-unknown", config.rust.profile === "release" ? "release" : "debug", `${name.replace(/-/g, "_")}.wasm`);
    if (!(await exists(built))) throw new CliError(`expected cargo output ${built} was not produced; is the crate a cdylib named "${name}"?`, 4);
    await cp(built, modulePath);
  }

  // Assemble the artifact: manifest, presets, assets, ui.
  const manifestSource = resolve(config.root, config.manifest);
  await writeFile(resolve(outDir, "plugin.json"), await readFile(manifestSource));
  for (const [dir, name] of [
    [config.presetsDir, "presets"],
    [config.assetsDir, "assets"],
    [config.uiDir, "ui"],
  ] as const) {
    if (!dir) continue;
    const from = resolve(config.root, dir);
    const to = resolve(outDir, name);
    if (await exists(from)) {
      await rm(to, { recursive: true, force: true });
      await cp(from, to, { recursive: true });
    }
  }

  // Typed ids for the host application: next to the artifact, plus wherever the project points `typesOut`.
  const types = [await writeTypes(resolve(outDir, "plugin.d.ts"), manifest)];
  if (config.typesOut) types.push(await writeTypes(resolve(config.root, config.typesOut), manifest));

  let report: ArtifactReport | undefined;
  if (options.validate !== false) {
    report = await validateArtifact(outDir);
    if (!report.ok) {
      const lines = report.errors.map((e) => `  ${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}`).join("\n");
      throw new CliError(`built artifact failed validation:\n${lines}`, 3);
    }
  }
  return { outDir, modulePath, command, report, generated, types };
}
