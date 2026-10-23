import { describe, expect, it } from "vitest";
import { normalizeParameter } from "@audiospan/manifest";
import { createControlModel, createControlModels, createOutputModels } from "../src/index.js";
import { MockPlugin } from "./mock-plugin.js";

describe("createControlModels", () => {
  it("maps parameter types and display styles to control kinds", () => {
    const models = createControlModels(new MockPlugin().descriptor);
    expect(models.map((m) => [m.parameterId, m.kind])).toEqual([
      ["gain", "knob"],
      ["mode", "select"],
      ["stages", "stepper"],
      ["enabled", "toggle"],
    ]);
    const gain = models[0]!;
    expect(gain.step).toBe(0.01);
    expect(gain.format(1.234)).toBe("1.23");
    expect(gain.toNormalized(1)).toBe(0.5);
    expect(gain.fromNormalized(0.25)).toBe(0.5);
    expect(models[1]!.options).toHaveLength(2);
    expect(models[2]!.step).toBe(1);
    expect(gain).toMatchObject({ scaled: false, bipolar: false, automatable: true });
  });

  it("flags scaled and bipolar parameters", () => {
    const log = createControlModel(normalizeParameter({ id: "f", name: "F", type: "float", min: 20, max: 20000, default: 1000, scale: "logarithmic" }, 0));
    expect(log.scaled).toBe(true);
    expect(log.toNormalized(Math.sqrt(20 * 20000))).toBeCloseTo(0.5, 10);
    const skew = createControlModel(normalizeParameter({ id: "t", name: "T", type: "float", min: 0, max: 100, default: 0, skew: 0.5, automatable: false, display: { bipolar: true } }, 1));
    expect(skew).toMatchObject({ scaled: true, bipolar: true, automatable: false });
  });

  it("builds output models", () => {
    const outputs = createOutputModels(new MockPlugin().descriptor);
    expect(outputs.map((o) => [o.outputId, o.min, o.max])).toEqual([["level", 0, 2]]);
    expect(outputs[0]!.format(0.5)).toBe("0.50");
  });
});
