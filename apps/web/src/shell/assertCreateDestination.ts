import { LOCAL_HOST_ID, type HostId, type HostIdentity } from "@octant/contracts/host";
import {
  selectCreateHost,
  type SelectCreateHostRequest,
  type HostRejectionReason,
} from "@octant/domain";
import type { AuthorityMutationDecision } from "@octant/client-runtime/host-federation-merged-reads";

/**
 * Fail-closed create destination check: name one host, refuse when it is not
 * routable, and never queue the mutation for later.
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
  /**
   * The window can send this create only to its own host. Code and Project
   * creates go through the window's loopback clients and their commands name no
   * host, so a create aimed at another computer used to run on this one under
   * the other computer's name. Refuse it instead until the create is routed.
   */
  readonly onlyThisHost?: boolean;
}

export const OTHER_COMPUTER_CREATE_REFUSAL =
  "This window can't start this on another computer yet. Choose this computer, or use that computer's own window.";

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
  if (input.onlyThisHost === true && String(selection.host.hostId) !== String(LOCAL_HOST_ID)) {
    return { kind: "refused", reason: OTHER_COMPUTER_CREATE_REFUSAL };
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
  readonly onlyThisHost?: boolean;
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
    ...(input.onlyThisHost === undefined ? {} : { onlyThisHost: input.onlyThisHost }),
  });
}
