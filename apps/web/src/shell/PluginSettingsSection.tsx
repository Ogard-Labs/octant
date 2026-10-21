import {
  loadPluginSettingsSectionModule,
  type PluginSettingsSectionProps,
} from "./pluginModuleRegistry";
import { OctantAlert } from "../ui/base/OctantAlert";

interface PluginSettingsSectionPropsWithEntryPoint extends PluginSettingsSectionProps {
  readonly entryPoint: string;
}

/**
 * Renders a plugin-contributed settings section by entry point. The registry
 * lookup returns a discriminated result, so an unknown entry point renders an
 * explicit error state instead of throwing.
 */
export function PluginSettingsSection(props: PluginSettingsSectionPropsWithEntryPoint) {
  const result = loadPluginSettingsSectionModule(props.entryPoint);
  if (result.kind === "unknown") {
    return (
      <section aria-label="Settings section error">
        <OctantAlert tone="warning">
          Unknown plugin settings-section entry point: {result.entryPoint}
        </OctantAlert>
      </section>
    );
  }
  const Module = result.module;
  const { entryPoint: _entryPoint, ...moduleProps } = props;
  return <Module {...moduleProps} />;
}
