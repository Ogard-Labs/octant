import type {
  ClosedToolCatalogEntry,
  ExtensionCapability,
  ProviderCapabilitySupport,
  ProviderExecutionPolicy,
  ToolActionAuthority,
  ToolActionCapability,
  ToolApprovalClass,
  ToolNetworkEgressPolicy,
} from "@octant/contracts";
import { lookupClosedToolCatalogEntry } from "@octant/contracts";
import { authorizePrincipalAction, type PrincipalKind } from "./remoteAccessPolicy";

export type ToolCallPolicyStep =
  | "tool-identity"
  | "argument-schema"
  | "mode-policy"
  | "provider-capability"
  | "host-policy"
  | "remote-actor"
  | "thread-elevation";

/**
 * Structured decision receipt suitable for journal audit consumers.
 * Actor kinds stay on the existing EventActor set until the audit taxonomy
 * extends them.
 */
export type ToolCallDecisionReceipt = {
  readonly decision: "allow" | "prompt" | "deny";
  readonly step?: ToolCallPolicyStep;
  readonly reason: string;
  readonly capabilityId: ToolActionCapability["id"];
  readonly capabilityVersion: number;
  readonly mode: ToolActionAuthority["mode"];
  readonly approvalClass?: ToolApprovalClass;
  readonly egressPolicy: ToolNetworkEgressPolicy;
  readonly actorKind: "system" | "local-user";
  readonly recordedAt: string;
};

export type ToolCallPolicyDecision =
  | {
      readonly kind: "allow";
      readonly catalogEntry: ClosedToolCatalogEntry;
      readonly egressPolicy: ToolNetworkEgressPolicy;
      readonly receipt: ToolCallDecisionReceipt;
    }
  | {
      readonly kind: "prompt";
      readonly catalogEntry: ClosedToolCatalogEntry;
      readonly approvalClass: ToolApprovalClass;
      readonly egressPolicy: ToolNetworkEgressPolicy;
      readonly reason: string;
      readonly receipt: ToolCallDecisionReceipt;
    }
  | {
      readonly kind: "deny";
      readonly step: ToolCallPolicyStep;
      readonly reason: string;
      readonly egressPolicy: ToolNetworkEgressPolicy;
      readonly receipt: ToolCallDecisionReceipt;
    };

export type ToolCallPolicyInput = {
  readonly capability: ToolActionCapability;
  readonly extension: ToolActionAuthority["extension"];
  readonly mode: ToolActionAuthority["mode"];
  readonly arguments: unknown;
  readonly providerAppManagedTools: ProviderCapabilitySupport;
  readonly host: {
    readonly computerUseEnabled: boolean;
    readonly prohibitedCapabilityClasses?: ReadonlyArray<ExtensionCapability | "validation">;
  };
  readonly remoteActor?: {
    readonly principalKind: PrincipalKind;
    readonly action: string;
    readonly requestedPrincipalKind?: PrincipalKind;
  };
  readonly thread: {
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly approvalSatisfied: boolean;
    /**
     * Untrusted-content provenance hook — thread-lifetime
     * `external-content-ingested` taint.
     * When true, irreversible approval classes require a fresh confirmation
     * even if standing full-access / session grants would otherwise allow.
     */
    readonly externalContentIngested: boolean;
  };
  /** Manifest-declared capabilities for extension/MCP ceiling checks (AC2). */
  readonly declaredCapabilities?: ReadonlyArray<ExtensionCapability>;
  readonly clock?: () => string;
};

/**
 * Pure fail-closed tool-call resolution. Steps run in fixed order; an earlier
 * denial cannot be overridden by later permissive inputs.
 */
export function resolveToolCall(input: ToolCallPolicyInput): ToolCallPolicyDecision {
  const clock = input.clock ?? (() => new Date().toISOString());
  const egressPolicy = resolveNetworkEgressPolicy({
    mode: input.mode,
    executionPolicy: input.thread.executionPolicy,
  });

  const deny = (step: ToolCallPolicyStep, reason: string): ToolCallPolicyDecision => {
    const receipt = receiptOf({
      decision: "deny",
      step,
      reason,
      capability: input.capability,
      mode: input.mode,
      egressPolicy,
      clock,
    });
    return { kind: "deny", step, reason, egressPolicy, receipt };
  };

  // 1. Tool identity (closed catalog + core vs MCP ownership + declared ceiling)
  const catalogEntry = lookupClosedToolCatalogEntry(input.capability);
  if (catalogEntry === undefined) {
    return deny("tool-identity", "unknown-tool");
  }
  if (catalogEntry.owner === "core" && input.extension.kind !== "core") {
    return deny("tool-identity", "mcp-cannot-claim-core");
  }
  if (
    catalogEntry.owner === "extension-namespaced" &&
    input.extension.kind !== "trusted-extension"
  ) {
    return deny("tool-identity", "extension-tool-requires-trusted-extension");
  }
  if (input.extension.kind === "trusted-extension") {
    const requiredClass = requiredCapabilityClassForExtension(catalogEntry, input.arguments);
    const declared = input.declaredCapabilities ?? [];
    if (requiredClass !== undefined && !declared.includes(requiredClass)) {
      return deny("tool-identity", "undeclared-capability-class");
    }
  }

  // 2. Argument schema
  try {
    catalogEntry.decodeArguments(input.arguments);
  } catch {
    return deny("argument-schema", "argument-schema-invalid");
  }

  // 3. Mode policy (§8.1 capability matrix)
  if (!catalogEntry.modes.includes(input.mode)) {
    return deny("mode-policy", "mode-capability-denied");
  }

  // 4. Provider capability
  if (catalogEntry.requiresAppManagedTools && input.providerAppManagedTools !== "supported") {
    return deny("provider-capability", "provider-capability-unsupported");
  }

  // 5. Host policy
  if (catalogEntry.requiredCapabilityClass === "computer-use" && !input.host.computerUseEnabled) {
    return deny("host-policy", "computer-use-disabled");
  }
  if (
    input.host.prohibitedCapabilityClasses?.includes(catalogEntry.requiredCapabilityClass) === true
  ) {
    return deny("host-policy", "host-capability-prohibited");
  }

  // 6. Remote actor
  if (input.remoteActor !== undefined) {
    const principal = authorizePrincipalAction({
      principalKind: input.remoteActor.principalKind,
      action: input.remoteActor.action,
      ...(input.remoteActor.requestedPrincipalKind === undefined
        ? {}
        : { requestedPrincipalKind: input.remoteActor.requestedPrincipalKind }),
    });
    if (principal.kind === "deny") {
      return deny("remote-actor", principal.reason);
    }
  }

  // 7. Thread elevation / approval / taint (untrusted-content taint hook)
  const elevation = resolveThreadElevation({
    entry: catalogEntry,
    executionPolicy: input.thread.executionPolicy,
    approvalSatisfied: input.thread.approvalSatisfied,
    externalContentIngested: input.thread.externalContentIngested,
  });
  if (elevation.kind === "deny") {
    return deny("thread-elevation", elevation.reason);
  }
  if (elevation.kind === "prompt") {
    const receipt = receiptOf({
      decision: "prompt",
      step: "thread-elevation",
      reason: elevation.reason,
      capability: input.capability,
      mode: input.mode,
      approvalClass: catalogEntry.approvalClass,
      egressPolicy,
      clock,
    });
    return {
      kind: "prompt",
      catalogEntry,
      approvalClass: catalogEntry.approvalClass,
      egressPolicy,
      reason: elevation.reason,
      receipt,
    };
  }

  const receipt = receiptOf({
    decision: "allow",
    reason: "authorized",
    capability: input.capability,
    mode: input.mode,
    approvalClass: catalogEntry.approvalClass,
    egressPolicy,
    clock,
  });
  return { kind: "allow", catalogEntry, egressPolicy, receipt };
}

/**
 * Approved egress defaults (2026-08-12): Work/Plan → none; Code approval-gated
 * and auto-accept-edits → provider-endpoints-only; Code full-access →
 * unrestricted. Seatbelt materialization is owned by the shared Seatbelt
 * builder; this resolution is the policy choke-point export.
 */
export function resolveNetworkEgressPolicy(input: {
  readonly mode: ToolActionAuthority["mode"];
  readonly executionPolicy: ProviderExecutionPolicy;
}): ToolNetworkEgressPolicy {
  if (input.mode !== "code") return "none";
  if (input.executionPolicy === "plan") return "none";
  // Auto-accepting edits says nothing about the network, so it keeps exactly
  // the egress approval-gated Code already has.
  if (input.executionPolicy === "approval-gated" || input.executionPolicy === "auto-accept-edits") {
    return "provider-endpoints-only";
  }
  return "unrestricted";
}

function requiredCapabilityClassForExtension(
  entry: ClosedToolCatalogEntry,
  args: unknown,
): ExtensionCapability | undefined {
  if (entry.capabilityId === "mcp-tool") {
    if (
      args !== null &&
      typeof args === "object" &&
      "requiredCapabilityClass" in args &&
      typeof (args as { requiredCapabilityClass?: unknown }).requiredCapabilityClass === "string"
    ) {
      return (args as { requiredCapabilityClass: ExtensionCapability }).requiredCapabilityClass;
    }
    return "mcp";
  }
  if (entry.requiredCapabilityClass === "validation") return undefined;
  return entry.requiredCapabilityClass;
}

function resolveThreadElevation(input: {
  readonly entry: ClosedToolCatalogEntry;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly approvalSatisfied: boolean;
  readonly externalContentIngested: boolean;
}):
  | { readonly kind: "allow" }
  | { readonly kind: "prompt"; readonly reason: string }
  | { readonly kind: "deny"; readonly reason: string } {
  if (input.executionPolicy === "plan") {
    if (
      input.entry.approvalClass === "external-application" ||
      input.entry.approvalClass === "shell-commands" ||
      input.entry.approvalClass === "project-file-writes" ||
      input.entry.approvalClass === "destructive-irreversible" ||
      input.entry.approvalClass === "credential-secret-access" ||
      input.entry.approvalClass === "privilege-expansion" ||
      input.entry.approvalClass === "access-outside-project" ||
      input.entry.approvalClass === "publish-to-target"
    ) {
      return { kind: "deny", reason: "plan-mode-denied" };
    }
  }

  // Taint hook: thread-lifetime taint forces fresh confirmation for irreversible classes.
  if (input.externalContentIngested && input.entry.irreversibleUnderTaint) {
    return { kind: "prompt", reason: "taint-requires-fresh-confirmation" };
  }

  if (
    input.executionPolicy === "auto-accept-edits" &&
    !input.approvalSatisfied &&
    input.entry.approvalClass === "project-file-writes"
  ) {
    // The one class this posture decides without asking. Every other class
    // below is decided exactly as it would be under approval-gated.
    return { kind: "allow" };
  }

  // Publication is approved one act at a time, against the exact target and
  // bytes about to leave the machine. A satisfied standing approval is exactly
  // what must not carry it, so this sits above the postures rather than inside
  // them: no execution policy, including full access, turns it into an allow.
  if (input.entry.approvalClass === "publish-to-target") {
    return { kind: "prompt", reason: "approval-required" };
  }

  if (
    (input.executionPolicy === "approval-gated" || input.executionPolicy === "auto-accept-edits") &&
    !input.approvalSatisfied
  ) {
    if (input.entry.approvalClass === "network-access") {
      // Browser network under approval-gated Code may proceed when the surface
      // already treated the action as not-required; still prompt for external apps.
      return { kind: "allow" };
    }
    return { kind: "prompt", reason: "approval-required" };
  }

  return { kind: "allow" };
}

function receiptOf(input: {
  readonly decision: "allow" | "prompt" | "deny";
  readonly step?: ToolCallPolicyStep;
  readonly reason: string;
  readonly capability: ToolActionCapability;
  readonly mode: ToolActionAuthority["mode"];
  readonly approvalClass?: ToolApprovalClass;
  readonly egressPolicy: ToolNetworkEgressPolicy;
  readonly clock: () => string;
}): ToolCallDecisionReceipt {
  return {
    decision: input.decision,
    ...(input.step === undefined ? {} : { step: input.step }),
    reason: input.reason,
    capabilityId: input.capability.id,
    capabilityVersion: input.capability.version,
    mode: input.mode,
    ...(input.approvalClass === undefined ? {} : { approvalClass: input.approvalClass }),
    egressPolicy: input.egressPolicy,
    actorKind: "system",
    recordedAt: input.clock(),
  };
}
