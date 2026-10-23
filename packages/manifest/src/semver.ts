const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isSemver(value: unknown): value is string {
  return typeof value === "string" && SEMVER_RE.test(value);
}

/** Reverse-DNS-like identifier: lowercase labels separated by dots, e.g. `com.example.gain`. */
const PLUGIN_ID_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*){1,}$/;

export function isPluginId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && PLUGIN_ID_RE.test(value);
}

/** Parameter/port/preset identifiers: ASCII, start with a letter, [A-Za-z0-9_-]. */
const SHORT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function isShortId(value: unknown): value is string {
  return typeof value === "string" && SHORT_ID_RE.test(value);
}
