import { decideHubIntroducedThreadStart, type HubIntroducedStartDecision } from "@octant/domain";
import type { SpokeLinkStatus } from "./spokeLinkService";

/** What a member's grant to its hub lets a device only the hub introduced start here. */
export interface HubActScopePort {
  readonly decideStart: (projectId: string) => HubIntroducedStartDecision;
}

export interface HubActScopeSlot {
  readonly current: () => HubActScopePort | undefined;
  readonly bind: (port: HubActScopePort) => void;
}

/**
 * The Code routes are built before the hub side, which binds the member's
 * Act item here once its spoke link exists.
 */
export function createHubActScopeSlot(): HubActScopeSlot {
  let bound: HubActScopePort | undefined;
  return {
    current: () => bound,
    bind: (port) => {
      bound = port;
    },
  };
}

/** Reads the member's grant at each start, so a changed Act item governs the next one. */
export function hubActScopeFromSpokeLink(spoke: {
  readonly status: () => SpokeLinkStatus;
}): HubActScopePort {
  return {
    decideStart: (projectId) => {
      const status = spoke.status();
      return decideHubIntroducedThreadStart({
        membership: status.membership,
        grant: status.membership === "none" ? undefined : status.grant,
        projectId,
      });
    },
  };
}

/** The sentence a refused start shows, naming what the member would change. */
export function hubActRefusalMessage(
  decision: Extract<HubIntroducedStartDecision, { readonly status: "refused" }>,
): string {
  switch (decision.kind) {
    case "removed-from-hub":
      return "This computer has left its hub, so a device the hub introduced cannot start threads here.";
    case "act-not-granted":
      return "This computer has not ticked Act for its hub, so a device the hub introduced cannot start threads here.";
    case "project-not-named":
      return "This computer's Act item for its hub does not name this Project.";
  }
}
