import { describe, expect, it } from "vitest";
import { DEFAULT_PLUGIN_POLICY, checkOriginPolicy, resolvePolicy } from "../src/policy.js";

describe("checkOriginPolicy", () => {
  const policy = DEFAULT_PLUGIN_POLICY;

  it("allows same-origin and listed origins, denies the rest", () => {
    expect(checkOriginPolicy(new URL("https://app.example/p/plugin.json"), policy, "https://app.example")).toBeUndefined();
    expect(checkOriginPolicy(new URL("https://cdn.example/p/plugin.json"), policy, "https://app.example")).toMatch(/not allowed/);
    expect(checkOriginPolicy(new URL("https://cdn.example/p/plugin.json"), resolvePolicy({ allowedPluginOrigins: ["https://cdn.example"] }), "https://app.example")).toBeUndefined();
    expect(checkOriginPolicy(new URL("https://cdn.example/p/plugin.json"), resolvePolicy({ allowRemotePlugins: true }), "https://app.example")).toBeUndefined();
  });

  it("treats an opaque page origin as an origin, not as the absence of a browser", () => {
    // A file:// page reports origin "null": it may load file:// plugins but not arbitrary remote ones.
    expect(checkOriginPolicy(new URL("file:///plugins/gain/plugin.json"), policy, "null")).toBeUndefined();
    expect(checkOriginPolicy(new URL("https://cdn.example/p/plugin.json"), policy, "null")).toMatch(/not allowed/);
    // No location at all (Node, a worker without one): any origin unless an allowlist is configured.
    expect(checkOriginPolicy(new URL("https://cdn.example/p/plugin.json"), policy, undefined)).toBeUndefined();
    expect(checkOriginPolicy(new URL("https://cdn.example/p/plugin.json"), resolvePolicy({ allowedPluginOrigins: ["https://other.example"] }), undefined)).toMatch(/not allowed/);
  });

  it("names the schemes it accepts when rejecting one", () => {
    expect(checkOriginPolicy(new URL("ftp://cdn.example/p/plugin.json"), policy, "https://app.example")).toMatch(/http\(s\), blob: or file:/);
    expect(checkOriginPolicy(new URL("data:application/json,{}"), policy, "https://app.example")).toMatch(/got data:/);
  });
});
