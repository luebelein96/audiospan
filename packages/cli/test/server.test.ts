import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer, audiospanVirtualFiles, type DevServer } from "../src/lib.js";

describe("dev server", () => {
  let root: string;
  let server: DevServer;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "as-serve-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "module.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    writeFileSync(join(root, "dist", "plugin.json"), "{}");
    writeFileSync(join(root, "index.html"), "<p>hi</p>");
    writeFileSync(join(root, "secret.txt"), "shh");
    const virtual = { "/__audiospan/virtual.txt": join(root, "secret.txt") };
    server = await startDevServer({ root, port: 0, virtualFiles: virtual });
  });
  afterAll(async () => {
    await server.close();
  });

  it("serves wasm with the right MIME type, no-cache and CORS", async () => {
    const res = await fetch(`${server.url}dist/module.wasm`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/wasm");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.arrayBuffer()).byteLength).toBe(8);
    expect((await fetch(`${server.url}dist/plugin.json`)).headers.get("content-type")).toContain("application/json");
  });

  it("serves index files, virtual routes, and 404s", async () => {
    expect(await (await fetch(server.url)).text()).toBe("<p>hi</p>");
    expect(await (await fetch(`${server.url}__audiospan/virtual.txt`)).text()).toBe("shh");
    expect((await fetch(`${server.url}nope.js`)).status).toBe(404);
    expect((await fetch(`${server.url}dist/`)).status).toBe(404);
    expect((await fetch(server.url, { method: "POST" })).status).toBe(405);
  });

  it("blocks path traversal", async () => {
    for (const path of ["..%2F..%2Fetc%2Fpasswd", "dist/..%2F..%2Fsecret.txt", "%2e%2e/%2e%2e/etc/hosts"]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("reports artifact mtimes for reload polling", async () => {
    const res = await fetch(`${server.url}__audiospan/mtime?file=dist/module.wasm`);
    const body = (await res.json()) as { mtime: number };
    expect(body.mtime).toBeGreaterThan(0);
    const missing = (await (await fetch(`${server.url}__audiospan/mtime?file=../x`)).json()) as { mtime: number };
    expect(missing.mtime).toBe(0);
  });

  it("resolves the SDK, UI and worklet bundles for the sandbox", () => {
    const virtual = audiospanVirtualFiles();
    expect(virtual["/__audiospan/sdk.js"]).toMatch(/audiospan-sdk\.bundle\.js$/);
    expect(virtual["/__audiospan/worklet.js"]).toMatch(/audiospan-worklet\.js$/);
    expect(virtual["/__audiospan/ui.js"]).toMatch(/audiospan-ui\.bundle\.js$/);
  });
});
