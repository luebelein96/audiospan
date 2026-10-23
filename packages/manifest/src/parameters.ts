import type { NormalizedOutput, NormalizedParameter, OutputManifest, ParameterDisplayFormat, ParameterManifest } from "./types.js";

export interface ClampResult {
  value: number;
  clamped: boolean;
}

/**
 * Resolve a parameter's defaults from its type. Assumes the parameter already
 * passed structural validation (see validate.ts).
 */
export function normalizeParameter(param: ParameterManifest, index: number): NormalizedParameter {
  const options = param.options ?? [];
  let min: number;
  let max: number;
  let step: number | undefined = param.step;
  switch (param.type) {
    case "boolean":
      min = 0;
      max = 1;
      step = 1;
      break;
    case "enum": {
      const values = options.map((o) => o.value);
      min = values.length ? Math.min(...values) : 0;
      max = values.length ? Math.max(...values) : 0;
      step = undefined;
      break;
    }
    case "integer":
      min = param.min ?? 0;
      max = param.max ?? 1;
      step = step ?? 1;
      break;
    case "float":
    default:
      min = param.min ?? 0;
      max = param.max ?? 1;
      break;
  }
  const defaultStyle =
    param.type === "boolean" ? "toggle" : param.type === "enum" ? "select" : param.type === "integer" ? "stepper" : "slider";
  const defaultFormat = param.type === "integer" || param.type === "enum" || param.type === "boolean" ? "integer" : "linear";
  const numeric = param.type === "float" || param.type === "integer";
  return {
    id: param.id,
    name: param.name,
    type: param.type,
    unit: param.unit,
    description: param.description,
    min,
    max,
    default: param.default,
    step,
    options,
    scale: numeric && param.scale === "logarithmic" ? "logarithmic" : "linear",
    skew: numeric && param.skew !== undefined && param.skew > 0 ? param.skew : 1,
    automatable: param.automatable ?? true,
    display: {
      style: param.display?.style ?? defaultStyle,
      format: param.display?.format ?? defaultFormat,
      precision: param.display?.precision ?? (param.type === "float" ? 2 : 0),
      bipolar: param.display?.bipolar ?? false,
    },
    index,
  };
}

/** Resolve an output's defaults. Assumes structural validation already passed. */
export function normalizeOutput(output: OutputManifest, index: number): NormalizedOutput {
  return {
    id: output.id,
    name: output.name,
    unit: output.unit,
    description: output.description,
    min: output.min ?? 0,
    max: output.max ?? 1,
    display: {
      format: output.display?.format ?? "linear",
      precision: output.display?.precision ?? 2,
    },
    index,
  };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** True when the parameter's logarithmic mapping is well defined. */
function usesLogScale(param: NormalizedParameter): boolean {
  return param.scale === "logarithmic" && param.min > 0 && param.max > param.min;
}

/**
 * Clamp and quantize a real value according to parameter metadata.
 * Non-finite input is rejected by the caller; this function assumes finite.
 */
export function clampParameterValue(param: NormalizedParameter, value: number): ClampResult {
  let v = value;
  let clamped = false;
  switch (param.type) {
    case "boolean":
      v = v >= 0.5 ? 1 : 0;
      clamped = v !== value;
      return { value: v, clamped };
    case "enum": {
      if (param.options.some((o) => o.value === value)) return { value, clamped: false };
      // Snap to nearest option value.
      let best = param.options[0]?.value ?? 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const option of param.options) {
        const d = Math.abs(option.value - value);
        if (d < bestDistance) {
          bestDistance = d;
          best = option.value;
        }
      }
      return { value: best, clamped: true };
    }
    case "integer":
      v = Math.round(v);
      break;
    case "float":
    default:
      break;
  }
  if (v < param.min) {
    v = param.min;
  } else if (v > param.max) {
    v = param.max;
  }
  if (param.step !== undefined && param.step > 0 && param.type === "float") {
    const steps = Math.round((v - param.min) / param.step);
    const quantized = param.min + steps * param.step;
    // Guard against float drift pushing past max.
    v = Math.min(param.max, Math.max(param.min, Number(quantized.toFixed(10))));
  }
  if (v !== value) clamped = true;
  return { value: v, clamped };
}

/**
 * Real value -> [0, 1] control position. Applies the parameter's `scale`
 * (logarithmic: equal ratios map to equal distances) and `skew` (power curve;
 * below 1 spreads the low end of the range over more of the control).
 */
export function toNormalized(param: NormalizedParameter, value: number): number {
  if (param.type === "enum") {
    const idx = param.options.findIndex((o) => o.value === value);
    const count = param.options.length;
    if (idx < 0 || count <= 1) return 0;
    return idx / (count - 1);
  }
  const range = param.max - param.min;
  if (range <= 0) return 0;
  if (usesLogScale(param)) {
    const v = value < param.min ? param.min : value > param.max ? param.max : value;
    return clamp01(Math.log(v / param.min) / Math.log(param.max / param.min));
  }
  const n = clamp01((value - param.min) / range);
  return param.skew !== 1 ? Math.pow(n, param.skew) : n;
}

/** [0, 1] control position -> real value (clamped and quantized). Inverse of `toNormalized`. */
export function fromNormalized(param: NormalizedParameter, normalized: number): number {
  const n = clamp01(normalized);
  if (param.type === "enum") {
    const count = param.options.length;
    if (count === 0) return 0;
    const idx = Math.round(n * (count - 1));
    return param.options[idx]?.value ?? param.options[0]!.value;
  }
  let value: number;
  if (usesLogScale(param)) {
    value = param.min * Math.pow(param.max / param.min, n);
  } else {
    const fraction = param.skew !== 1 ? Math.pow(n, 1 / param.skew) : n;
    value = param.min + fraction * (param.max - param.min);
  }
  return clampParameterValue(param, value).value;
}

/** Human-readable value for the default UI. */
export function formatParameterValue(param: NormalizedParameter, value: number): string {
  const precision = param.display.precision;
  switch (param.type) {
    case "boolean":
      return value >= 0.5 ? "On" : "Off";
    case "enum":
      return param.options.find((o) => o.value === value)?.label ?? String(value);
    default:
      break;
  }
  return formatNumber(param.display.format, precision, param.unit, value);
}

/** Human-readable output (meter) value for the default UI. */
export function formatOutputValue(output: NormalizedOutput, value: number): string {
  return formatNumber(output.display.format, output.display.precision, output.unit, value);
}

function formatNumber(format: ParameterDisplayFormat, precision: number, unit: string | undefined, value: number): string {
  switch (format) {
    case "decibel":
      return `${value.toFixed(precision)} dB`;
    case "percent":
      return `${(value * 100).toFixed(precision)} %`;
    case "hertz":
      return value >= 1000 ? `${(value / 1000).toFixed(precision)} kHz` : `${value.toFixed(precision)} Hz`;
    case "milliseconds":
      return `${value.toFixed(precision)} ms`;
    case "seconds":
      return `${value.toFixed(precision)} s`;
    case "semitones":
      return `${value.toFixed(precision)} st`;
    case "cents":
      return `${value.toFixed(precision)} ct`;
    case "beats":
      return `${value.toFixed(precision)} beats`;
    case "integer":
      return String(Math.round(value));
    case "linear":
    default:
      return unit && unit !== "linear" ? `${value.toFixed(precision)} ${unit}` : value.toFixed(precision);
  }
}

export function linearToDecibels(linear: number): number {
  return linear <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(linear);
}

export function decibelsToLinear(db: number): number {
  return db === Number.NEGATIVE_INFINITY ? 0 : Math.pow(10, db / 20);
}
