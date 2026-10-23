#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { flagBoolean, flagString, parseArgs } from "./args.js";
import { buildPlugin, loadManifest } from "./commands/build.js";
import { createProject, type TemplateName } from "./commands/create.js";
import { initProject } from "./commands/init.js";
import { startDev } from "./commands/dev.js";
import { packArtifact } from "./commands/pack.js";
import { testArtifact } from "./commands/test.js";
import { validateArtifact } from "./commands/validate.js";
import { loadProjectConfig } from "./config.js";
import { CliError } from "./errors.js";
import { writeBindings, writeTypes } from "./generate.js";
import { detectCargo, detectEmcc, detectRustWasmTarget } from "./toolchain.js";

const HELP = `audiospan — build audio plugins for the web

Usage:
  audiospan create <name> --language cpp|rust [--template filter|gain] [--app react] [--directory <path>] [--vendor <name>] [--id <plugin.id>] [--force]
  audiospan init [--root <react-project>] [--name <plugin-name>] [--language cpp|rust] [--template filter|gain] [--install]
  audiospan build [--root <dir>] [--dev] [--verbose] [--no-validate]
  audiospan generate [--root <dir>]
  audiospan test [--root <dir>] [--vectors <file>] [--update]
  audiospan validate <artifact-dir> [--json]
  audiospan pack [<artifact-dir>] [--root <dir>] [--out <dir>] [--include-source]
  audiospan dev [--root <dir>] [--watch] [--dev] [--port <n>] [--host <addr>] [--plugin <path>] [--open <page>]
  audiospan doctor

Exit codes: 0 ok, 1 failure, 2 usage, 3 validation failed, 4 toolchain problem.
Run \`audiospan <command> --help\` for details.`;

const COMMAND_HELP: Record<string, string> = {
  create: `audiospan create <name> --language cpp|rust
  Generate a plugin project from a template. Refuses to overwrite files unless --force.
  --template filter     A resonant low-pass filter with a level meter and presets (default)
  --template gain       The smallest complete plugin: constructor, process(), parameters()
  --app react           Also generate a Vite + React app next to the plugin, wired to it (npm install && npm run plugin && npm run dev)
  --app-dir <path>      Where to put that app (default: <directory>-app)
  --directory <path>    Target directory (default: ./<name>)
  --vendor <name>       Vendor recorded in plugin.json
  --id <plugin.id>      Reverse-DNS plugin id (default: com.example.<name>)`,
  init: `audiospan init
  Add Audiospan to an existing React project: a plugin project under audiospan/<name>/ that builds into
  public/plugins/<name>/, typed declarations in src/plugins/, a ready <Component /> in src/audiospan/, the
  @audiospan/react dependency and "plugin" / "plugin:watch" scripts in package.json.
  --root <dir>          The React project (default: .)
  --name <plugin-name>  Plugin project name (default: my-effect)
  --language cpp|rust   Plugin language (default: cpp)
  --template filter|gain
  --vendor <name>, --id <plugin.id>
  --install             Run the package manager's install afterwards
  --force               Continue without a react dependency; overwrite an existing component`,
  build: `audiospan build
  Compile the plugin to WASM with emcc or cargo, assemble dist/, and validate it.
  --root <dir>          Project directory containing audiospan.config.json (default: .)
  --dev                 Development build: enable plugin logging (audiospan::log / abi::log).
                        The module imports env.audiospan_log, which hosts accept only with
                        pluginLogging on; rebuild without --dev before distributing.
  --verbose             Stream compiler output
  --no-validate         Skip artifact validation
  Also regenerates generated/audiospan_params.{h,rs} and writes dist/plugin.d.ts (plus "typesOut").`,
  generate: `audiospan generate
  Regenerate the language bindings in generated/ (and the "typesOut" declarations) from plugin.json without building.
  --root <dir>          Project directory (default: .)`,
  test: `audiospan test
  Run generic ABI checks and test/vectors.json against dist/module.wasm in Node.
  --root <dir>          Project directory (default: .)
  --vectors <file>      Vector file (default: test/vectors.json if present)
  --update              Record the current output as "expect" for every case that has none, and save the file`,
  validate: `audiospan validate <artifact-dir>
  Validate plugin.json, the WASM module (exports/imports/memory), presets and sizes.
  --json                Print the report as JSON`,
  pack: `audiospan pack [<artifact-dir>]
  Create a deterministic <id>-<version>.audiospan.tar.gz with checksums.
  --root <dir>          Project directory (artifact dir defaults to its outDir)
  --out <dir>           Output directory (default: next to the artifact dir)
  --include-source      Also include the project sources under source/`,
  dev: `audiospan dev
  Serve the project with correct WASM MIME types and open a demo page that loads dist/plugin.json.
  --watch               Rebuild when sources change (the sandbox reloads the module and keeps your settings)
  --dev                 With --watch: development builds, so plugin log lines show in the sandbox
  --root <dir>          Directory to serve (default: .)
  --port <n>            Port (default 8787)
  --host <addr>         Bind address (default 127.0.0.1)
  --plugin <path>       Manifest path relative to root (default dist/plugin.json)
  --open <page>         Print the URL of this page instead of the built-in demo`,
  doctor: `audiospan doctor
  Report which toolchains are available.`,
};

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function printError(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const { command, positionals, flags } = args;
  if (flagBoolean(flags, "version")) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    print(pkg.version);
    return 0;
  }
  if (!command || command === "help") {
    print(HELP);
    return command ? 0 : 2;
  }
  if (flagBoolean(flags, "help")) {
    print(COMMAND_HELP[command] ?? HELP);
    return 0;
  }
  const root = resolve(flagString(flags, "root") ?? ".");

  switch (command) {
    case "create": {
      const name = positionals[0];
      if (!name) throw new CliError("create requires a project name", 2, "example: audiospan create my-gain --language cpp");
      const language = flagString(flags, "language");
      if (language !== "cpp" && language !== "rust") throw new CliError("--language cpp|rust is required", 2);
      const result = await createProject({
        name,
        language,
        template: (flagString(flags, "template") as TemplateName | undefined) ?? "filter",
        ...(flagString(flags, "directory") !== undefined ? { directory: flagString(flags, "directory")! } : {}),
        ...(flagString(flags, "vendor") !== undefined ? { vendor: flagString(flags, "vendor")! } : {}),
        ...(flagString(flags, "id") !== undefined ? { pluginId: flagString(flags, "id")! } : {}),
        ...(flagString(flags, "app") !== undefined ? { app: flagString(flags, "app") as "react" } : {}),
        ...(flagString(flags, "app-dir") !== undefined ? { appDirectory: flagString(flags, "app-dir")! } : {}),
        force: flagBoolean(flags, "force"),
      });
      print(`Created ${result.files.length} files in ${result.directory} (plugin id ${result.pluginId})${result.app ? ` and a React app in ${result.app.directory}` : ""}`);
      print("");
      print("Next steps:");
      for (const step of result.nextSteps) print(`  ${step}`);
      return 0;
    }
    case "init": {
      const language = flagString(flags, "language") ?? "cpp";
      if (language !== "cpp" && language !== "rust") throw new CliError("--language must be cpp or rust", 2);
      const result = await initProject({
        directory: root,
        language,
        ...(flagString(flags, "name") !== undefined ? { name: flagString(flags, "name")! } : {}),
        ...(flagString(flags, "template") !== undefined ? { template: flagString(flags, "template") as TemplateName } : {}),
        ...(flagString(flags, "vendor") !== undefined ? { vendor: flagString(flags, "vendor")! } : {}),
        ...(flagString(flags, "id") !== undefined ? { pluginId: flagString(flags, "id")! } : {}),
        force: flagBoolean(flags, "force"),
        install: flagBoolean(flags, "install"),
        log: print,
      });
      print(`Added Audiospan to ${result.appDirectory}:`);
      print(`  plugin project   ${result.pluginDirectory}`);
      print(`  component        ${result.componentPath}`);
      print(`  typed ids        ${result.typesPath}`);
      print(`  package.json     ${result.dependencyAdded ? "@audiospan/react added, " : ""}scripts "plugin" and "plugin:watch"`);
      print("");
      print("Next steps:");
      for (const step of result.nextSteps) print(`  ${step}`);
      return 0;
    }
    case "build": {
      const config = await loadProjectConfig(root);
      const result = await buildPlugin(config, { verbose: flagBoolean(flags, "verbose"), validate: !flagBoolean(flags, "no-validate"), dev: flagBoolean(flags, "dev"), log: print });
      print(`Built ${result.modulePath}`);
      for (const file of [...result.generated, ...result.types]) print(`Generated ${file}`);
      if (result.report) {
        for (const w of result.report.warnings) print(`warning: ${w.code}${w.path ? ` at ${w.path}` : ""}: ${w.message}`);
        print(`Validated ${result.outDir} (${result.report.files.length} files)`);
      }
      return 0;
    }
    case "generate": {
      const config = await loadProjectConfig(root);
      const manifest = await loadManifest(config);
      const written = await writeBindings(config.root, config.language, manifest);
      if (config.typesOut) written.push(await writeTypes(resolve(config.root, config.typesOut), manifest));
      for (const file of written) print(`Generated ${file}`);
      return 0;
    }
    case "test": {
      const config = await loadProjectConfig(root);
      const vectors = flagString(flags, "vectors") ?? resolve(root, "test", "vectors.json");
      let vectorsPath: string | undefined = vectors;
      try {
        await readFile(vectors);
      } catch {
        if (flagString(flags, "vectors")) throw new CliError(`vector file ${vectors} not found`, 2);
        vectorsPath = undefined;
      }
      const result = await testArtifact(resolve(root, config.outDir), vectorsPath, { update: flagBoolean(flags, "update") });
      for (const name of result.recorded) print(`RECORDED  ${name}`);
      if (result.recorded.length > 0) print(`saved ${result.recorded.length} expectation(s) to ${vectorsPath}`);
      for (const r of result.results) print(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.message ? `\n      ${r.message}` : ""}`);
      const failed = result.results.filter((r) => !r.ok).length;
      print(`${result.results.length - failed} passed, ${failed} failed`);
      return result.ok ? 0 : 3;
    }
    case "validate": {
      const dir = positionals[0];
      if (!dir) throw new CliError("validate requires an artifact directory", 2, "example: audiospan validate dist");
      const report = await validateArtifact(resolve(dir));
      if (flagBoolean(flags, "json")) {
        print(JSON.stringify({ ok: report.ok, dir: report.dir, files: report.files, errors: report.errors, warnings: report.warnings, pluginId: report.manifest?.id, version: report.manifest?.version }, null, 2));
      } else {
        for (const w of report.warnings) print(`warning: ${w.code}${w.path ? ` at ${w.path}` : ""}: ${w.message}`);
        for (const e of report.errors) printError(`error: ${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}`);
        print(report.ok ? `OK ${report.manifest?.id}@${report.manifest?.version} (${report.files.length} files, ${report.warnings.length} warnings)` : `FAILED with ${report.errors.length} error(s)`);
      }
      return report.ok ? 0 : 3;
    }
    case "pack": {
      let artifactDir = positionals[0] ? resolve(positionals[0]) : undefined;
      let sourceDir: string | undefined;
      if (!artifactDir) {
        const config = await loadProjectConfig(root);
        artifactDir = resolve(root, config.outDir);
        sourceDir = root;
      }
      const result = await packArtifact(artifactDir, {
        ...(flagString(flags, "out") !== undefined ? { outDir: flagString(flags, "out")! } : {}),
        includeSource: flagBoolean(flags, "include-source") ? { dir: sourceDir ?? root } : undefined,
      });
      print(`Packed ${result.files.length} files into ${result.archivePath} (${result.bytes} bytes)`);
      print(`sha256 ${result.sha256}`);
      return 0;
    }
    case "dev": {
      const port = flagString(flags, "port");
      const result = await startDev({
        root,
        ...(port !== undefined ? { port: Number(port) } : {}),
        ...(flagString(flags, "host") !== undefined ? { host: flagString(flags, "host")! } : {}),
        ...(flagString(flags, "plugin") !== undefined ? { pluginPath: flagString(flags, "plugin")! } : {}),
        ...(flagString(flags, "open") !== undefined ? { openPath: flagString(flags, "open")! } : {}),
        watch: flagBoolean(flags, "watch"),
        dev: flagBoolean(flags, "dev"),
        log: flagBoolean(flags, "verbose") || flagBoolean(flags, "watch") ? print : undefined,
      });
      print(`Serving ${root} at ${result.server.url}`);
      print(`Demo: ${result.demoUrl}`);
      if (result.watcher) print(`Watching ${root} for changes; edits rebuild dist/ and the sandbox reloads.`);
      print("Press Ctrl+C to stop.");
      await new Promise<void>((resolveWait) => {
        const stop = () => {
          result.watcher?.close();
          void result.server.close().then(() => resolveWait());
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    case "doctor": {
      const [emcc, cargo, wasmTarget] = await Promise.all([detectEmcc(), detectCargo(), detectRustWasmTarget()]);
      print(`node    ${process.version}`);
      print(`emcc    ${emcc.available ? emcc.version ?? "available" : "not found"}`);
      print(`cargo   ${cargo.available ? cargo.version ?? "available" : "not found"}${cargo.available ? (wasmTarget ? " (wasm32-unknown-unknown installed)" : " (wasm32-unknown-unknown target missing)") : ""}`);
      return 0;
    }
    default:
      throw new CliError(`unknown command ${JSON.stringify(command)}`, 2, "run `audiospan --help`");
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof CliError) {
      printError(`error: ${error.message}`);
      if (error.hint) printError(`hint: ${error.hint}`);
      process.exitCode = error.exitCode;
    } else {
      printError(`error: ${(error as Error).stack ?? String(error)}`);
      process.exitCode = 1;
    }
  },
);
