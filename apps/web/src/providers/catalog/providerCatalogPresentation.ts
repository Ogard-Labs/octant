import type {
  ProviderCatalogAgentLoop,
  ProviderCatalogModeSupport,
  ProviderCatalogSandbox,
  ProviderCatalogState,
  ProviderCatalogStep,
} from "@octant/domain/provider-catalog-policy";

/**
 * How a catalog state draws: the same tones Model endpoints uses, so a dot's
 * shape carries the state without colour (filled ready, ring needs you, dashed
 * off, muted not checked, turning checking, diamond failed).
 */
export type ProviderCatalogTone =
  | "ready"
  | "needs-you"
  | "off"
  | "unchecked"
  | "checking"
  | "failed";

export interface ProviderCatalogStatus {
  readonly tone: ProviderCatalogTone;
  readonly label: string;
}

/** One line for a catalog row: the step setup is on, said as a state. */
export function providerCatalogStatus(state: ProviderCatalogState): ProviderCatalogStatus {
  const next = state.next;
  switch (next.kind) {
    case "unavailable":
      return { tone: "off", label: "Not available" };
    case "check-host":
      return { tone: "unchecked", label: "Not looked for yet" };
    case "install":
      return { tone: "off", label: "Not on this host" };
    case "add-detected":
      return { tone: "unchecked", label: "Found, not added" };
    case "add-endpoint":
      return { tone: "off", label: "Not added" };
    case "turn-on":
      return { tone: "off", label: "Off" };
    case "check-connection":
      return state.ready === "checking"
        ? { tone: "checking", label: "Checking…" }
        : { tone: "unchecked", label: "Not checked yet" };
    case "sign-in":
      return { tone: "needs-you", label: "Sign in to use" };
    case "fix-runtime":
      return next.readiness === "degraded"
        ? { tone: "needs-you", label: "Partly working" }
        : next.readiness === "incompatible"
          ? { tone: "failed", label: "Version not supported" }
          : { tone: "failed", label: "Can't start" };
    case "done":
      return { tone: "ready", label: "Ready" };
  }
}

/** The four states the catalog keeps apart, each in words with its tone. */
export function providerCatalogFacts(
  state: ProviderCatalogState,
): ReadonlyArray<{ readonly id: string; readonly name: string } & ProviderCatalogStatus> {
  return [
    {
      id: "available",
      name: "Available",
      ...(state.available
        ? { tone: "ready" as const, label: "Yes" }
        : { tone: "off" as const, label: "Not available" }),
    },
    {
      id: "enabled",
      name: "Enabled",
      ...(state.enabled === "yes"
        ? { tone: "ready" as const, label: "On" }
        : state.enabled === "no"
          ? { tone: "off" as const, label: "Off" }
          : { tone: "off" as const, label: "Not added" }),
    },
    {
      id: "authenticated",
      name: "Signed in",
      ...(state.authenticated === "yes"
        ? { tone: "ready" as const, label: "Yes" }
        : state.authenticated === "no"
          ? { tone: "needs-you" as const, label: "Needs sign-in" }
          : state.authenticated === "not-needed"
            ? { tone: "ready" as const, label: "Not needed" }
            : { tone: "unchecked" as const, label: "Not checked yet" }),
    },
    {
      id: "ready",
      name: "Ready",
      ...(state.ready === "yes"
        ? { tone: "ready" as const, label: "Yes" }
        : state.ready === "checking"
          ? { tone: "checking" as const, label: "Checking…" }
          : state.ready === "no"
            ? { tone: state.enabled === "no" ? ("off" as const) : ("failed" as const), label: "No" }
            : { tone: "unchecked" as const, label: "Not checked yet" }),
    },
  ];
}

export function modeSupportLabel(support: ProviderCatalogModeSupport): string {
  switch (support) {
    case "yes":
      return "Yes";
    case "checked-models":
      return "With the models its connection check reports for tool use";
    case "verified-models":
      return "With the models you verify for tools";
    case "no":
      return "No";
  }
}

/**
 * Says who confines a runtime's own tools the way the confinement matrix does:
 * a runtime Octant does not wrap is never described as inside Octant's sandbox.
 */
export function agentLoopLabel(
  loop: ProviderCatalogAgentLoop,
  sandbox: ProviderCatalogSandbox,
): string {
  switch (loop) {
    case "runtime":
      switch (sandbox) {
        case "octant":
          return "Runs its own agent loop. Octant's sandbox confines it and approvals gate it, except on Full access";
        case "octant-in-plan":
          return "Runs its own agent loop. Octant's sandbox confines it in Plan only; elsewhere its own sandbox applies, which Full access turns off";
        case "runtime":
        case "not-applicable":
          return "Runs its own agent loop under its own sandbox, which Full access turns off. Octant does not confine it";
      }
    case "octant-harness":
      return "Octant Harness runs the agent loop and offers every tool";
    case "replies-only":
      return "Replies only; it has no agent loop in Octant yet";
    case "none":
      return "Octant lists its models but does not start turns with it yet";
  }
}

export type ProviderCatalogStepId = "find" | "add" | "turn-on" | "sign-in" | "check";
export type ProviderCatalogStepProgress = "done" | "current" | "upcoming";

/**
 * The setup steps a driver walks through, in order, with where it is. An
 * endpoint is added with its address rather than found on the host, so it has
 * no Find step.
 */
export function providerCatalogSteps(state: ProviderCatalogState): ReadonlyArray<{
  readonly id: ProviderCatalogStepId;
  readonly title: string;
  readonly progress: ProviderCatalogStepProgress;
}> {
  const current = currentStepId(state.next);
  const hasInstance = state.instance !== undefined;
  const findable = state.presence.kind !== "not-applicable";
  const done: Record<ProviderCatalogStepId, boolean> = {
    find: hasInstance || state.presence.kind === "detected",
    add: hasInstance,
    "turn-on": state.enabled === "yes",
    "sign-in": state.authenticated === "yes" || state.authenticated === "not-needed",
    check: state.ready === "yes",
  };
  const steps: ReadonlyArray<{ readonly id: ProviderCatalogStepId; readonly title: string }> = [
    ...(findable ? [{ id: "find" as const, title: "Find it on this host" }] : []),
    { id: "add", title: state.setup === "endpoint" ? "Add the endpoint" : "Add it to Octant" },
    { id: "turn-on", title: "Turn it on" },
    { id: "sign-in", title: "Sign in" },
    { id: "check", title: "Check the connection" },
  ];
  return steps.map((step) => ({
    ...step,
    progress: step.id === current ? "current" : done[step.id] ? "done" : "upcoming",
  }));
}

function currentStepId(next: ProviderCatalogStep): ProviderCatalogStepId | undefined {
  switch (next.kind) {
    case "check-host":
    case "install":
      return "find";
    case "add-detected":
    case "add-endpoint":
      return "add";
    case "turn-on":
      return "turn-on";
    case "sign-in":
      return "sign-in";
    case "check-connection":
    case "fix-runtime":
      return "check";
    case "unavailable":
    case "done":
      return undefined;
  }
}
