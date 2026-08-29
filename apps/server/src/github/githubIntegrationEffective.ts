import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { resolveExtensionActivation } from "@octant/plugin-host/activation";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";

const GITHUB_INTEGRATION_COMPONENT_ID = "github-integration";

const emptyGithubReadToolSet: AppManagedToolSet = {
  definitions: [],
  execute: async () => ({ result: { error: "tool-unavailable" }, isError: true }),
};

/**
 * Bundled GitHub is enabled by default. A missing extension-store row must
 * keep today's routes and tools; a stored disable, untrusted, or not-desired
 * row is not effective.
 */
export function isGithubIntegrationEffective(
  snapshot: Pick<ExtensionSnapshot, "packages">,
): boolean {
  const component = snapshot.packages
    .flatMap((pkg) => pkg.components)
    .find((entry) => String(entry.component.id) === GITHUB_INTEGRATION_COMPONENT_ID);
  if (component === undefined) return true;
  return (
    resolveExtensionActivation({
      ...component.activation,
      hostAllowed: true,
      modeAllowed: true,
      projectAllowed: true,
      threadAllowed: true,
      catalogCurrent: true,
    }).kind === "effective"
  );
}

export function githubReadToolSetIfEffective(
  snapshot: Pick<ExtensionSnapshot, "packages">,
  create: () => AppManagedToolSet,
): AppManagedToolSet {
  return isGithubIntegrationEffective(snapshot) ? create() : emptyGithubReadToolSet;
}
