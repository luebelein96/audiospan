import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

const TEXT_EXTENSIONS = new Set([".json", ".md", ".toml", ".rs", ".cpp", ".cc", ".c", ".h", ".hpp", ".txt", ".gitignore", ".yml", ".yaml", ".js", ".mjs", ".ts", ".tsx", ".html", ".css"]);

export interface RenderOptions {
  templateName: string;
  targetDir: string;
  variables: Record<string, string>;
  /** Overwrite existing files. Default false: an existing target file aborts before anything is written. */
  force: boolean;
}

export interface RenderResult {
  files: string[];
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out.sort();
}

function isTextFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  return TEXT_EXTENSIONS.has(ext) || base === ".gitignore";
}

export function substitute(text: string, variables: Record<string, string>): string {
  return text.replace(/__([A-Z_]+)__/g, (match, key: string) => (key in variables ? variables[key]! : match));
}

/** Copy a template directory into targetDir, substituting `__NAME__` placeholders in text files. */
export async function renderTemplate(options: RenderOptions): Promise<RenderResult> {
  const source = join(TEMPLATES_DIR, options.templateName);
  try {
    if (!(await stat(source)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new CliError(`unknown template "${options.templateName}"`, 2);
  }
  const files = await listFiles(source);
  const targets = files.map((f) => join(options.targetDir, relative(source, f)));
  if (!options.force) {
    for (const target of targets) {
      try {
        await stat(target);
        throw new CliError(`refusing to overwrite existing file ${target}`, 1, "pass --force to overwrite, or choose an empty directory");
      } catch (error) {
        if (error instanceof CliError) throw error;
      }
    }
  }
  const written: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const from = files[i]!;
    const to = targets[i]!;
    await mkdir(dirname(to), { recursive: true });
    if (isTextFile(from)) {
      await writeFile(to, substitute(await readFile(from, "utf8"), options.variables));
    } else {
      await writeFile(to, await readFile(from));
    }
    written.push(to);
  }
  return { files: written };
}

/** Render a single template file (for example `react-component.tsx`) to a string. */
export async function renderTemplateFile(fileName: string, variables: Record<string, string>): Promise<string> {
  const source = join(TEMPLATES_DIR, fileName);
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    throw new CliError(`unknown template file "${fileName}"`, 2);
  }
  return substitute(text, variables);
}
