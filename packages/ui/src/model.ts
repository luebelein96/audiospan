import { formatOutputValue, formatParameterValue, fromNormalized, toNormalized, type NormalizedOutput, type NormalizedParameter } from "@audiospan/manifest";
import type { PluginDescriptor } from "@audiospan/sdk";

export type ControlKind = "slider" | "knob" | "stepper" | "toggle" | "select";

/** A pure, framework-agnostic description of one parameter control. */
export interface ControlModel {
  readonly parameterId: string;
  readonly label: string;
  readonly kind: ControlKind;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
  readonly options: readonly { value: number; label: string }[];
  readonly unit: string | undefined;
  readonly description: string | undefined;
  /** True when the control position is not a linear function of the value (logarithmic scale or skew); sliders then work in normalized space. */
  readonly scaled: boolean;
  /** The control's rest position is zero (or the centre when zero is out of range). */
  readonly bipolar: boolean;
  readonly automatable: boolean;
  readonly parameter: NormalizedParameter;
  format(value: number): string;
  toNormalized(value: number): number;
  fromNormalized(normalized: number): number;
}

/** A pure description of one read-only output (meter). */
export interface OutputModel {
  readonly outputId: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly unit: string | undefined;
  readonly description: string | undefined;
  readonly output: NormalizedOutput;
  format(value: number): string;
}

function kindFor(p: NormalizedParameter): ControlKind {
  switch (p.type) {
    case "boolean":
      return "toggle";
    case "enum":
      return "select";
    case "integer":
      return p.display.style === "slider" || p.display.style === "knob" ? p.display.style : "stepper";
    case "float":
    default:
      return p.display.style === "knob" ? "knob" : "slider";
  }
}

function stepFor(p: NormalizedParameter): number {
  if (p.step !== undefined && p.step > 0) return p.step;
  if (p.type === "integer" || p.type === "boolean") return 1;
  if (p.type === "enum") return 1;
  const range = p.max - p.min;
  return range > 0 ? range / 1000 : 0.001;
}

export function createControlModel(p: NormalizedParameter): ControlModel {
  return {
    parameterId: p.id,
    label: p.name,
    kind: kindFor(p),
    min: p.min,
    max: p.max,
    step: stepFor(p),
    defaultValue: p.default,
    options: p.options,
    unit: p.unit,
    description: p.description,
    scaled: p.scale !== "linear" || p.skew !== 1,
    bipolar: p.display.bipolar,
    automatable: p.automatable,
    parameter: p,
    format: (value) => formatParameterValue(p, value),
    toNormalized: (value) => toNormalized(p, value),
    fromNormalized: (n) => fromNormalized(p, n),
  };
}

export function createControlModels(descriptor: Pick<PluginDescriptor, "parameters">): ControlModel[] {
  return descriptor.parameters.map(createControlModel);
}

export function createOutputModel(o: NormalizedOutput): OutputModel {
  return {
    outputId: o.id,
    label: o.name,
    min: o.min,
    max: o.max,
    unit: o.unit,
    description: o.description,
    output: o,
    format: (value) => formatOutputValue(o, value),
  };
}

export function createOutputModels(descriptor: Pick<PluginDescriptor, "outputs">): OutputModel[] {
  return descriptor.outputs.map(createOutputModel);
}
