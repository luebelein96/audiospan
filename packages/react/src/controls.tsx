import { createControlModel, createOutputModel, injectStyles, type ControlModel, type OutputModel } from "@audiospan/ui";
import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { PluginHandle } from "./usePlugin.js";

/** Any handle from `usePlugin`, typed or not; the controls take parameter ids as plain strings. */
export type AnyPluginHandle = PluginHandle;

export interface ParameterHandle {
  /** Pure control metadata from the manifest, or null while the plugin is not ready / the id is unknown. */
  model: ControlModel | null;
  value: number;
  normalized: number;
  set(value: number): void;
  setNormalized(normalized: number): void;
  format(value: number): string;
}

/**
 * Bind one parameter of a plugin handle: its current value, the normalized
 * position (with the manifest's scale and skew applied), setters, and the
 * control model (kind, range, options, formatter) for your own component.
 */
export function useParameter(plugin: AnyPluginHandle, id: string): ParameterHandle {
  const model = useMemo(() => {
    const p = plugin.descriptor?.parameters.find((x) => x.id === id);
    return p ? createControlModel(p) : null;
  }, [plugin.descriptor, id]);
  const value = plugin.values[id] ?? model?.defaultValue ?? 0;
  return {
    model,
    value,
    normalized: model ? model.toNormalized(value) : 0,
    set: (v) => plugin.setParameter(id, v),
    setNormalized: (n) => plugin.setParameterNormalized(id, n),
    format: (v) => (model ? model.format(v) : String(v)),
  };
}

/** Bind one output (meter) of a plugin handle. */
export function useOutput(plugin: AnyPluginHandle, id: string): { model: OutputModel | null; value: number; format(value: number): string } {
  const model = useMemo(() => {
    const o = plugin.descriptor?.outputs.find((x) => x.id === id);
    return o ? createOutputModel(o) : null;
  }, [plugin.descriptor, id]);
  const value = plugin.outputs[id] ?? model?.min ?? 0;
  return { model, value, format: (v) => (model ? model.format(v) : String(v)) };
}

function useDefaultStyles(): void {
  useEffect(() => {
    injectStyles();
  }, []);
}

export interface ControlProps {
  plugin: AnyPluginHandle;
  /** Parameter id from the manifest. */
  id: string;
  className?: string;
}

const START_ANGLE = -135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  if (to - from <= 0.0001) return "";
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** A rotary control: drag vertically (shift for fine), arrow keys, Home/End, double-click to reset. Bipolar parameters fill from their rest position. */
export function Knob({ plugin, id, className, size = 44 }: ControlProps & { size?: number }) {
  useDefaultStyles();
  const param = useParameter(plugin, id);
  const drag = useRef<{ startY: number; startNormalized: number } | null>(null);
  const model = param.model;
  const n = param.normalized;
  const angle = START_ANGLE + n * SWEEP;
  const restNormalized = model?.bipolar ? (model.min < 0 && model.max > 0 ? model.toNormalized(0) : 0.5) : 0;
  const restAngle = START_ANGLE + restNormalized * SWEEP;
  const [px1, py1] = polar(22, 22, 6, angle);
  const [px2, py2] = polar(22, 22, 14, angle);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    drag.current = { startY: event.clientY, startNormalized: n };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const delta = (drag.current.startY - event.clientY) / (event.shiftKey ? 1200 : 200);
    param.setNormalized(drag.current.startNormalized + delta);
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!model) return;
    const fine = event.shiftKey ? 0.002 : 0.02;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        param.setNormalized(n + fine);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        param.setNormalized(n - fine);
        break;
      case "Home":
        param.set(model.min);
        break;
      case "End":
        param.set(model.max);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <svg
      viewBox="0 0 44 44"
      width={size}
      height={size}
      className={className ? `as-knob ${className}` : "as-knob"}
      role="slider"
      tabIndex={0}
      aria-label={model?.label ?? id}
      aria-valuemin={model?.min}
      aria-valuemax={model?.max}
      aria-valuenow={param.value}
      aria-valuetext={param.format(param.value)}
      aria-disabled={!model}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => model && param.set(model.defaultValue)}
    >
      <path className="as-knob__track" d={arcPath(22, 22, 16, START_ANGLE, START_ANGLE + SWEEP)} />
      <path className="as-knob__fill" d={angle >= restAngle ? arcPath(22, 22, 16, restAngle, angle) : arcPath(22, 22, 16, angle, restAngle)} />
      <line className="as-knob__pointer" x1={px1.toFixed(2)} y1={py1.toFixed(2)} x2={px2.toFixed(2)} y2={py2.toFixed(2)} />
    </svg>
  );
}

/** A range input. Logarithmic and skewed parameters are driven in normalized space so the travel follows the curve. */
export function Slider({ plugin, id, className }: ControlProps) {
  useDefaultStyles();
  const param = useParameter(plugin, id);
  const model = param.model;
  const scaled = model?.scaled ?? false;
  return (
    <input
      type="range"
      className={className}
      disabled={!model}
      min={scaled ? 0 : (model?.min ?? 0)}
      max={scaled ? 1 : (model?.max ?? 1)}
      step={scaled ? 0.001 : (model?.step ?? 0.001)}
      value={scaled ? param.normalized : param.value}
      aria-label={model?.label ?? id}
      aria-valuetext={param.format(param.value)}
      onChange={(event) => (scaled ? param.setNormalized(Number(event.target.value)) : param.set(Number(event.target.value)))}
      onDoubleClick={() => model && param.set(model.defaultValue)}
    />
  );
}

/** A checkbox for boolean parameters. */
export function Toggle({ plugin, id, className }: ControlProps) {
  const param = useParameter(plugin, id);
  return <input type="checkbox" className={className} disabled={!param.model} checked={param.value >= 0.5} aria-label={param.model?.label ?? id} onChange={(event) => param.set(event.target.checked ? 1 : 0)} />;
}

/** A dropdown for enum parameters. */
export function Select({ plugin, id, className }: ControlProps) {
  const param = useParameter(plugin, id);
  return (
    <select className={className} disabled={!param.model} value={param.value} aria-label={param.model?.label ?? id} onChange={(event) => param.set(Number(event.target.value))}>
      {(param.model?.options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A number input for integer parameters. */
export function Stepper({ plugin, id, className }: ControlProps) {
  const param = useParameter(plugin, id);
  const model = param.model;
  return (
    <input
      type="number"
      className={className}
      disabled={!model}
      min={model?.min}
      max={model?.max}
      step={model?.step ?? 1}
      value={param.value}
      aria-label={model?.label ?? id}
      onChange={(event) => {
        const v = Number(event.target.value);
        if (Number.isFinite(v)) param.set(v);
      }}
    />
  );
}

/**
 * Label, the control that fits the parameter's kind (knob, slider, stepper,
 * toggle or select), and the formatted value, in a row styled like the
 * default panel. Pass `label={false}` to render the control alone.
 */
export function ParameterControl({ plugin, id, className, label = true }: ControlProps & { label?: boolean }) {
  useDefaultStyles();
  const param = useParameter(plugin, id);
  const model = param.model;
  const control =
    model?.kind === "knob" ? <Knob plugin={plugin} id={id} /> : model?.kind === "toggle" ? <Toggle plugin={plugin} id={id} /> : model?.kind === "select" ? <Select plugin={plugin} id={id} /> : model?.kind === "stepper" ? <Stepper plugin={plugin} id={id} /> : <Slider plugin={plugin} id={id} />;
  if (!label) return control;
  return (
    <div className={className ? `as-control ${className}` : "as-control"} data-parameter={id}>
      <label className="as-control__label" title={model?.description}>
        {model?.label ?? id}
      </label>
      {control}
      <span className="as-control__value">{param.format(param.value)}</span>
    </div>
  );
}

/** One row per parameter, in manifest order. */
export function ParameterControls({ plugin, className }: { plugin: AnyPluginHandle; className?: string }) {
  useDefaultStyles();
  return (
    <div className={className ? `as-panel__controls ${className}` : "as-panel__controls"}>
      {(plugin.descriptor?.parameters ?? []).map((p) => (
        <ParameterControl key={p.id} plugin={plugin} id={p.id} />
      ))}
    </div>
  );
}

/** A meter for one output, with its formatted value. */
export function Meter({ plugin, id, className }: ControlProps) {
  useDefaultStyles();
  const output = useOutput(plugin, id);
  const model = output.model;
  const min = model?.min ?? 0;
  const max = model?.max ?? 1;
  return (
    <div className={className ? `as-output ${className}` : "as-output"} data-output={id}>
      <span className="as-output__label" title={model?.description}>
        {model?.label ?? id}
      </span>
      <meter className="as-output__meter" min={min} max={max} value={Math.min(max, Math.max(min, output.value))} aria-label={model?.label ?? id} />
      <span className="as-output__value">{output.format(output.value)}</span>
    </div>
  );
}

/** One meter per output, in manifest order. */
export function Meters({ plugin, className }: { plugin: AnyPluginHandle; className?: string }) {
  useDefaultStyles();
  return (
    <div className={className ? `as-panel__outputs ${className}` : "as-panel__outputs"}>
      {(plugin.descriptor?.outputs ?? []).map((o) => (
        <Meter key={o.id} plugin={plugin} id={o.id} />
      ))}
    </div>
  );
}

/** A dropdown of the plugin's presets; choosing one loads it. */
export function PresetSelect({ plugin, className, placeholder = "Preset…" }: { plugin: AnyPluginHandle; className?: string; placeholder?: string }) {
  useDefaultStyles();
  const presets = plugin.descriptor?.presets ?? [];
  return (
    <select
      className={className ? `as-panel__presets ${className}` : "as-panel__presets"}
      aria-label="Preset"
      disabled={presets.length === 0}
      defaultValue=""
      onChange={(event) => {
        if (event.target.value) void plugin.loadPreset(event.target.value as never);
      }}
    >
      <option value="">{placeholder}</option>
      {presets.map((preset) => (
        <option key={preset.id} value={preset.id}>
          {preset.name}
        </option>
      ))}
    </select>
  );
}

/** A pressed-state toggle button for host-side bypass. */
export function BypassButton({ plugin, className, children = "Bypass" }: { plugin: AnyPluginHandle; className?: string; children?: React.ReactNode }) {
  useDefaultStyles();
  return (
    <button type="button" className={className ? `as-panel__bypass ${className}` : "as-panel__bypass"} aria-pressed={plugin.bypassed} disabled={!plugin.plugin} onClick={() => plugin.setBypassed(!plugin.bypassed)}>
      {children}
    </button>
  );
}
