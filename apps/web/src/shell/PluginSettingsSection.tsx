import { useState } from "react";
import {
  loadPluginSettingsSectionModule,
  type PluginSettingsSectionProps,
} from "./pluginModuleRegistry";

interface PluginSettingsSectionPropsWithEntryPoint extends PluginSettingsSectionProps {
  readonly entryPoint: string;
}

type LoadState =
  | { readonly kind: "ready"; readonly Module: React.ComponentType<PluginSettingsSectionProps> }
  | { readonly kind: "error"; readonly message: string };

/**
 * Renders a plugin-contributed settings section by entry point. The registry
 * lookup returns a discriminated result, so an unknown entry point renders an
 * explicit error state instead of throwing.
 */
export function PluginSettingsSection(props: PluginSettingsSectionPropsWithEntryPoint) {
  const [state] = useState<LoadState>(() => {
    const result = loadPluginSettingsSectionModule(props.entryPoint);
    if (result.kind === "unknown") {
      return {
        kind: "error",
        message: `Unknown plugin settings-section entry point: ${result.entryPoint}`,
      } as const;
    }
    return { kind: "ready", Module: result.module } as const;
  });

  if (state.kind === "error") {
    return (
      <section aria-label="Settings section error">
        <p role="alert">{state.message}</p>
      </section>
    );
  }
  const Module = state.Module;
  const { entryPoint: _entryPoint, ...moduleProps } = props;
  return <Module {...moduleProps} />;
}
