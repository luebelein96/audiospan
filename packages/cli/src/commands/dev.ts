import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectConfig, type ProjectConfig } from "../config.js";
import { resolvePackageFile, startDevServer, type DevServer } from "../server.js";
import { buildPlugin } from "./build.js";

export interface DevOptions {
  /** Directory served at `/` (default: the project root). */
  root: string;
  port?: number;
  host?: string;
  /** Path (relative to root) of the plugin manifest the demo should load. */
  pluginPath?: string;
  /** Print the demo URL for this page instead of the built-in demo. */
  openPath?: string;
  /** Rebuild the project (audiospan.config.json in `root`) whenever a source file changes; the sandbox reloads the module. */
  watch?: boolean;
  /** Development builds (plugin logging compiled in) when watching. */
  dev?: boolean;
  log?: ((line: string) => void) | undefined;
}

export interface DevResult {
  server: DevServer;
  demoUrl: string;
  /** Present with `watch`: stop watching. */
  watcher?: { close(): void };
}

const WATCH_IGNORE = new Set(["node_modules", "target", "generated", ".git"]);

/**
 * Rebuild on change. Edits are debounced, builds never overlap (a change
 * during a build queues one more), and failures are logged, not thrown, so a
 * typo does not stop the server.
 */
export function watchAndBuild(config: ProjectConfig, options: { dev: boolean; log: (line: string) => void }): { close(): void } {
  const ignore = new Set([...WATCH_IGNORE, config.outDir]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let building = false;
  let dirty = false;
  let changed: string | undefined;
  const run = async () => {
    if (building) {
      dirty = true;
      return;
    }
    building = true;
    try {
      options.log(`rebuilding (${changed ?? "change detected"})`);
      const result = await buildPlugin(config, { dev: options.dev, log: () => {} });
      options.log(`rebuilt ${result.modulePath}${result.report?.warnings.length ? ` with ${result.report.warnings.length} warning(s)` : ""}`);
    } catch (error) {
      options.log(`build failed: ${(error as Error).message}`);
    } finally {
      building = false;
      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 250);
  };
  const watcher: FSWatcher = watch(config.root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const top = String(filename).split(/[\\/]/)[0] ?? "";
    if (ignore.has(top)) return;
    changed = String(filename);
    schedule();
  });
  return {
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

const DEMO_DIR = fileURLToPath(new URL("../../demo/", import.meta.url));

/** Virtual routes that expose the SDK, UI, worklet and demo page under /__audiospan/. */
export function audiospanVirtualFiles(): Record<string, string> {
  return {
    "/__audiospan/sdk.js": resolvePackageFile("@audiospan/sdk/bundle"),
    "/__audiospan/sdk.js.map": `${resolvePackageFile("@audiospan/sdk/bundle")}.map`,
    "/__audiospan/ui.js": resolvePackageFile("@audiospan/ui/bundle"),
    "/__audiospan/worklet.js": resolvePackageFile("@audiospan/runtime/worklet"),
    "/__audiospan/demo/": resolve(DEMO_DIR, "index.html"),
    "/__audiospan/demo/index.html": resolve(DEMO_DIR, "index.html"),
    "/__audiospan/demo/demo.js": resolve(DEMO_DIR, "demo.js"),
    "/__audiospan/demo/demo.css": resolve(DEMO_DIR, "demo.css"),
  };
}

export async function startDev(options: DevOptions): Promise<DevResult> {
  const server = await startDevServer({ root: options.root, port: options.port ?? 8787, host: options.host ?? "127.0.0.1", virtualFiles: audiospanVirtualFiles(), log: options.log });
  const plugin = options.pluginPath ?? "dist/plugin.json";
  const demoUrl = options.openPath ? new URL(options.openPath, server.url).href : `${server.url}__audiospan/demo/?plugin=${encodeURIComponent("/" + plugin.replace(/^\/+/, ""))}`;
  if (!options.watch) return { server, demoUrl };
  const config = await loadProjectConfig(options.root);
  const log = options.log ?? (() => {});
  const watcher = watchAndBuild(config, { dev: options.dev ?? false, log });
  return { server, demoUrl, watcher };
}
