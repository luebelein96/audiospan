import type { PluginInstance } from "@audiospan/sdk";
import { renderPluginPanel, type PanelOptions } from "@audiospan/ui";
import { useEffect, useRef } from "react";

export interface PluginPanelProps extends Omit<PanelOptions, "className"> {
  /** The instance to render; nothing is rendered while null. */
  plugin: PluginInstance | null;
  /** Class name of the wrapping element this component owns. */
  className?: string;
  /** Extra class name for the panel's own root element (`PanelOptions.className`). */
  panelClassName?: string;
}

/**
 * The default control panel (knobs, meters, presets, bypass, status) as a
 * React component. Rendering is delegated to `@audiospan/ui`; the component
 * only owns the container element and the panel's lifetime.
 */
export function PluginPanel({ plugin, className, panelClassName, header, bypass, reset, presets, status, injectStyles, onError }: PluginPanelProps) {
  const container = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    const element = container.current;
    if (!plugin || !element) return;
    const options: PanelOptions = {
      ...(header !== undefined ? { header } : {}),
      ...(bypass !== undefined ? { bypass } : {}),
      ...(reset !== undefined ? { reset } : {}),
      ...(presets !== undefined ? { presets } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(injectStyles !== undefined ? { injectStyles } : {}),
      ...(panelClassName !== undefined ? { className: panelClassName } : {}),
      onError: (error) => onErrorRef.current?.(error),
    };
    const handle = renderPluginPanel(element, plugin, options);
    return () => handle.destroy();
  }, [plugin, header, bypass, reset, presets, status, injectStyles, panelClassName]);
  return <div ref={container} className={className} />;
}
