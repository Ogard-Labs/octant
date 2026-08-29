import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { resolveExtensionActivation } from "@octant/plugin-host/activation";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";

const GITHUB_INTEGRATION_COMPONENT_ID = "github-integration";
const LINEAR_INTEGRATION_COMPONENT_ID = "linear-integration";

const emptyGithubReadToolSet: AppManagedToolSet = {
  definitions: [],
  execute: async () => ({ result: { error: "tool-unavailable" }, isError: true }),
};

export type FirstPartyIntegrationMissingRow = "effective" | "ineffective";

/**
 * First-party integrations share the activation ladder. A missing store row
 * is the bundled default: GitHub on, Linear off.
 */
export function isFirstPartyIntegrationEffective(
  snapshot: Pick<ExtensionSnapshot, "packages">,
  componentId: string,
  options: { readonly missingRow: FirstPartyIntegrationMissingRow },
): boolean {
  const component = snapshot.packages
    .flatMap((pkg) => pkg.components)
    .find((entry) => String(entry.component.id) === componentId);
  if (component === undefined) return options.missingRow === "effective";
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

/**
 * Bundled GitHub is enabled by default. A missing extension-store row must
 * keep today's routes and tools; a stored disable, untrusted, or not-desired
 * row is not effective.
 */
export function isGithubIntegrationEffective(
  snapshot: Pick<ExtensionSnapshot, "packages">,
): boolean {
  return isFirstPartyIntegrationEffective(snapshot, GITHUB_INTEGRATION_COMPONENT_ID, {
    missingRow: "effective",
  });
}

/**
 * Bundled Linear is off until the store row is installed, trusted, and
 * desired. A missing row must not construct GraphQL, OAuth, or issue-context.
 */
export function isLinearIntegrationEffective(
  snapshot: Pick<ExtensionSnapshot, "packages">,
): boolean {
  return isFirstPartyIntegrationEffective(snapshot, LINEAR_INTEGRATION_COMPONENT_ID, {
    missingRow: "ineffective",
  });
}

export function githubReadToolSetIfEffective(
  snapshot: Pick<ExtensionSnapshot, "packages">,
  create: () => AppManagedToolSet,
): AppManagedToolSet {
  return isGithubIntegrationEffective(snapshot) ? create() : emptyGithubReadToolSet;
}
