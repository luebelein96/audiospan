import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError } from "./errors.js";

export interface CppBuildConfig {
  standard: string;
  optimization: string;
  initialMemoryBytes: number;
  stackBytes: number;
  /** Compile with WebAssembly SIMD (`-msimd128`, default true). Supported by every current browser. */
  simd: boolean;
  /** Link-time optimisation (`-flto`, default true). */
  lto: boolean;
  extraFlags: string[];
}

export interface RustBuildConfig {
  crateDir: string;
  profile: "release" | "dev";
  /** Crate name (defaults to the [package] name in Cargo.toml). */
  crateName?: string;
}

export interface ProjectConfig {
  language: "cpp" | "rust";
  manifest: string;
  outDir: string;
  sources: string[];
  includeDirs: string[];
  presetsDir: string | undefined;
  assetsDir: string | undefined;
  uiDir: string | undefined;
  /** Extra copy of the generated TypeScript declarations (relative to the project), e.g. "../app/src/my-plugin.d.ts". */
  typesOut: string | undefined;
  cpp: CppBuildConfig;
  rust: RustBuildConfig;
  /** Absolute project root. */
  root: string;
}

export const CONFIG_FILE = "audiospan.config.json";

const DEFAULT_CPP: CppBuildConfig = { standard: "c++17", optimization: "-O2", initialMemoryBytes: 1024 * 1024, stackBytes: 64 * 1024, simd: true, lto: true, extraFlags: [] };
const DEFAULT_RUST: RustBuildConfig = { crateDir: ".", profile: "release" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown, name: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new CliError(`${CONFIG_FILE}: "${name}" must be an array of strings`, 2);
  return v as string[];
}

export function parseProjectConfig(raw: unknown, root: string): ProjectConfig {
  if (!isRecord(raw)) throw new CliError(`${CONFIG_FILE} must be a JSON object`, 2);
  const language = raw["language"];
  if (language !== "cpp" && language !== "rust") throw new CliError(`${CONFIG_FILE}: "language" must be "cpp" or "rust"`, 2);
  const manifest = typeof raw["manifest"] === "string" ? raw["manifest"] : "plugin.json";
  const outDir = typeof raw["outDir"] === "string" ? raw["outDir"] : "dist";
  const cppRaw = isRecord(raw["cpp"]) ? raw["cpp"] : {};
  const rustRaw = isRecord(raw["rust"]) ? raw["rust"] : {};
  const cpp: CppBuildConfig = {
    standard: typeof cppRaw["standard"] === "string" ? cppRaw["standard"] : DEFAULT_CPP.standard,
    optimization: typeof cppRaw["optimization"] === "string" ? cppRaw["optimization"] : DEFAULT_CPP.optimization,
    initialMemoryBytes: typeof cppRaw["initialMemoryBytes"] === "number" ? cppRaw["initialMemoryBytes"] : DEFAULT_CPP.initialMemoryBytes,
    stackBytes: typeof cppRaw["stackBytes"] === "number" ? cppRaw["stackBytes"] : DEFAULT_CPP.stackBytes,
    simd: typeof cppRaw["simd"] === "boolean" ? cppRaw["simd"] : DEFAULT_CPP.simd,
    lto: typeof cppRaw["lto"] === "boolean" ? cppRaw["lto"] : DEFAULT_CPP.lto,
    extraFlags: stringArray(cppRaw["extraFlags"], "cpp.extraFlags"),
  };
  const rust: RustBuildConfig = {
    crateDir: typeof rustRaw["crateDir"] === "string" ? rustRaw["crateDir"] : DEFAULT_RUST.crateDir,
    profile: rustRaw["profile"] === "dev" ? "dev" : "release",
    ...(typeof rustRaw["crateName"] === "string" ? { crateName: rustRaw["crateName"] } : {}),
  };
  const sources = stringArray(raw["sources"], "sources");
  if (language === "cpp" && sources.length === 0) throw new CliError(`${CONFIG_FILE}: "sources" must list at least one C/C++ file`, 2);
  return {
    language,
    manifest,
    outDir,
    sources,
    includeDirs: stringArray(raw["includeDirs"], "includeDirs"),
    presetsDir: typeof raw["presetsDir"] === "string" ? raw["presetsDir"] : undefined,
    assetsDir: typeof raw["assetsDir"] === "string" ? raw["assetsDir"] : undefined,
    uiDir: typeof raw["uiDir"] === "string" ? raw["uiDir"] : undefined,
    typesOut: typeof raw["typesOut"] === "string" ? raw["typesOut"] : undefined,
    cpp,
    rust,
    root,
  };
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const path = resolve(root, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`no ${CONFIG_FILE} found in ${root}`, 2, "run this command inside a plugin project created with `audiospan create`, or pass --root <dir>");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`, 2);
  }
  return parseProjectConfig(raw, resolve(root));
}
