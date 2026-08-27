import type { ComponentType } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import GitHubSettingsSectionModule from "../settings/GitHubSettingsSectionModule";

/**
 * Host surface props passed to every plugin-loaded settings section. A section
 * module pulls only the clients it needs; unknown props are ignored.
 */
export interface PluginSettingsSectionProps {
  readonly githubClient?: GithubClient | undefined;
}

export type PluginSettingsSectionModule = ComponentType<PluginSettingsSectionProps>;

export type PluginSettingsSectionModuleResult =
  | { readonly kind: "ready"; readonly module: PluginSettingsSectionModule }
  | { readonly kind: "unknown"; readonly entryPoint: string };

const builtInSettingsSectionModules: ReadonlyMap<string, PluginSettingsSectionModule> = new Map([
  ["builtin:github/settings", GitHubSettingsSectionModule],
]);

/**
 * Returns a plugin settings-section module by its entry point. Unknown entry
 * points are reported as a discriminated result so the renderer can show an
 * error state rather than a blank panel.
 */
export function loadPluginSettingsSectionModule(
  entryPoint: string,
): PluginSettingsSectionModuleResult {
  const module = builtInSettingsSectionModules.get(entryPoint);
  if (module === undefined) {
    return { kind: "unknown", entryPoint };
  }
  return { kind: "ready", module };
}

/**
 * Returns whether the given string is a registered plugin settings-section
 * entry point. Only own keys of the registry are considered.
 */
export function isPluginSettingsSectionEntryPoint(entryPoint: string): boolean {
  return builtInSettingsSectionModules.has(entryPoint);
}
