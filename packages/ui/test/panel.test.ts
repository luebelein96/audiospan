// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderPluginPanel } from "../src/index.js";
import { MockPlugin } from "./mock-plugin.js";

describe("renderPluginPanel", () => {
  it("renders header, toolbar, one control per parameter, and status", () => {
    const plugin = new MockPlugin();
    const container = document.createElement("div");
    const panel = renderPluginPanel(container, plugin);
    expect(container.querySelector(".as-panel__title")?.textContent).toBe("Gain");
    expect(container.querySelector(".as-panel__vendor")?.textContent).toBe("Example Audio");
    expect(container.querySelectorAll(".as-control")).toHaveLength(4);
    expect(container.querySelector('[data-parameter="gain"] svg.as-knob')).not.toBeNull();
    expect(container.querySelector('[data-parameter="mode"] select')).not.toBeNull();
    expect(container.querySelector('[data-parameter="stages"] input[type="number"]')).not.toBeNull();
    expect(container.querySelector('[data-parameter="enabled"] input[type="checkbox"]')).not.toBeNull();
    expect(container.querySelector(".as-panel__status")?.textContent).toBe("Ready");
    expect(container.querySelectorAll(".as-panel__presets option")).toHaveLength(2);
    expect(document.getElementById("audiospan-ui-styles")).not.toBeNull();
    panel.destroy();
    expect(container.childElementCount).toBe(0);
    expect(plugin.listenerCount()).toBe(0);
  });

  it("forwards user input to the plugin and reflects plugin events", async () => {
    const plugin = new MockPlugin();
    const container = document.createElement("div");
    renderPluginPanel(container, plugin, { injectStyles: false });
    const select = container.querySelector<HTMLSelectElement>('[data-parameter="mode"] select')!;
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    expect(plugin.calls).toContain("set:mode=1");
    expect(container.querySelector('[data-parameter="mode"] .as-control__value')?.textContent).toBe("Warm");

    const checkbox = container.querySelector<HTMLInputElement>('[data-parameter="enabled"] input')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect(plugin.getParameter("enabled")).toBe(0);
    expect(container.querySelector('[data-parameter="enabled"] .as-control__value')?.textContent).toBe("Off");

    const knob = container.querySelector<SVGSVGElement>('[data-parameter="gain"] svg')!;
    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(plugin.getParameter("gain")).toBe(2);
    expect(knob.getAttribute("aria-valuenow")).toBe("2");
    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(plugin.getParameter("gain")).toBe(0);

    // External changes update the display without user input.
    plugin.setParameter("gain", 0.75);
    expect(container.querySelector('[data-parameter="gain"] .as-control__value')?.textContent).toBe("0.75");

    const bypass = container.querySelector<HTMLButtonElement>(".as-panel__bypass")!;
    bypass.click();
    expect(plugin.isBypassed()).toBe(true);
    expect(bypass.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".as-panel__status")?.textContent).toBe("Bypassed");

    container.querySelector<HTMLButtonElement>(".as-panel__reset")!.click();
    expect(plugin.calls).toContain("reset");
    expect(plugin.getParameter("gain")).toBe(1);

    const presets = container.querySelector<HTMLSelectElement>(".as-panel__presets")!;
    presets.value = "half";
    presets.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(plugin.calls).toContain("preset:half");
    expect(plugin.getParameter("gain")).toBe(0.5);

    await plugin.dispose();
    expect(container.querySelector(".as-panel__status")?.textContent).toBe("Disposed");
    expect(container.querySelector<HTMLElement>(".as-panel")!.dataset["disabled"]).toBe("true");
  });

  it("renders outputs as meters and reflects output and latency updates", () => {
    const plugin = new MockPlugin();
    const container = document.createElement("div");
    renderPluginPanel(container, plugin, { injectStyles: false });
    const row = container.querySelector<HTMLElement>('[data-output="level"]')!;
    expect(row).not.toBeNull();
    const meter = row.querySelector("meter")!;
    expect(meter.getAttribute("min")).toBe("0");
    expect(meter.getAttribute("max")).toBe("2");
    expect(meter.getAttribute("value")).toBe("0");
    expect(row.querySelector(".as-output__value")?.textContent).toBe("0.00");
    plugin.pushOutputs({ level: 1.5 });
    expect(meter.getAttribute("value")).toBe("1.5");
    expect(row.querySelector(".as-output__value")?.textContent).toBe("1.50");
    plugin.pushOutputs({ level: 9 }); // clamped on the meter, exact in the text
    expect(meter.getAttribute("value")).toBe("2");
    expect(row.querySelector(".as-output__value")?.textContent).toBe("9.00");
    expect(container.querySelector(".as-panel__status")?.textContent).toBe("Ready");
    plugin.setLatency(64);
    expect(container.querySelector(".as-panel__status")?.textContent).toBe("Ready (latency 64 frames)");
  });

  it("drives logarithmic sliders in normalized space and fills bipolar knobs from their rest position", () => {
    const manifest = {
      schemaVersion: 1, id: "com.example.scaled", name: "Scaled", version: "0.1.0",
      entry: { wasm: "module.wasm", abi: "audiospan-c" },
      audio: { inputs: [{ id: "in", name: "In", channels: { min: 1, max: 2 } }], outputs: [{ id: "out", name: "Out", channels: { min: 1, max: 2 } }] },
      parameters: [
        { id: "freq", name: "Freq", type: "float", min: 20, max: 20000, default: 1000, scale: "logarithmic", display: { style: "slider", format: "hertz", precision: 0 } },
        { id: "pan", name: "Pan", type: "float", min: -1, max: 1, default: 0, display: { style: "knob", bipolar: true } },
      ],
    };
    const plugin = new MockPlugin(manifest);
    const container = document.createElement("div");
    renderPluginPanel(container, plugin, { injectStyles: false });
    const slider = container.querySelector<HTMLInputElement>('[data-parameter="freq"] input[type="range"]')!;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("1");
    expect(Number(slider.value)).toBeCloseTo(Math.log(1000 / 20) / Math.log(1000), 6);
    slider.value = "0.5";
    slider.dispatchEvent(new Event("input"));
    expect(plugin.getParameter("freq")).toBeCloseTo(632.4555, 3); // geometric midpoint of 20..20000
    expect(container.querySelector('[data-parameter="freq"] .as-control__value')?.textContent).toBe("632 Hz");
    plugin.setParameter("freq", 200);
    expect(Number(slider.value)).toBeCloseTo(1 / 3, 6);

    const fill = container.querySelector<SVGPathElement>('[data-parameter="pan"] .as-knob__fill')!;
    expect(fill.getAttribute("d")).toBe(""); // at rest (0) nothing is filled
    plugin.setParameter("pan", 1);
    const right = fill.getAttribute("d")!;
    expect(right.length).toBeGreaterThan(0);
    plugin.setParameter("pan", -1);
    const left = fill.getAttribute("d")!;
    expect(left.length).toBeGreaterThan(0);
    expect(left).not.toBe(right);
  });

  it("reports preset failures in the status line or via onError", async () => {
    const plugin = new MockPlugin();
    plugin.descriptor.presets.push({ id: "boom", name: "Boom", state: plugin.descriptor.presets[0]!.state });
    const container = document.createElement("div");
    const errors: Error[] = [];
    renderPluginPanel(container, plugin, { injectStyles: false, onError: (e) => errors.push(e) });
    const presets = container.querySelector<HTMLSelectElement>(".as-panel__presets")!;
    presets.value = "boom";
    presets.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => e.message)).toEqual(["kaboom"]);
  });
});
