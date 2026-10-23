import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".tar.gz": "application/gzip",
});

export interface DevServerOptions {
  /** Directory served at `/`. */
  root: string;
  host?: string | undefined;
  port?: number | undefined;
  /** Extra virtual routes: URL path -> absolute file path. */
  virtualFiles?: Record<string, string>;
  /** Send `Access-Control-Allow-Origin: *` (default true). */
  cors?: boolean;
  log?: ((line: string) => void) | undefined;
}

export interface DevServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // Reject any parent-directory segment outright instead of normalising it away.
  if (decoded.split(/[\/\\]/).some((segment) => segment === "..")) return null;
  const normalized = normalize(decoded);
  const full = resolve(root, `.${sep}${normalized}`);
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
}

function mimeFor(path: string): string {
  if (path.endsWith(".tar.gz")) return MIME_TYPES[".tar.gz"]!;
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function sendFile(res: ServerResponse, path: string, cors: boolean): Promise<boolean> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (info.isDirectory()) {
    const index = join(path, "index.html");
    try {
      info = await stat(index);
      path = index;
    } catch {
      return false;
    }
  }
  if (!info.isFile()) return false;
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeFor(path));
  res.setHeader("Content-Length", String(info.size));
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (cors) res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Last-Modified", info.mtime.toUTCString());
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("end", () => resolveStream());
    stream.pipe(res);
  });
  return true;
}

/**
 * A small static file server with the headers Audiospan needs: correct
 * `application/wasm` MIME type, no caching, CORS allowed, directory index
 * files, and strict path containment. No deployment credentials, no proxying.
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const root = resolve(options.root);
  const cors = options.cors !== false;
  const virtual = options.virtualFiles ?? {};
  const log = options.log ?? (() => {});
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end("method not allowed");
        return;
      }
      if (url.pathname === "/__audiospan/mtime") {
        const file = url.searchParams.get("file") ?? "";
        const target = safeJoin(root, file);
        let mtime = 0;
        if (target) {
          try {
            mtime = (await stat(target)).mtimeMs;
          } catch {
            mtime = 0;
          }
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ mtime }));
        return;
      }
      const virtualPath = virtual[url.pathname];
      if (virtualPath && (await sendFile(res, virtualPath, cors))) return;
      const target = safeJoin(root, url.pathname);
      if (target && (await sendFile(res, target, cors))) return;
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end(`not found: ${url.pathname}`);
    } catch (error) {
      res.statusCode = 500;
      res.end(`server error: ${(error as Error).message}`);
    } finally {
      log(`${res.statusCode} ${req.method} ${url.pathname}`);
    }
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/`,
    port,
    server,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}

/** Absolute path of a packaged file resolved through package exports. */
export function resolvePackageFile(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}
