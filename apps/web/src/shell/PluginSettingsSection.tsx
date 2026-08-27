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

export function PluginSettingsSection(props: PluginSettingsSectionPropsWithEntryPoint) {
  const [state] = useState<LoadState>(() => {
    try {
      const Module = loadPluginSettingsSectionModule(props.entryPoint);
      return { kind: "ready", Module } as const;
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to load settings section.",
      } as const;
    }
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
