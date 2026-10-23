import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseManifest } from "@audiospan/manifest";
import { CliError } from "../errors.js";
import { writeBindings } from "../generate.js";
import { renderTemplate } from "../template.js";
import { cliVersion, relativePath, wirePluginIntoApp } from "./react-app.js";

export type TemplateName = "filter" | "gain";
export const TEMPLATES: readonly TemplateName[] = ["filter", "gain"];

export interface CreateOptions {
  name: string;
  language: "cpp" | "rust";
  /** "filter" (default): a resonant low-pass with a meter and presets. "gain": the smallest complete plugin. */
  template?: TemplateName;
  directory?: string;
  vendor?: string;
  pluginId?: string;
  force?: boolean;
  /** Also scaffold a web app wired to the plugin. "react": Vite + React + TypeScript with @audiospan/react. */
  app?: "react";
  /** Directory of the generated app (default: `<directory>-app`, next to the plugin project). */
  appDirectory?: string;
}

export interface CreateResult {
  directory: string;
  pluginId: string;
  files: string[];
  nextSteps: string[];
  /** Present with `app`: where the app was generated and the component to look at. */
  app?: { directory: string; componentPath: string; componentName: string };
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateProjectName(name: string): void {
  if (!NAME_RE.test(name) || name.length > 64) {
    throw new CliError(`invalid project name ${JSON.stringify(name)}`, 2, "use lowercase letters, digits and single hyphens, e.g. my-gain");
  }
}

function titleCase(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function createProject(options: CreateOptions): Promise<CreateResult> {
  validateProjectName(options.name);
  if (options.language !== "cpp" && options.language !== "rust") throw new CliError(`unsupported language ${JSON.stringify(options.language)}`, 2, "use --language cpp or --language rust");
  const template = options.template ?? "filter";
  if (!TEMPLATES.includes(template)) throw new CliError(`unknown template ${JSON.stringify(template)}`, 2, `use --template ${TEMPLATES.join(" or ")}`);
  const directory = resolve(options.directory ?? options.name);
  const vendor = options.vendor ?? "Your Name";
  const pluginId = options.pluginId ?? `com.example.${options.name.replace(/-/g, "_")}`;
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*){1,}$/.test(pluginId)) {
    throw new CliError(`invalid plugin id ${JSON.stringify(pluginId)}`, 2, "use a reverse-DNS id such as com.example.my_gain");
  }
  const { files } = await renderTemplate({
    templateName: `${options.language}-${template}`,
    targetDir: directory,
    force: options.force ?? false,
    variables: {
      PLUGIN_ID: pluginId,
      PLUGIN_NAME: titleCase(options.name),
      PLUGIN_DESCRIPTION: `${titleCase(options.name)}: an Audiospan effect.`,
      VENDOR: vendor,
      CRATE_NAME: options.name,
      PROJECT_NAME: options.name,
    },
  });
  // The adapter reads indices and ranges from generated/, so generate it now: the project builds and
  // type-checks in an editor before the first `audiospan build`.
  const manifest = parseManifest(await readFile(resolve(directory, "plugin.json"), "utf8"));
  if (!manifest.ok) throw new CliError(`template manifest is invalid: ${manifest.errors.map((e) => e.message).join("; ")}`, 1);
  files.push(...(await writeBindings(directory, options.language, manifest.manifest)));

  if (options.app === undefined) {
    const nextSteps = [
      `cd ${options.directory ?? options.name}`,
      options.language === "cpp" ? "# requires Emscripten (emcc) on PATH" : "# requires Rust + `rustup target add wasm32-unknown-unknown`",
      "audiospan build",
      "audiospan test",
      "audiospan dev --watch",
    ];
    return { directory, pluginId, files, nextSteps };
  }
  if (options.app !== "react") throw new CliError(`unknown app kind ${JSON.stringify(options.app)}`, 2, "use --app react");

  // A Vite + React app next to the plugin, already pointing at it.
  const appDir = resolve(options.appDirectory ?? `${directory}-app`);
  const projectName = basename(directory);
  const appFiles = await renderTemplate({
    templateName: "react-app",
    targetDir: appDir,
    force: options.force ?? false,
    variables: {
      PROJECT_NAME: projectName,
      PLUGIN_NAME: titleCase(options.name),
      PLUGIN_ID: pluginId,
      PLUGIN_DIR: relativePath(appDir, directory),
      COMPONENT_NAME: componentNameOf(projectName),
      CLI_VERSION: await cliVersion(),
    },
  });
  files.push(...appFiles.files);
  const wired = await wirePluginIntoApp({ pluginDir: directory, appDir, sourceDir: "src", projectName, manifest: manifest.manifest, force: options.force ?? false });
  files.push(wired.componentPath, wired.typesPath);
  const appRel = relativePath(process.cwd(), appDir).replace(/^\.\//, "");
  const nextSteps = [
    `cd ${appRel}`,
    "npm install                 # or pnpm / yarn",
    options.language === "cpp" ? "npm run plugin              # audiospan build (needs emcc on PATH) -> public/plugins/, src/plugins/*.d.ts" : "npm run plugin              # audiospan build (needs Rust + wasm32 target) -> public/plugins/, src/plugins/*.d.ts",
    "npm run dev                 # open the printed URL and click Start audio",
    `# the integration is ${relativePath(appDir, wired.componentPath).replace(/^\.\//, "")}`,
  ];
  return { directory, pluginId, files, nextSteps, app: { directory: appDir, componentPath: wired.componentPath, componentName: wired.componentName } };
}

function componentNameOf(projectName: string): string {
  return projectName
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
