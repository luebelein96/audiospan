import { describe, expect, it } from "vitest";
import { clampParameterValue, formatOutputValue, formatParameterValue, fromNormalized, normalizeOutput, normalizeParameter, toNormalized } from "../src/index.js";

const gain = normalizeParameter({ id: "gain", name: "Gain", type: "float", min: 0, max: 2, default: 1, step: 0.01 }, 0);
const stages = normalizeParameter({ id: "stages", name: "Stages", type: "integer", min: 1, max: 4, default: 1 }, 1);
const enabled = normalizeParameter({ id: "enabled", name: "Enabled", type: "boolean", default: 1 }, 2);
const mode = normalizeParameter({ id: "mode", name: "Mode", type: "enum", default: 0, options: [{ value: 0, label: "Clean" }, { value: 2, label: "Warm" }, { value: 5, label: "Hot" }] }, 3);
const freq = normalizeParameter({ id: "f", name: "F", type: "float", min: 20, max: 20000, default: 1000, display: { format: "hertz", precision: 1 } }, 4);
const logFreq = normalizeParameter({ id: "lf", name: "LF", type: "float", min: 20, max: 20000, default: 1000, scale: "logarithmic", display: { format: "hertz", precision: 1 } }, 5);
const skewed = normalizeParameter({ id: "t", name: "T", type: "float", min: 0, max: 1000, default: 100, skew: 0.5, display: { format: "milliseconds", precision: 0 } }, 6);
const logInt = normalizeParameter({ id: "n", name: "N", type: "integer", min: 1, max: 1024, default: 64, scale: "logarithmic" }, 7);

describe("clampParameterValue", () => {
  it("clamps floats to range and quantizes to step", () => {
    expect(clampParameterValue(gain, 3)).toEqual({ value: 2, clamped: true });
    expect(clampParameterValue(gain, -1)).toEqual({ value: 0, clamped: true });
    expect(clampParameterValue(gain, 0.5)).toEqual({ value: 0.5, clamped: false });
    expect(clampParameterValue(gain, 0.504)).toEqual({ value: 0.5, clamped: true });
    expect(clampParameterValue(gain, 1.999)).toEqual({ value: 2, clamped: true });
  });
  it("rounds integers", () => {
    expect(clampParameterValue(stages, 2.6)).toEqual({ value: 3, clamped: true });
    expect(clampParameterValue(stages, 9)).toEqual({ value: 4, clamped: true });
    expect(clampParameterValue(stages, 2)).toEqual({ value: 2, clamped: false });
  });
  it("snaps booleans", () => {
    expect(clampParameterValue(enabled, 0.7)).toEqual({ value: 1, clamped: true });
    expect(clampParameterValue(enabled, 0.2)).toEqual({ value: 0, clamped: true });
    expect(clampParameterValue(enabled, 1)).toEqual({ value: 1, clamped: false });
  });
  it("snaps enums to the nearest option value", () => {
    expect(clampParameterValue(mode, 2)).toEqual({ value: 2, clamped: false });
    expect(clampParameterValue(mode, 3)).toEqual({ value: 2, clamped: true });
    expect(clampParameterValue(mode, 100)).toEqual({ value: 5, clamped: true });
  });
});

describe("normalized conversion", () => {
  it("round-trips floats", () => {
    expect(toNormalized(gain, 1)).toBe(0.5);
    expect(fromNormalized(gain, 0.5)).toBe(1);
    expect(fromNormalized(gain, 2)).toBe(2);
    expect(fromNormalized(gain, -1)).toBe(0);
  });
  it("maps enums by option index", () => {
    expect(toNormalized(mode, 0)).toBe(0);
    expect(toNormalized(mode, 2)).toBe(0.5);
    expect(toNormalized(mode, 5)).toBe(1);
    expect(fromNormalized(mode, 0.5)).toBe(2);
    expect(fromNormalized(mode, 1)).toBe(5);
  });
  it("maps booleans", () => {
    expect(fromNormalized(enabled, 0.9)).toBe(1);
    expect(toNormalized(enabled, 1)).toBe(1);
  });
  it("maps logarithmic parameters so equal ratios take equal travel", () => {
    expect(logFreq.scale).toBe("logarithmic");
    expect(toNormalized(logFreq, 20)).toBe(0);
    expect(toNormalized(logFreq, 20000)).toBe(1);
    expect(toNormalized(logFreq, Math.sqrt(20 * 20000))).toBeCloseTo(0.5, 10);
    expect(toNormalized(logFreq, 200)).toBeCloseTo(1 / 3, 10);
    expect(fromNormalized(logFreq, 0.5)).toBeCloseTo(632.455532, 5);
    expect(fromNormalized(logFreq, 1 / 3)).toBeCloseTo(200, 8);
    expect(fromNormalized(logFreq, -1)).toBe(20);
    expect(fromNormalized(logFreq, 2)).toBe(20000);
    expect(toNormalized(logFreq, 1)).toBe(0); // below min clamps
    for (const v of [20, 55, 440, 3000, 20000]) expect(fromNormalized(logFreq, toNormalized(logFreq, v))).toBeCloseTo(v, 6);
    expect(fromNormalized(logInt, 0.5)).toBe(32);
    expect(toNormalized(logInt, 32)).toBeCloseTo(0.5, 10);
    // Linear parameters are untouched.
    expect(toNormalized(freq, 10010)).toBeCloseTo(0.5, 10);
  });
  it("applies a power-curve skew and inverts it", () => {
    expect(skewed.skew).toBe(0.5);
    expect(toNormalized(skewed, 250)).toBe(0.5); // (0.25)^0.5
    expect(fromNormalized(skewed, 0.5)).toBe(250);
    expect(toNormalized(skewed, 0)).toBe(0);
    expect(toNormalized(skewed, 1000)).toBe(1);
    for (const v of [0, 10, 333, 999, 1000]) expect(fromNormalized(skewed, toNormalized(skewed, v))).toBeCloseTo(v, 6);
  });
});

describe("formatParameterValue", () => {
  it("formats by type and display format", () => {
    expect(formatParameterValue(gain, 1.234)).toBe("1.23");
    expect(formatParameterValue(stages, 3)).toBe("3");
    expect(formatParameterValue(enabled, 1)).toBe("On");
    expect(formatParameterValue(mode, 2)).toBe("Warm");
    expect(formatParameterValue(freq, 1500)).toBe("1.5 kHz");
    expect(formatParameterValue(freq, 440)).toBe("440.0 Hz");
    const st = normalizeParameter({ id: "s", name: "S", type: "float", min: -12, max: 12, default: 0, display: { format: "semitones", precision: 1 } }, 8);
    const ct = normalizeParameter({ id: "c", name: "C", type: "float", min: -100, max: 100, default: 0, display: { format: "cents", precision: 0 } }, 9);
    const bt = normalizeParameter({ id: "b", name: "B", type: "float", min: 0, max: 16, default: 4, display: { format: "beats", precision: 2 } }, 10);
    expect(formatParameterValue(st, 7)).toBe("7.0 st");
    expect(formatParameterValue(ct, -25)).toBe("-25 ct");
    expect(formatParameterValue(bt, 1.5)).toBe("1.50 beats");
  });
  it("formats outputs with their own display settings", () => {
    const gr = normalizeOutput({ id: "gr", name: "GR", min: -24, max: 0, display: { format: "decibel", precision: 1 } }, 0);
    expect(gr).toMatchObject({ min: -24, max: 0, index: 0 });
    expect(formatOutputValue(gr, -6.25)).toBe("-6.3 dB");
    const level = normalizeOutput({ id: "level", name: "Level", unit: "x" }, 1);
    expect(level).toMatchObject({ min: 0, max: 1, display: { format: "linear", precision: 2 } });
    expect(formatOutputValue(level, 0.5)).toBe("0.50 x");
  });
});
