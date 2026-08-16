import type { OctantMode } from "@octant/contracts/modes";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { readExtensionSnapshot } from "../persistence/extensionProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { ExtensionActivationService } from "./extensionActivationService";

const NO_PROVIDER_FAMILY = "none" as ExtensionProviderFamily;

/**
 * Resolves whether a bundled first-party plugin component (board, GitHub
 * integration) is effective, through the same activation ladder used for
 * third-party plugins. First-party components are never project/thread
 * scoped, so the query always passes a null project and thread — matching
 * how ExtensionActivationPolicy treats scope-less queries as allowed.
 */
export function isFirstPartyPluginEffective(options: {
  readonly connection: SqliteConnection;
  readonly activationService: ExtensionActivationService;
  readonly clock: () => string;
  readonly extensionId: string;
  readonly componentId: string;
  readonly mode: OctantMode;
}): boolean {
  const snapshot = readExtensionSnapshot(options.connection, options.clock());
  const resolved = options.activationService.resolve(snapshot, {
    scope: {
      hostId: LOCAL_HOST_ID,
      mode: options.mode,
      projectId: null,
      threadId: null,
      providerFamily: NO_PROVIDER_FAMILY,
    },
  });
  const packageState = resolved.packages.find(
    (candidate) => candidate.extensionId === options.extensionId,
  );
  const component = packageState?.components.find(
    (candidate) => candidate.component.id === options.componentId,
  );
  return component?.effectiveState.kind === "effective";
}
