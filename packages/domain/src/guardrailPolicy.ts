import type {
  GuardrailLevel,
  PermissionMode,
  ProviderExecutionPolicy,
  ToolActionAuthority,
  ToolNetworkEgressPolicy,
} from "@octant/contracts";

/**
 * What a thread stores about its authority. The level is derived from these,
 * never stored beside them, so a journal written before levels existed replays
 * onto the same level every time.
 */
export interface ThreadAccess {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly autoApprove?: boolean | undefined;
  readonly sandboxOff?: boolean | undefined;
}

/** What the thread's provider can do for itself, as its driver reports it. */
export interface GuardrailCapabilities {
  /** The provider has its own reviewer that can answer approval prompts. */
  readonly providerReview: boolean;
  /** The provider runs its tools inside a sandbox of its own. */
  readonly providerSandbox: boolean;
}

export type GuardrailSandbox = "octant" | "provider" | "both" | "none";
export type GuardrailApprover = "person" | "provider-review" | "none";

export type GuardrailResolution =
  | {
      readonly status: "supported";
      readonly level: GuardrailLevel;
      readonly mode: PermissionMode;
      /** Plan: the read-only overlay, at whichever level the thread sits. */
      readonly readOnly: boolean;
      /** Project file writes inside the folder go through without asking. */
      readonly folderEditsWaived: boolean;
      readonly sandbox: GuardrailSandbox;
      readonly approver: GuardrailApprover;
      readonly egress: ToolNetworkEgressPolicy;
      /** On: outside content makes irreversible calls ask afresh. Off only at Off. */
      readonly injectionGate: "on" | "off";
    }
  | {
      /**
       * The thread asks for Auto and its provider has no reviewer. Octant
       * never fakes one, so the thread runs as Ask first and says why.
       */
      readonly status: "unsupported";
      readonly mode: "auto";
      readonly reason: string;
      readonly fallback: GuardrailResolution & { readonly status: "supported" };
    };

export const AUTO_UNSUPPORTED_REASON =
  "This provider has no reviewer of its own, so this thread asks first.";

/** The picker's words for a stored posture. */
export function permissionModeOf(access: ThreadAccess): PermissionMode {
  switch (access.executionPolicy) {
    case "plan":
      return "plan";
    case "full-access":
      return "full-access";
    case "auto-accept-edits":
      return "accept-edits";
    case "approval-gated":
      return access.autoApprove === true ? "auto" : "ask-first";
  }
}

/**
 * The posture a picker choice stores. Off is not a choice: the host decides
 * `sandboxOff` from the person's Settings switch when a thread reaches Full
 * access.
 */
export function threadAccessOf(mode: PermissionMode): {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly autoApprove: boolean;
} {
  switch (mode) {
    case "auto":
      return { executionPolicy: "approval-gated", autoApprove: true };
    case "ask-first":
      return { executionPolicy: "approval-gated", autoApprove: false };
    case "accept-edits":
      return { executionPolicy: "auto-accept-edits", autoApprove: false };
    case "plan":
      return { executionPolicy: "plan", autoApprove: false };
    case "full-access":
      return { executionPolicy: "full-access", autoApprove: false };
  }
}

/**
 * The level a stored posture is at. Today's postures map onto it:
 * approval-gated and auto-accept-edits are Guarded, either one with the
 * provider's reviewer delegated is Provider review, remembered Full access is
 * Trusted, and Full access with the sandbox off is Off. Plan is read-only at
 * Guarded.
 */
export function guardrailLevelOf(access: ThreadAccess): GuardrailLevel {
  if (access.executionPolicy === "full-access") {
    return access.sandboxOff === true ? "off" : "trusted";
  }
  if (access.executionPolicy === "plan") return "guarded";
  return access.autoApprove === true ? "provider-review" : "guarded";
}

/**
 * The one answer to "how is this thread guarded?" for a given provider: who
 * sandboxes it, who approves, what network it gets, and whether outside
 * content gates irreversible calls. Every surface that prints or enforces a
 * level reads it from here.
 */
export function resolveGuardrail(input: {
  readonly access: ThreadAccess;
  readonly capabilities: GuardrailCapabilities;
  readonly mode?: ToolActionAuthority["mode"];
}): GuardrailResolution {
  const surfaceMode = input.mode ?? "code";
  const mode = permissionModeOf(input.access);
  const level = guardrailLevelOf(input.access);
  const readOnly = input.access.executionPolicy === "plan";
  const egress = guardrailEgress(surfaceMode, input.access.executionPolicy);
  const ownSandbox = input.capabilities.providerSandbox;
  if (level === "provider-review" && !input.capabilities.providerReview) {
    return {
      status: "unsupported",
      mode: "auto",
      reason: AUTO_UNSUPPORTED_REASON,
      fallback: {
        status: "supported",
        level: "guarded",
        mode: "ask-first",
        readOnly: false,
        folderEditsWaived: input.access.executionPolicy === "auto-accept-edits",
        sandbox: ownSandbox ? "both" : "octant",
        approver: "person",
        egress,
        injectionGate: "on",
      },
    };
  }
  switch (level) {
    case "guarded":
    case "provider-review":
      return {
        status: "supported",
        level,
        mode,
        readOnly,
        folderEditsWaived: input.access.executionPolicy === "auto-accept-edits",
        sandbox: ownSandbox ? "both" : "octant",
        approver: level === "provider-review" ? "provider-review" : "person",
        egress,
        injectionGate: "on",
      };
    case "trusted":
      // The provider's own sandbox where it has one. Where it has none, the
      // confinement Octant gives that runtime at Full access stays the only
      // one, so it is reported as Octant's rather than as no sandbox.
      return {
        status: "supported",
        level,
        mode,
        readOnly: false,
        folderEditsWaived: true,
        sandbox: ownSandbox ? "provider" : "octant",
        approver: "none",
        egress,
        injectionGate: "on",
      };
    case "off":
      return {
        status: "supported",
        level,
        mode,
        readOnly: false,
        folderEditsWaived: true,
        sandbox: "none",
        approver: "none",
        egress,
        injectionGate: "off",
      };
  }
}

/**
 * Approved egress defaults (2026-08-12): Work and Plan get none; Code at a
 * prompting posture gets provider endpoints only; Code at Full access is
 * unrestricted. The Seatbelt builder materializes it.
 */
function guardrailEgress(
  mode: ToolActionAuthority["mode"],
  executionPolicy: ProviderExecutionPolicy,
): ToolNetworkEgressPolicy {
  if (mode !== "code") return "none";
  if (executionPolicy === "plan") return "none";
  // Auto-accepting edits says nothing about the network, so it keeps exactly
  // the egress approval-gated Code already has.
  if (executionPolicy === "approval-gated" || executionPolicy === "auto-accept-edits") {
    return "provider-endpoints-only";
  }
  return "unrestricted";
}

/**
 * The mode a new thread in this Project starts in: the Project's own choice,
 * then a Project that remembered Full access before Project modes existed,
 * then Settings.
 */
export function defaultPermissionModeFor(input: {
  readonly project?:
    | {
        readonly defaultPermissionMode?: PermissionMode | undefined;
        readonly codeAccessPersistence?: "current-session" | "project-default" | undefined;
      }
    | undefined;
  readonly settings: {
    readonly defaultExecutionPolicy: ProviderExecutionPolicy;
    readonly defaultAutoApprove?: boolean | undefined;
  };
}): PermissionMode {
  if (input.project?.defaultPermissionMode !== undefined) {
    return input.project.defaultPermissionMode;
  }
  if (input.project?.codeAccessPersistence === "project-default") return "full-access";
  return permissionModeOf({
    executionPolicy: input.settings.defaultExecutionPolicy,
    autoApprove: input.settings.defaultAutoApprove,
  });
}
