import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, PROTOCOL_VERSION, parseMainMessage, validateRuntimeConfig } from "../src/index.js";

const config = { ...DEFAULT_RUNTIME_CONFIG, sampleRate: 48000 };

describe("parseMainMessage", () => {
  it("accepts well-formed messages", () => {
    expect(parseMainMessage({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 1, config }).ok).toBe(true);
    expect(parseMainMessage({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: 0.5, sequence: 3 }).ok).toBe(true);
    expect(parseMainMessage({ type: "SET_BYPASS", instanceId: "a", bypassed: true, sequence: 1 }).ok).toBe(true);
    expect(parseMainMessage({ type: "REPLACE_CHAIN", requestId: 2, instanceIds: ["a", "b"] }).ok).toBe(true);
    expect(parseMainMessage({ type: "SET_STATE", requestId: 2, instanceId: "a", parameters: [[0, 1]], opaque: new ArrayBuffer(4) }).ok).toBe(true);
    expect(parseMainMessage({ type: "PING", requestId: 9 }).ok).toBe(true);
    expect(parseMainMessage({ type: "DISPOSE", requestId: 9 }).ok).toBe(true);
  });

  it("rejects unknown types, wrong protocol versions and malformed fields", () => {
    expect(parseMainMessage(null).ok).toBe(false);
    expect(parseMainMessage("INIT").ok).toBe(false);
    expect(parseMainMessage({ type: "HACK" }).ok).toBe(false);
    expect(parseMainMessage({ type: "INIT", protocolVersion: PROTOCOL_VERSION + 1, requestId: 1, config }).ok).toBe(false);
    expect(parseMainMessage({ type: "INIT", protocolVersion: PROTOCOL_VERSION - 1, requestId: 1, config }).ok).toBe(false); // a stale worklet/SDK pair
    expect(parseMainMessage({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 1, config: { ...config, maxChannels: 0 } }).ok).toBe(false);
    expect(parseMainMessage({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: -1, value: 0.5, sequence: 3 }).ok).toBe(false);
    expect(parseMainMessage({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: Number.NaN, sequence: 3 }).ok).toBe(false);
    expect(parseMainMessage({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: Number.POSITIVE_INFINITY, sequence: 3 }).ok).toBe(false);
    expect(parseMainMessage({ type: "SET_PARAMETER", instanceId: "", parameterIndex: 0, value: 1, sequence: 3 }).ok).toBe(false);
    expect(parseMainMessage({ type: "REPLACE_CHAIN", requestId: 2, instanceIds: [1, 2] }).ok).toBe(false);
    expect(parseMainMessage({ type: "REPLACE_CHAIN", instanceIds: ["a"] }).ok).toBe(false);
    expect(parseMainMessage({ type: "SET_STATE", requestId: 2, instanceId: "a", parameters: [[0, "x"]] }).ok).toBe(false);
    expect(parseMainMessage({ type: "SET_STATE", requestId: 2, instanceId: "a", parameters: [], opaque: "AAAA" }).ok).toBe(false);
    expect(parseMainMessage({ type: "LOAD_PLUGIN", requestId: 1, pluginId: "x", module: "bytes", manifest: {} }).ok).toBe(false);
    expect(parseMainMessage({ type: "CREATE_INSTANCE", requestId: 1, pluginId: "x", instanceId: "i", initialParameters: [Number.NaN] }).ok).toBe(false);
  });

  it("carries the requestId through failures when present", () => {
    const result = parseMainMessage({ type: "RESET", requestId: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requestId).toBe(42);
  });
});

describe("validateRuntimeConfig", () => {
  it("validates pluginLogging and outputsPerSecond", () => {
    expect(validateRuntimeConfig({ ...config, pluginLogging: "yes" })).toMatch(/pluginLogging/);
    expect(validateRuntimeConfig({ ...config, outputsPerSecond: 121 })).toMatch(/outputsPerSecond/);
    expect(validateRuntimeConfig({ ...config, outputsPerSecond: -1 })).toMatch(/outputsPerSecond/);
    expect(validateRuntimeConfig({ ...config, outputsPerSecond: 0, pluginLogging: true })).toMatchObject({ outputsPerSecond: 0, pluginLogging: true });
  });

  it("returns a normalized config or an error string", () => {
    expect(validateRuntimeConfig(config)).toEqual(config);
    expect(typeof validateRuntimeConfig({ ...config, diagnostics: "yes" })).toBe("string");
    expect(typeof validateRuntimeConfig({ ...config, maxFrames: 1e9 })).toBe("string");
  });
});
