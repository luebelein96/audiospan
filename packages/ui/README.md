# @audiospan/ui

Framework-agnostic default controls generated from plugin metadata.

```ts
import { renderPluginPanel, createControlModels } from "@audiospan/ui";
const panel = renderPluginPanel(container, plugin);   // header, bypass, reset, presets, controls, status
panel.destroy();
const models = createControlModels(descriptor);       // pure data for your own React/Vue/Svelte controls
```

Controls: slider or knob (float, with logarithmic and skewed travel and bipolar fills), stepper (integer), toggle (boolean), select (enum); a meter per manifest output. React users: `@audiospan/react` wraps this in `<PluginPanel>`. Styles are injected once (`injectStyles`) and can be disabled with `{ injectStyles: false }`.
