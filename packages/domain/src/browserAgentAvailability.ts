import type {
  BrowserAgentAvailability,
  ProviderCapabilitySupport,
  ProviderExecutionPolicy,
  ProviderObservedState,
  WorkAccess,
} from "@octant/contracts";
import { isToolAllowedByAllowlist } from "./agentProfilePolicy";
import { workThreadAccessOf } from "./guardrailPolicy";

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

/** The level facts that decide what a thread gets of Octant's tools. */
export interface AppToolThreadLevel {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly fullAccessSandbox?: boolean | undefined;
}

/** The level a Work or Code thread stores, as the tool gate reads it. */
export function appToolThreadLevel(
  thread: (
    | { readonly executionPolicy: ProviderExecutionPolicy }
    | { readonly access: WorkAccess }
  ) & { readonly fullAccessSandbox?: boolean | undefined },
): AppToolThreadLevel {
  return {
    executionPolicy:
      "executionPolicy" in thread
        ? thread.executionPolicy
        : workThreadAccessOf(thread.access).executionPolicy,
    fullAccessSandbox: thread.fullAccessSandbox,
  };
}

/**
 * What one thread gets of Octant's tools from what its runtime reports.
 * `mixed` exists only at Full access: the runtime could not prove Octant's
 * tools are the only ones entering it, and the same agent already holds an
 * unwrapped shell there, so the tools are offered and labelled rather than
 * withheld. A thread that keeps the sandbox at Full access is launched as the
 * guarded levels are, so a runtime that proves exclusivity there keeps it.
 */
export function threadAppToolSupport(
  capabilities: Pick<
    ProviderObservedState["capabilities"],
    "appManagedTools" | "appManagedToolsAtFullAccess"
  >,
  level: AppToolThreadLevel,
): ProviderCapabilitySupport | "mixed" {
  if (
    level.executionPolicy !== "full-access" ||
    capabilities.appManagedToolsAtFullAccess !== "mixed"
  )
    return capabilities.appManagedTools;
  return level.fullAccessSandbox === true && capabilities.appManagedTools === "supported"
    ? "supported"
    : "mixed";
}

/**
 * Matches the runtime gate, including endpoint models verified independently.
 * A caller that decides for one Work or Code thread passes its level, so a
 * mixed runtime carries Octant's tools at Full access and nowhere below it.
 */
export function browserToolTransport(
  observed:
    | (Pick<ProviderObservedState, "verifiedToolModelIds"> & {
        readonly capabilities: Pick<
          ProviderObservedState["capabilities"],
          "appManagedTools" | "appManagedToolsAtFullAccess"
        >;
      })
    | undefined,
  modelId: string,
  level?: AppToolThreadLevel,
): boolean | undefined {
  if (observed === undefined) return undefined;
  return (
    observed.capabilities.appManagedTools === "supported" ||
    observed.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) === true ||
    (level !== undefined && threadAppToolSupport(observed.capabilities, level) === "mixed")
  );
}
