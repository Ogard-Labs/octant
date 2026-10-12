import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";

/** What a person calls a plugin whose name the host could not read. */
export const UNNAMED_PLUGIN = "A plugin";

/**
 * The plugin's own name, as its package declares it. A prompt or a remembered
 * approval carries identifiers only, so the name comes from the installed
 * package list; a package that is gone or unnamed has none.
 */
export function pluginNameIn(
  snapshot: ExtensionSnapshot | undefined,
  packageId: string,
): string | undefined {
  const found = snapshot?.packages?.find((entry) => String(entry.packageId) === packageId);
  return found?.displayName ?? (found?.slug === undefined ? undefined : String(found.slug));
}

/** The MCP server component's name inside one installed package. */
export function serverNameIn(
  snapshot: ExtensionSnapshot | undefined,
  packageId: string,
  componentId: string,
): string | undefined {
  const found = snapshot?.packages?.find((entry) => String(entry.packageId) === packageId);
  return found?.components?.find((entry) => String(entry.component.id) === componentId)?.component
    .displayName;
}
