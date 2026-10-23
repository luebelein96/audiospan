export const PANEL_STYLES = `
.as-panel { font: 13px/1.4 system-ui, sans-serif; color: #e8e8ec; background: #1d1f26; border: 1px solid #2d3039; border-radius: 8px; padding: 12px; display: grid; gap: 10px; min-width: 240px; box-sizing: border-box; }
.as-panel * { box-sizing: border-box; }
.as-panel__header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.as-panel__title { font-weight: 600; font-size: 14px; }
.as-panel__vendor { color: #9a9fb0; font-size: 12px; }
.as-panel__toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.as-panel__status { font-size: 12px; color: #9a9fb0; }
.as-panel__status[data-status="error"] { color: #ff7b72; }
.as-panel__status[data-status="disposed"] { color: #6b6f7d; }
.as-panel__controls { display: grid; gap: 8px; }
.as-control { display: grid; grid-template-columns: minmax(80px, 1fr) 2fr auto; align-items: center; gap: 8px; }
.as-control__label { color: #c8ccd8; }
.as-control__value { font-variant-numeric: tabular-nums; color: #9a9fb0; min-width: 64px; text-align: right; }
.as-control input[type="range"] { width: 100%; accent-color: #6ea8fe; }
.as-control input[type="number"], .as-control select { width: 100%; background: #12141a; color: inherit; border: 1px solid #2d3039; border-radius: 4px; padding: 3px 6px; font: inherit; }
.as-panel button { background: #2a2d37; color: inherit; border: 1px solid #3a3e4b; border-radius: 4px; padding: 4px 10px; font: inherit; cursor: pointer; }
.as-panel button[aria-pressed="true"] { background: #6ea8fe; color: #0c1220; border-color: #6ea8fe; }
.as-panel button:disabled { opacity: .5; cursor: default; }
.as-panel__outputs { display: grid; gap: 6px; }
.as-output { display: grid; grid-template-columns: minmax(80px, 1fr) 2fr auto; align-items: center; gap: 8px; }
.as-output__label { color: #c8ccd8; }
.as-output__meter { width: 100%; height: 10px; }
.as-output__value { font-variant-numeric: tabular-nums; color: #9a9fb0; min-width: 64px; text-align: right; }
.as-knob { width: 44px; height: 44px; cursor: ns-resize; touch-action: none; justify-self: center; outline: none; }
.as-knob:focus-visible { outline: 2px solid #6ea8fe; border-radius: 50%; }
.as-knob__track { fill: none; stroke: #3a3e4b; stroke-width: 4; stroke-linecap: round; }
.as-knob__fill { fill: none; stroke: #6ea8fe; stroke-width: 4; stroke-linecap: round; }
.as-knob__pointer { stroke: #e8e8ec; stroke-width: 2; stroke-linecap: round; }
.as-panel[data-disabled="true"] .as-panel__controls { opacity: .5; pointer-events: none; }
`;

const STYLE_ID = "audiospan-ui-styles";

/** Inject the default stylesheet once per document. Safe to call repeatedly. */
export function injectStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANEL_STYLES;
  (doc.head ?? doc.documentElement).appendChild(style);
}
