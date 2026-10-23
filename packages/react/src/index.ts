// One install for React apps: the hooks and components below, plus everything from the SDK and the UI package.
export * from "@audiospan/sdk";
export * from "@audiospan/ui";

export { useAudiospanHost, type AudiospanHostHandle, type AudiospanHostStatus, type UseAudiospanHostOptions } from "./useAudiospanHost.js";
export { usePlugin, type OutputIdOf, type ParameterIdOf, type PluginHandle, type PluginStatus, type PresetIdOf } from "./usePlugin.js";
export { useAudioSource, resolveAudioSource, type AudioSourceHandle, type AudioSourceInput, type AudioSourceStatus, type ResolvedSource, type UseAudioSourceOptions } from "./useAudioSource.js";
export { PluginPanel, type PluginPanelProps } from "./PluginPanel.js";
export {
  BypassButton,
  Knob,
  Meter,
  Meters,
  ParameterControl,
  ParameterControls,
  PresetSelect,
  Select,
  Slider,
  Stepper,
  Toggle,
  useOutput,
  useParameter,
  type AnyPluginHandle,
  type ControlProps,
  type ParameterHandle,
} from "./controls.js";
