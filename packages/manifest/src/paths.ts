/**
 * Artifact-relative path rules. Manifest paths must stay inside the artifact
 * directory: no absolute paths, no URL schemes, no `..` segments, no
 * backslashes, no empty or dot segments, and no control characters.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false; // scheme
  if (value.includes("\\")) return false;
  if (value.includes("//")) return false;
  if (value.includes("?") || value.includes("#")) return false;
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (segment.includes("%")) return false; // no percent-encoding tricks
  }
  return true;
}

/**
 * Resolve an artifact-relative path against the manifest URL. Throws if the
 * path is unsafe or the result escapes the manifest's directory.
 */
export function resolveArtifactUrl(manifestUrl: string | URL, relativePath: string): URL {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Unsafe artifact path: ${JSON.stringify(relativePath)}`);
  }
  const base = new URL(manifestUrl.toString());
  const dir = new URL(".", base);
  const resolved = new URL(relativePath, dir);
  if (resolved.origin !== dir.origin || !resolved.pathname.startsWith(dir.pathname)) {
    throw new Error(`Artifact path escapes manifest directory: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}
