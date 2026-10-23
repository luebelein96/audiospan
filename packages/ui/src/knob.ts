import type { ControlModel } from "./model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
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

export interface KnobHandle {
  element: SVGSVGElement;
  setValue(value: number): void;
  destroy(): void;
}

/** A small accessible rotary control: drag vertically, arrow keys, double-click to reset. */
export function createKnob(doc: Document, model: ControlModel, onInput: (value: number) => void): KnobHandle {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 44 44");
  svg.setAttribute("class", "as-knob");
  svg.setAttribute("role", "slider");
  svg.setAttribute("tabindex", "0");
  svg.setAttribute("aria-label", model.label);
  svg.setAttribute("aria-valuemin", String(model.min));
  svg.setAttribute("aria-valuemax", String(model.max));
  const track = doc.createElementNS(SVG_NS, "path");
  track.setAttribute("class", "as-knob__track");
  track.setAttribute("d", arcPath(22, 22, 16, START_ANGLE, START_ANGLE + SWEEP));
  const fill = doc.createElementNS(SVG_NS, "path");
  fill.setAttribute("class", "as-knob__fill");
  const pointer = doc.createElementNS(SVG_NS, "line");
  pointer.setAttribute("class", "as-knob__pointer");
  svg.append(track, fill, pointer);

  // Bipolar controls fill from their rest position (zero, or the centre) instead of from the minimum.
  const restNormalized = model.bipolar ? (model.min < 0 && model.max > 0 ? model.toNormalized(0) : 0.5) : 0;
  const restAngle = START_ANGLE + restNormalized * SWEEP;
  let current = model.defaultValue;
  const render = (value: number) => {
    current = value;
    const n = model.toNormalized(value);
    const angle = START_ANGLE + n * SWEEP;
    fill.setAttribute("d", angle >= restAngle ? arcPath(22, 22, 16, restAngle, angle) : arcPath(22, 22, 16, angle, restAngle));
    const [x1, y1] = polar(22, 22, 6, angle);
    const [x2, y2] = polar(22, 22, 14, angle);
    pointer.setAttribute("x1", x1.toFixed(2));
    pointer.setAttribute("y1", y1.toFixed(2));
    pointer.setAttribute("x2", x2.toFixed(2));
    pointer.setAttribute("y2", y2.toFixed(2));
    svg.setAttribute("aria-valuenow", String(value));
    svg.setAttribute("aria-valuetext", model.format(value));
  };
  render(current);

  let dragStartY = 0;
  let dragStartNormalized = 0;
  let dragging = false;
  const onPointerDown = (event: PointerEvent) => {
    dragging = true;
    dragStartY = event.clientY;
    dragStartNormalized = model.toNormalized(current);
    svg.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    const delta = (dragStartY - event.clientY) / (event.shiftKey ? 1200 : 200);
    onInput(model.fromNormalized(dragStartNormalized + delta));
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const n = model.toNormalized(current);
    const fine = event.shiftKey ? 0.002 : 0.02;
    let next: number | undefined;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = model.fromNormalized(n + fine);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = model.fromNormalized(n - fine);
        break;
      case "Home":
        next = model.min;
        break;
      case "End":
        next = model.max;
        break;
      default:
        return;
    }
    event.preventDefault();
    onInput(next);
  };
  const onDoubleClick = () => onInput(model.defaultValue);

  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerUp);
  svg.addEventListener("keydown", onKeyDown);
  svg.addEventListener("dblclick", onDoubleClick);

  return {
    element: svg,
    setValue: render,
    destroy() {
      svg.removeEventListener("pointerdown", onPointerDown);
      svg.removeEventListener("pointermove", onPointerMove);
      svg.removeEventListener("pointerup", onPointerUp);
      svg.removeEventListener("pointercancel", onPointerUp);
      svg.removeEventListener("keydown", onKeyDown);
      svg.removeEventListener("dblclick", onDoubleClick);
    },
  };
}
