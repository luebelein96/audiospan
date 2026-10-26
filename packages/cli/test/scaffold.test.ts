import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, componentName, createProject, detectPackageManager, initProject } from "../src/lib.js";

describe("create --app react", () => {
  it("scaffolds a Vite + React app wired to the plugin project", async () => {
    const base = mkdtempSync(join(tmpdir(), "as-app-"));
    const pluginDir = join(base, "my-filter");
    const result = await createProject({ name: "my-filter", language: "cpp", directory: pluginDir, app: "react" });
    expect(result.app?.directory).toBe(join(base, "my-filter-app"));
    expect(result.app?.componentName).toBe("MyFilter");
    const appDir = result.app!.directory;
    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { name: string; dependencies: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.name).toBe("my-filter-app");
    expect(pkg.dependencies["@audiospan/react"]).toMatch(/^\^\d/);
    expect(pkg.devDependencies["@audiospan/cli"]).toMatch(/^\^\d/); // the plugin scripts run it; no global install needed
    expect(pkg.scripts["plugin"]).toBe("audiospan build --root ../my-filter");
    expect(existsSync(join(appDir, "vite.config.ts"))).toBe(true);
    expect(readFileSync(join(appDir, "src/App.tsx"), "utf8")).toContain('import { MyFilter } from "./audiospan/MyFilter.tsx";');
    const component = readFileSync(join(appDir, "src/audiospan/MyFilter.tsx"), "utf8");
    expect(component).toContain("export function MyFilter()");
    expect(component).toContain('usePlugin<MyFilterPlugin>(audio.host, PLUGIN_URL)');
    expect(component).toContain('import type { MyFilterPlugin } from "../plugins/my-filter.js";');
    expect(component).toContain('const PLUGIN_URL = "/plugins/my-filter/plugin.json";');
    expect(readFileSync(join(appDir, "src/plugins/my-filter.d.ts"), "utf8")).toContain("export type MyFilterPlugin = TypedPluginInstance<");
    // The plugin project builds into the app.
    const config = JSON.parse(readFileSync(join(pluginDir, "audiospan.config.json"), "utf8")) as { outDir: string; typesOut: string };
    expect(config.outDir).toBe("../my-filter-app/public/plugins/my-filter");
    expect(config.typesOut).toBe("../my-filter-app/src/plugins/my-filter.d.ts");
    expect(result.nextSteps.join("\n")).toContain("npm run dev");
    await expect(createProject({ name: "x", language: "cpp", directory: join(base, "x"), app: "vue" as "react" })).rejects.toBeInstanceOf(CliError);
  });
});

describe("init (existing React project)", () => {
  function fakeReactApp(withLockfile?: string, extra: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "as-init-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop", private: true, dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, scripts: { dev: "vite" }, ...extra }, null, 2));
    mkdirSync(join(dir, "src"));
    if (withLockfile) writeFileSync(join(dir, withLockfile), "");
    return dir;
  }

  it("adds a plugin project, a component, typed ids, the dependency and scripts", async () => {
    const dir = fakeReactApp("pnpm-lock.yaml");
    const result = await initProject({ directory: dir, language: "cpp", name: "warm-filter", template: "filter" });
    expect(result.packageManager).toBe("pnpm");
    expect(result.sourceDir).toBe("src");
    expect(result.componentName).toBe("WarmFilter");
    expect(result.dependencyAdded).toBe(true);
    expect(existsSync(join(dir, "audiospan/warm-filter/plugin.json"))).toBe(true);
    expect(existsSync(join(dir, "audiospan/warm-filter/generated/audiospan_params.h"))).toBe(true);
    expect(existsSync(join(dir, "public"))).toBe(true);
    const config = JSON.parse(readFileSync(join(dir, "audiospan/warm-filter/audiospan.config.json"), "utf8")) as { outDir: string; typesOut: string };
    expect(config.outDir).toBe("../../public/plugins/warm-filter");
    expect(config.typesOut).toBe("../../src/plugins/warm-filter.d.ts");
    expect(readFileSync(join(dir, "src/plugins/warm-filter.d.ts"), "utf8")).toContain("WarmFilterPlugin");
    expect(readFileSync(join(dir, "src/audiospan/WarmFilter.tsx"), "utf8")).toContain('"use client";');
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.dependencies["@audiospan/react"]).toMatch(/^\^\d/);
    expect(pkg.devDependencies["@audiospan/cli"]).toMatch(/^\^\d/); // the plugin scripts run it; no global install needed
    expect(pkg.dependencies["react"]).toBe("^19.0.0"); // untouched
    expect(pkg.scripts["dev"]).toBe("vite"); // untouched
    expect(pkg.scripts["plugin"]).toBe("audiospan build --root audiospan/warm-filter");
    expect(pkg.scripts["plugin:watch"]).toBe("audiospan dev --watch --root audiospan/warm-filter");
    expect(result.nextSteps.join("\n")).toContain('import { WarmFilter } from "./audiospan/WarmFilter";');
    expect(result.nextSteps.join("\n")).toContain("pnpm install");
    // Running it again refuses to overwrite the component without --force.
    await expect(initProject({ directory: dir, language: "cpp", name: "warm-filter" })).rejects.toBeInstanceOf(CliError);
  });

  it("uses app/ for Next.js app-router projects and detects other package managers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-init-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "site", dependencies: { react: "^19.0.0", next: "^15.0.0" } }));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "yarn.lock"), "");
    const result = await initProject({ directory: dir, language: "rust", template: "gain" });
    expect(result.sourceDir).toBe("app");
    expect(result.packageManager).toBe("yarn");
    expect(existsSync(join(dir, "app/audiospan/MyEffect.tsx"))).toBe(true);
    expect(existsSync(join(dir, "audiospan/my-effect/generated/audiospan_params.rs"))).toBe(true);
    expect(await detectPackageManager(dir)).toBe("yarn");
  });

  it("refuses non-React projects unless forced, and needs a package.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-init-"));
    await expect(initProject({ directory: dir, language: "cpp" })).rejects.toMatchObject({ exitCode: 2 });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "plain", dependencies: { vue: "^3.0.0" } }));
    await expect(initProject({ directory: dir, language: "cpp" })).rejects.toMatchObject({ exitCode: 2 });
    const forced = await initProject({ directory: dir, language: "cpp", force: true });
    expect(forced.componentName).toBe("MyEffect");
    expect(componentName("my-effect")).toBe("MyEffect");
    expect(componentName("2band")).toBe("Plugin2band");
  });
});
