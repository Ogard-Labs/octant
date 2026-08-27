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

const builtInSettingsSectionModules: Readonly<Record<string, PluginSettingsSectionModule>> = {
  "builtin:github/settings": GitHubSettingsSectionModule,
};

/**
 * Returns a plugin settings-section module by its entry point. Throws for
 * unknown entry points so the renderer can render an error boundary rather
 * than a blank panel.
 */
export function loadPluginSettingsSectionModule(entryPoint: string): PluginSettingsSectionModule {
  const module = builtInSettingsSectionModules[entryPoint];
  if (module === undefined) {
    throw new Error(`Unknown plugin settings-section entry point: ${entryPoint}`);
  }
  return module;
}

export function isPluginSettingsSectionEntryPoint(entryPoint: string): boolean {
  return entryPoint in builtInSettingsSectionModules;
}
