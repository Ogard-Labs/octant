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
  /**
   * Whether Strict is on for the thread, as its launch resolves it; absent
   * reads as Strict. Only `false` lets a runtime's outside-Strict report
   * (`appManagedToolsOutsideStrict`) answer.
   */
  readonly strict?: boolean | undefined;
}

/**
 * The level a Work or Code thread stores, as the tool gate reads it, with the
 * thread's Strict value where the caller resolved it.
 */
export function appToolThreadLevel(
  thread: (
    | { readonly executionPolicy: ProviderExecutionPolicy }
    | { readonly access: WorkAccess }
  ) & { readonly fullAccessSandbox?: boolean | undefined },
  strict?: boolean,
): AppToolThreadLevel {
  return {
    executionPolicy:
      "executionPolicy" in thread
        ? thread.executionPolicy
        : workThreadAccessOf(thread.access).executionPolicy,
    fullAccessSandbox: thread.fullAccessSandbox,
    ...(strict === undefined ? {} : { strict }),
  };
}

/** The capabilities that decide what a thread gets of Octant's tools. */
export type AppToolCapabilities = Pick<
  ProviderObservedState["capabilities"],
  "appManagedTools" | "appManagedToolsAtFullAccess" | "appManagedToolsOutsideStrict"
>;

/**
 * What one thread gets of Octant's tools from what its runtime reports.
 * `mixed` means the runtime could not prove Octant's tools are the only ones
 * entering it, so the tools are offered and labelled rather than withheld. It
 * exists at Full access, where the same agent already holds an unwrapped
 * shell, and, for a runtime that reports it, on a thread outside Strict below
 * Full access and outside Plan, whose launch runs with no Octant sandbox
 * beside the person's own setup. A thread that keeps the sandbox at Full
 * access is launched as the guarded levels are, so a runtime that proves
 * exclusivity there keeps it. Under Strict, and in Plan, `appManagedTools`
 * answers alone.
 *
 * Rationale: the level alone could not say whether a launch was Strict, so a
 * runtime that carries the tools outside Strict reported `unsupported` for
 * every guarded level and the host never offered them there.
 */
export function threadAppToolSupport(
  capabilities: AppToolCapabilities,
  level: AppToolThreadLevel,
): ProviderCapabilitySupport | "mixed" {
  if (
    level.executionPolicy === "full-access" &&
    capabilities.appManagedToolsAtFullAccess === "mixed"
  ) {
    return level.fullAccessSandbox === true && capabilities.appManagedTools === "supported"
      ? "supported"
      : "mixed";
  }
  if (
    capabilities.appManagedTools !== "supported" &&
    capabilities.appManagedToolsOutsideStrict === "mixed" &&
    level.strict === false &&
    level.executionPolicy !== "plan" &&
    level.executionPolicy !== "full-access"
  ) {
    return "mixed";
  }
  return capabilities.appManagedTools;
}

/**
 * Matches the runtime gate, including endpoint models verified independently.
 * A caller that decides for one Work or Code thread passes its level, so a
 * mixed runtime carries Octant's tools at Full access and nowhere below it.
 */
export function browserToolTransport(
  observed:
    | (Pick<ProviderObservedState, "verifiedToolModelIds"> & {
        readonly capabilities: AppToolCapabilities;
      })
    | undefined,
  modelId: string,
  level?: AppToolThreadLevel,
): boolean | undefined {
  if (observed === undefined) return undefined;
  return (
    observed.capabilities.appManagedTools === "supported" ||
    observed.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) === true ||
    (level !== undefined && carriesThreadTools(threadAppToolSupport(observed.capabilities, level)))
  );
}

/** Whether a thread's tool support lets Octant's tools reach it, labelled or not. */
export function carriesThreadTools(support: ProviderCapabilitySupport | "mixed"): boolean {
  return support === "supported" || support === "mixed";
}
