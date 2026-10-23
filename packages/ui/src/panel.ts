import type { PluginInstance, Unsubscribe } from "@audiospan/sdk";
import { createKnob } from "./knob.js";
import { createControlModels, createOutputModels, type ControlModel, type OutputModel } from "./model.js";
import { injectStyles } from "./styles.js";

export interface PanelOptions {
  /** Show plugin name and vendor (default true). */
  header?: boolean;
  /** Show the bypass toggle (default true). */
  bypass?: boolean;
  /** Show the "Reset" button that restores parameter defaults (default true). */
  reset?: boolean;
  /** Show the preset selector when the plugin ships presets (default true). */
  presets?: boolean;
  /** Show the status line (default true). */
  status?: boolean;
  /** Inject the default stylesheet into the document (default true). */
  injectStyles?: boolean;
  /** Extra class name for the root element. */
  className?: string;
  /** Called when an asynchronous action (preset load) fails. Defaults to the status line. */
  onError?: (error: Error) => void;
}

export interface PanelHandle {
  readonly element: HTMLElement;
  /** Re-read every value from the plugin instance. Normally unnecessary: the panel subscribes to instance events. */
  refresh(): void;
  /** Remove the panel from the DOM and unsubscribe from the plugin. */
  destroy(): void;
}

interface ControlBinding {
  model: ControlModel;
  setValue(value: number): void;
  destroy(): void;
}

interface OutputBinding {
  model: OutputModel;
  meter: HTMLElement;
  value: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildControl(doc: Document, model: ControlModel, plugin: PluginInstance): { row: HTMLElement; binding: ControlBinding } {
  const row = el(doc, "div", "as-control");
  row.dataset["parameter"] = model.parameterId;
  const label = el(doc, "label", "as-control__label", model.label);
  if (model.description) label.title = model.description;
  const value = el(doc, "span", "as-control__value");
  const inputId = `as-${plugin.id}-${model.parameterId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  label.htmlFor = inputId;
  const set = (v: number) => {
    try {
      plugin.setParameter(model.parameterId, v);
    } catch {
      // Disposed or invalid; the status line reflects it.
    }
  };
  let binding: ControlBinding;
  switch (model.kind) {
    case "toggle": {
      const input = el(doc, "input");
      input.type = "checkbox";
      input.id = inputId;
      input.addEventListener("change", () => set(input.checked ? 1 : 0));
      row.append(label, input, value);
      binding = { model, setValue: (v) => ((input.checked = v >= 0.5), (value.textContent = model.format(v))), destroy: () => {} };
      break;
    }
    case "select": {
      const select = el(doc, "select");
      select.id = inputId;
      for (const option of model.options) {
        const o = el(doc, "option", undefined, option.label);
        o.value = String(option.value);
        select.appendChild(o);
      }
      select.addEventListener("change", () => set(Number(select.value)));
      row.append(label, select, value);
      binding = { model, setValue: (v) => ((select.value = String(v)), (value.textContent = model.format(v))), destroy: () => {} };
      break;
    }
    case "stepper": {
      const input = el(doc, "input");
      input.type = "number";
      input.id = inputId;
      input.min = String(model.min);
      input.max = String(model.max);
      input.step = String(model.step);
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) set(v);
      });
      row.append(label, input, value);
      binding = { model, setValue: (v) => ((input.value = String(v)), (value.textContent = model.format(v))), destroy: () => {} };
      break;
    }
    case "knob": {
      const knob = createKnob(doc, model, set);
      knob.element.id = inputId;
      row.append(label, knob.element, value);
      binding = { model, setValue: (v) => (knob.setValue(v), (value.textContent = model.format(v))), destroy: () => knob.destroy() };
      break;
    }
    case "slider":
    default: {
      // Scaled parameters (logarithmic or skewed) drive the slider in normalized space so the travel follows the curve.
      const input = el(doc, "input");
      input.type = "range";
      input.id = inputId;
      const scaled = model.scaled;
      input.min = scaled ? "0" : String(model.min);
      input.max = scaled ? "1" : String(model.max);
      input.step = scaled ? "0.001" : String(model.step);
      input.addEventListener("input", () => set(scaled ? model.fromNormalized(Number(input.value)) : Number(input.value)));
      input.addEventListener("dblclick", () => set(model.defaultValue));
      row.append(label, input, value);
      binding = {
        model,
        setValue: (v) => {
          input.value = String(scaled ? model.toNormalized(v) : v);
          input.setAttribute("aria-valuetext", model.format(v));
          value.textContent = model.format(v);
        },
        destroy: () => {},
      };
      break;
    }
  }
  return { row, binding };
}

/**
 * Render a complete control panel for a plugin instance from its manifest
 * metadata: title, bypass, reset, presets, status, and one control per
 * parameter. Framework-agnostic; works with any DOM.
 */
export function renderPluginPanel(container: HTMLElement, plugin: PluginInstance, options: PanelOptions = {}): PanelHandle {
  const doc = container.ownerDocument;
  if (options.injectStyles !== false) injectStyles(doc);
  const root = el(doc, "div", `as-panel${options.className ? ` ${options.className}` : ""}`);
  root.dataset["plugin"] = plugin.descriptor.id;
  root.dataset["instance"] = plugin.id;
  const subscriptions: Unsubscribe[] = [];
  const bindings: ControlBinding[] = [];
  const { descriptor } = plugin;

  if (options.header !== false) {
    const header = el(doc, "div", "as-panel__header");
    header.append(el(doc, "span", "as-panel__title", descriptor.name));
    if (descriptor.vendor) header.append(el(doc, "span", "as-panel__vendor", descriptor.vendor));
    root.append(header);
  }

  const toolbar = el(doc, "div", "as-panel__toolbar");
  let bypassButton: HTMLButtonElement | undefined;
  if (options.bypass !== false) {
    bypassButton = el(doc, "button", "as-panel__bypass", "Bypass");
    bypassButton.type = "button";
    bypassButton.setAttribute("aria-pressed", String(plugin.isBypassed()));
    bypassButton.addEventListener("click", () => {
      try {
        plugin.setBypassed(!plugin.isBypassed());
      } catch {
        // disposed
      }
    });
    toolbar.append(bypassButton);
  }
  if (options.reset !== false) {
    const resetButton = el(doc, "button", "as-panel__reset", "Reset");
    resetButton.type = "button";
    resetButton.addEventListener("click", () => {
      try {
        plugin.resetParameters();
      } catch {
        // disposed
      }
    });
    toolbar.append(resetButton);
  }
  let presetSelect: HTMLSelectElement | undefined;
  if (options.presets !== false && descriptor.presets.length > 0) {
    presetSelect = el(doc, "select", "as-panel__presets");
    presetSelect.setAttribute("aria-label", "Preset");
    const placeholder = el(doc, "option", undefined, "Preset…");
    placeholder.value = "";
    presetSelect.append(placeholder);
    for (const preset of descriptor.presets) {
      const o = el(doc, "option", undefined, preset.name);
      o.value = preset.id;
      presetSelect.append(o);
    }
    presetSelect.addEventListener("change", () => {
      const id = presetSelect!.value;
      if (!id) return;
      plugin.loadPreset(id).catch((error: Error) => {
        if (options.onError) options.onError(error);
        else setStatus(`Preset failed: ${error.message}`, "error");
      });
    });
    toolbar.append(presetSelect);
  }
  if (toolbar.childElementCount > 0) root.append(toolbar);

  const controls = el(doc, "div", "as-panel__controls");
  for (const model of createControlModels(descriptor)) {
    const { row, binding } = buildControl(doc, model, plugin);
    controls.append(row);
    bindings.push(binding);
  }
  root.append(controls);

  // Read-only outputs (meters, gain reduction) as <meter> rows, refreshed from the `outputs` event.
  const outputBindings: OutputBinding[] = [];
  const outputModels = createOutputModels(descriptor);
  if (outputModels.length > 0) {
    const outputsEl = el(doc, "div", "as-panel__outputs");
    for (const model of outputModels) {
      const row = el(doc, "div", "as-output");
      row.dataset["output"] = model.outputId;
      const label = el(doc, "span", "as-output__label", model.label);
      if (model.description) label.title = model.description;
      const meter = el(doc, "meter", "as-output__meter");
      meter.setAttribute("min", String(model.min));
      meter.setAttribute("max", String(model.max));
      meter.setAttribute("value", String(model.min));
      meter.setAttribute("aria-label", model.label);
      const valueEl = el(doc, "span", "as-output__value", model.format(model.min));
      row.append(label, meter, valueEl);
      outputsEl.append(row);
      outputBindings.push({ model, meter, value: valueEl });
    }
    root.append(outputsEl);
  }
  const applyOutputs = (values: Readonly<Record<string, number>>) => {
    for (const b of outputBindings) {
      const v = values[b.model.outputId];
      if (v === undefined) continue;
      b.meter.setAttribute("value", String(Math.min(b.model.max, Math.max(b.model.min, v))));
      b.value.textContent = b.model.format(v);
    }
  };

  const status = el(doc, "div", "as-panel__status");
  status.setAttribute("role", "status");
  const setStatus = (text: string, kind: string) => {
    status.textContent = text;
    status.dataset["status"] = kind;
    root.dataset["disabled"] = String(kind === "disposed");
  };
  if (options.status !== false) root.append(status);

  const refresh = () => {
    for (const b of bindings) {
      try {
        b.setValue(plugin.getParameter(b.model.parameterId));
      } catch {
        // disposed
      }
    }
    if (outputBindings.length > 0) {
      try {
        applyOutputs(plugin.getOutputs());
      } catch {
        // disposed
      }
    }
    bypassButton?.setAttribute("aria-pressed", String(plugin.isBypassed()));
    const s = plugin.status;
    const latency = plugin.latencyFrames;
    const ready = plugin.isBypassed() ? "Bypassed" : latency > 0 ? `Ready (latency ${latency} frames)` : "Ready";
    setStatus(s === "ready" ? ready : s === "error" ? "Error: processing failed; reset to retry" : s === "disposed" ? "Disposed" : "Loading…", s);
  };

  subscriptions.push(
    plugin.on("parameterchange", (e) => {
      const b = bindings.find((x) => x.model.parameterId === e.parameterId);
      b?.setValue(e.value);
    }),
    plugin.on("outputs", (e) => applyOutputs(e.values)),
    plugin.on("latencychange", () => refresh()),
    plugin.on("bypasschange", () => refresh()),
    plugin.on("statechange", (e) => {
      refresh();
      if (e.reason === "preset" && presetSelect) presetSelect.value = e.presetId ?? "";
    }),
    plugin.on("statuschange", () => refresh()),
    plugin.on("error", (e) => setStatus(`Error: ${e.error.message}`, "error")),
  );
  refresh();
  container.append(root);

  return {
    element: root,
    refresh,
    destroy() {
      for (const off of subscriptions.splice(0)) off();
      for (const b of bindings.splice(0)) b.destroy();
      root.remove();
    },
  };
}
