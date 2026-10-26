import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseManifest } from "@audiospan/manifest";
import { CliError } from "../errors.js";
import { run } from "../toolchain.js";
import { createProject, type TemplateName } from "./create.js";
import { cliVersion, detectPackageManager, relativePath, wirePluginIntoApp } from "./react-app.js";

export interface InitOptions {
  /** The React project root (contains package.json). */
  directory: string;
  /** Plugin project name (default "my-effect"); becomes `audiospan/<name>/` and `/plugins/<name>/`. */
  name?: string;
  language: "cpp" | "rust";
  template?: TemplateName;
  vendor?: string;
  pluginId?: string;
  /** Proceed without a react dependency, overwrite an existing component. */
  force?: boolean;
  /** Run the package manager's install after adding the dependency. */
  install?: boolean;
  log?: ((line: string) => void) | undefined;
}

export interface InitResult {
  appDirectory: string;
  pluginDirectory: string;
  componentPath: string;
  typesPath: string;
  componentName: string;
  sourceDir: string;
  packageManager: "pnpm" | "yarn" | "bun" | "npm";
  /** True when @audiospan/react was added to package.json by this run. */
  dependencyAdded: boolean;
  /** True when @audiospan/cli was added to devDependencies by this run (the `plugin` scripts run it). */
  cliAdded: boolean;
  nextSteps: string[];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Add Audiospan to an existing React project: a plugin project under
 * `audiospan/<name>/` that builds into `public/plugins/<name>/`, typed
 * declarations in the source tree, a ready component, the `@audiospan/react`
 * dependency, `@audiospan/cli` as a devDependency, and two npm scripts.
 */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const appDir = resolve(options.directory);
  const log = options.log ?? (() => {});
  const packagePath = join(appDir, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new CliError(`no package.json in ${appDir}`, 2, "run `audiospan init` inside your React project, or pass --root <dir>");
  }
  const deps = { ...((pkg["dependencies"] as Record<string, string> | undefined) ?? {}), ...((pkg["devDependencies"] as Record<string, string> | undefined) ?? {}) };
  if (!("react" in deps) && !options.force) {
    throw new CliError(`${packagePath} has no react dependency`, 2, "this command sets up a React project; pass --force to continue anyway");
  }

  const sourceDir = (await isDirectory(join(appDir, "src"))) ? "src" : (await isDirectory(join(appDir, "app"))) ? "app" : "src";
  await mkdir(join(appDir, sourceDir), { recursive: true });
  await mkdir(join(appDir, "public"), { recursive: true });

  const name = options.name ?? "my-effect";
  const pluginDir = join(appDir, "audiospan", name);
  await createProject({
    name,
    language: options.language,
    directory: pluginDir,
    force: options.force ?? false,
    ...(options.template !== undefined ? { template: options.template } : {}),
    ...(options.vendor !== undefined ? { vendor: options.vendor } : {}),
    ...(options.pluginId !== undefined ? { pluginId: options.pluginId } : {}),
  });
  const manifest = parseManifest(await readFile(join(pluginDir, "plugin.json"), "utf8"));
  if (!manifest.ok) throw new CliError("generated manifest is invalid", 1);
  const wired = await wirePluginIntoApp({ pluginDir, appDir, sourceDir, projectName: name, manifest: manifest.manifest, force: options.force ?? false });

  // Dependencies and scripts. The file is rewritten with two-space indentation.
  const version = await cliVersion();
  const dependencies = (pkg["dependencies"] as Record<string, string> | undefined) ?? {};
  const dependencyAdded = !("@audiospan/react" in dependencies);
  if (dependencyAdded) {
    dependencies["@audiospan/react"] = `^${version}`;
    pkg["dependencies"] = dependencies;
  }
  // The scripts below call `audiospan`, so the CLI is a devDependency and no global install is needed.
  const devDependencies = (pkg["devDependencies"] as Record<string, string> | undefined) ?? {};
  const cliAdded = !("@audiospan/cli" in dependencies) && !("@audiospan/cli" in devDependencies);
  if (cliAdded) {
    devDependencies["@audiospan/cli"] = `^${version}`;
    pkg["devDependencies"] = devDependencies;
  }
  const scripts = (pkg["scripts"] as Record<string, string> | undefined) ?? {};
  const pluginRel = relativePath(appDir, pluginDir).replace(/^\.\//, "");
  scripts["plugin"] ??= `audiospan build --root ${pluginRel}`;
  scripts["plugin:watch"] ??= `audiospan dev --watch --root ${pluginRel}`;
  pkg["scripts"] = scripts;
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const packageManager = await detectPackageManager(appDir);
  if (options.install) {
    log(`$ ${packageManager} install`);
    const result = await run(packageManager, ["install"], { cwd: appDir, inherit: true });
    if (result.code !== 0) throw new CliError(`${packageManager} install failed with exit code ${result.code}`, 1);
  }

  const componentRel = relativePath(appDir, wired.componentPath).replace(/^\.\//, "");
  const importPath = `./${relativePath(join(appDir, sourceDir), wired.componentPath).replace(/^\.\//, "").replace(/\.tsx$/, "")}`;
  const nextSteps = [
    ...(options.install ? [] : [`${packageManager} install                # adds @audiospan/react and @audiospan/cli`]),
    `${packageManager === "npm" ? "npm run" : packageManager} plugin                 # audiospan build (needs ${options.language === "cpp" ? "emcc" : "Rust + the wasm32 target"}) -> public/plugins/${name}/`,
    `# render <${wired.componentName} /> from ${componentRel}:`,
    `#   import { ${wired.componentName} } from "${importPath}";`,
    `# your DSP goes in ${pluginRel}/src/; \`${packageManager === "npm" ? "npm run" : packageManager} plugin:watch\` rebuilds on save`,
  ];
  return { appDirectory: appDir, pluginDirectory: pluginDir, componentPath: wired.componentPath, typesPath: wired.typesPath, componentName: wired.componentName, sourceDir, packageManager, dependencyAdded, cliAdded, nextSteps };
}
