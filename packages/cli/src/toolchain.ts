import { spawn } from "node:child_process";

export interface ToolInfo {
  name: string;
  available: boolean;
  version: string | undefined;
  path: string | undefined;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(command: string, args: readonly string[], options: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; inherit?: boolean | undefined } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function probe(name: string, args: readonly string[], parse: (out: string) => string | undefined): Promise<ToolInfo> {
  try {
    const result = await run(name, args);
    if (result.code !== 0) return { name, available: false, version: undefined, path: undefined };
    return { name, available: true, version: parse(result.stdout + result.stderr), path: name };
  } catch {
    return { name, available: false, version: undefined, path: undefined };
  }
}

export const MIN_EMCC_VERSION = "3.1.50";
export const MIN_RUST_VERSION = "1.80.0";

export function detectEmcc(): Promise<ToolInfo> {
  return probe("emcc", ["--version"], (out) => /emcc[^0-9]*([0-9]+\.[0-9]+\.[0-9]+)/.exec(out)?.[1]);
}

export function detectCargo(): Promise<ToolInfo> {
  return probe("cargo", ["--version"], (out) => /cargo ([0-9]+\.[0-9]+\.[0-9]+)/.exec(out)?.[1]);
}

export async function detectRustWasmTarget(): Promise<boolean> {
  try {
    const result = await run("rustup", ["target", "list", "--installed"]);
    return result.code === 0 && result.stdout.includes("wasm32-unknown-unknown");
  } catch {
    return false;
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
