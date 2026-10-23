import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { NormalizedPluginManifest } from "@audiospan/manifest";
import { CliError } from "../errors.js";
import { typePrefix, writeTypes } from "../generate.js";
import { renderTemplateFile } from "../template.js";

/** `my-filter` → `MyFilter`: the generated component's name. */
export function componentName(projectName: string): string {
  const name = projectName
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[0-9]/.test(name) ? `Plugin${name}` : name || "Plugin";
}

/** A relative path with forward slashes, as written into config files and imports. */
export function relativePath(from: string, to: string): string {
  const rel = relative(from, to).split(sep).join("/");
  return rel === "" ? "." : rel.startsWith(".") ? rel : `./${rel}`;
}

export async function cliVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

export interface WireOptions {
  /** The plugin project directory. */
  pluginDir: string;
  /** The React app root (contains package.json). */
  appDir: string;
  /** The app's source directory, relative to appDir (`src`, or `app` for Next.js app-router projects). */
  sourceDir: string;
  /** Plugin project name (directory basename), used for URLs and file names. */
  projectName: string;
  manifest: NormalizedPluginManifest;
  force: boolean;
}

export interface WireResult {
  componentPath: string;
  typesPath: string;
  componentName: string;
  pluginUrl: string;
}

/**
 * Point a plugin project at a React app and drop a ready component into the
 * app: the plugin builds into `<app>/public/plugins/<name>/`, its typed
 * declarations land in `<app>/<src>/plugins/<name>.d.ts`, and
 * `<app>/<src>/audiospan/<Component>.tsx` loads it with the hooks.
 */
export async function wirePluginIntoApp(options: WireOptions): Promise<WireResult> {
  const { pluginDir, appDir, sourceDir, projectName, manifest } = options;
  const artifactDir = join(appDir, "public", "plugins", projectName);
  const typesPath = join(appDir, sourceDir, "plugins", `${projectName}.d.ts`);
  const name = componentName(projectName);
  const componentPath = join(appDir, sourceDir, "audiospan", `${name}.tsx`);
  const pluginUrl = `/plugins/${projectName}/plugin.json`;

  // The plugin project builds straight into the app.
  const configPath = join(pluginDir, "audiospan.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config["outDir"] = relativePath(pluginDir, artifactDir);
  config["typesOut"] = relativePath(pluginDir, typesPath);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  await writeTypes(typesPath, manifest);
  await mkdir(dirname(componentPath), { recursive: true });
  if (!options.force) {
    try {
      await readFile(componentPath);
      throw new CliError(`refusing to overwrite existing file ${componentPath}`, 1, "pass --force to overwrite");
    } catch (error) {
      if (error instanceof CliError) throw error;
    }
  }
  const component = await renderTemplateFile("react-component.tsx", {
    PLUGIN_NAME: manifest.name,
    PROJECT_NAME: projectName,
    COMPONENT_NAME: name,
    TYPE_PREFIX: typePrefix(manifest),
    PLUGIN_URL: pluginUrl,
  });
  await writeFile(componentPath, component);
  return { componentPath, typesPath, componentName: name, pluginUrl };
}

/** Detect the package manager from the lockfile in `dir`. */
export async function detectPackageManager(dir: string): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  const exists = async (file: string) => {
    try {
      await readFile(join(dir, file));
      return true;
    } catch {
      return false;
    }
  };
  if (await exists("pnpm-lock.yaml")) return "pnpm";
  if (await exists("yarn.lock")) return "yarn";
  if ((await exists("bun.lockb")) || (await exists("bun.lock"))) return "bun";
  return "npm";
}
