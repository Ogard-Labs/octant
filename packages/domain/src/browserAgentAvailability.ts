import type { BrowserAgentAvailability, ProviderObservedState } from "@octant/contracts";
import { isToolAllowedByAllowlist } from "./agentProfilePolicy";

export interface BrowserAgentFacts {
  readonly toolTransport: boolean | undefined;
  readonly hostLendsBrowser: boolean;
  readonly toolConstraints?: ReadonlyArray<string>;
  readonly readOnly: boolean;
}

export function browserAgentAvailability(facts: BrowserAgentFacts): BrowserAgentAvailability {
  if (!facts.hostLendsBrowser) return { status: "omitted", reason: "host-lends-no-browser" };
  if (facts.toolTransport === undefined) return { status: "unknown" };
  if (!facts.toolTransport) return { status: "omitted", reason: "no-tool-transport" };
  if (!isToolAllowedByAllowlist(facts.toolConstraints ?? [], "octant_browser"))
    return { status: "omitted", reason: "excluded-by-thread-constraints" };
  return { status: "available", readOnly: facts.readOnly };
}

/** Matches the runtime gate, including endpoint models verified independently. */
export function browserToolTransport(
  observed:
    | (Pick<ProviderObservedState, "verifiedToolModelIds"> & {
        readonly capabilities: Pick<ProviderObservedState["capabilities"], "appManagedTools">;
      })
    | undefined,
  modelId: string,
): boolean | undefined {
  if (observed === undefined) return undefined;
  return (
    observed.capabilities.appManagedTools === "supported" ||
    observed.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) === true
  );
}
