import type { HostId, HostIdentity } from "@octant/contracts/host";
import {
  selectCreateHost,
  type SelectCreateHostRequest,
  type HostRejectionReason,
} from "@octant/domain";
import type { AuthorityMutationDecision } from "@octant/client-runtime/host-federation-merged-reads";

/**
 * Fail-closed create destination check: name one host, refuse when it is not
 * routable, and never queue the mutation for later (0013 / 0031 / 0059).
 */

export type CreateDestinationDecision =
  | { readonly kind: "ok"; readonly hostId: HostId }
  | { readonly kind: "refused"; readonly reason: string };

export interface AssertCreateDestinationInput extends SelectCreateHostRequest {
  readonly action: string;
  /**
   * Optional lifecycle gate. When present, a ready HostIdentity still refuses
   * if the federation lifecycle says the host is read-only.
   */
  readonly mutationDecision?: (
    hostId: HostId | string,
    action: string,
  ) => AuthorityMutationDecision;
}

export function createDestinationRefusalMessage(reason: HostRejectionReason): string {
  switch (reason) {
    case "unknown-host":
      return "That destination host is not registered on this client.";
    case "host-unavailable":
      return "That destination host is not connected. Reconnect before creating.";
    case "host-unauthorized":
      return "That destination host is unauthorized. Re-pair or pick another host.";
    case "host-incompatible":
      return "That destination host cannot run this create action.";
    case "project-host-mismatch":
      return "This Project is fixed to another host.";
  }
}

export function assertCreateDestination(
  input: AssertCreateDestinationInput,
): CreateDestinationDecision {
  const selection = selectCreateHost({
    hosts: input.hosts,
    requestedHostId: input.requestedHostId,
    ...(input.projectHostId === undefined ? {} : { projectHostId: input.projectHostId }),
    ...(input.requiredCapability === undefined
      ? {}
      : { requiredCapability: input.requiredCapability }),
  });
  if (selection.kind === "rejected") {
    return {
      kind: "refused",
      reason: createDestinationRefusalMessage(selection.reason),
    };
  }
  if (input.mutationDecision !== undefined) {
    const decision = input.mutationDecision(selection.host.hostId, input.action);
    if (!decision.allowed) {
      return { kind: "refused", reason: decision.reason };
    }
  }
  return { kind: "ok", hostId: selection.host.hostId };
}

/** Convenience for callers that already hold the host list and selected id. */
export function assertCreateDestinationFromHosts(input: {
  readonly hosts: ReadonlyArray<HostIdentity>;
  readonly createHostId: HostId;
  readonly action: string;
  readonly projectHostId?: HostId;
  readonly requiredCapability?: string;
  readonly mutationDecision?: AssertCreateDestinationInput["mutationDecision"];
}): CreateDestinationDecision {
  return assertCreateDestination({
    hosts: input.hosts,
    requestedHostId: input.createHostId,
    action: input.action,
    ...(input.projectHostId === undefined ? {} : { projectHostId: input.projectHostId }),
    ...(input.requiredCapability === undefined
      ? {}
      : { requiredCapability: input.requiredCapability }),
    ...(input.mutationDecision === undefined ? {} : { mutationDecision: input.mutationDecision }),
  });
}
