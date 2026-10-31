import type {
  AutoReviewer,
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
}

/** What the thread's provider can do for itself, as its driver reports it. */
export interface GuardrailCapabilities {
  /** The provider has its own reviewer that can answer approval prompts. */
  readonly providerReview: boolean;
  /** The provider runs its tools inside a sandbox of its own. */
  readonly providerSandbox: boolean;
  /**
   * Whether Octant Shield can review this thread's prompts: the runtime routes
   * its approvals through Octant and a Shield model resolves. Absent means
   * Shield cannot run, which is what every caller from before Shield sees.
   */
  readonly shield?: ShieldAvailability | undefined;
}

export type ShieldAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export type GuardrailSandbox = "octant" | "provider" | "both" | "none";
export type GuardrailApprover = "person" | "provider-review" | "octant-shield" | "none";

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
      /**
       * On: outside content makes irreversible calls ask afresh. At Full
       * access it is recorded only (tagged on the tool row and thread, kept in
       * the journal and export), never a prompt or a block.
       */
      readonly outsideContent: "gates" | "recorded";
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

export const SHIELD_UNAVAILABLE_REASON =
  "No Octant Shield model can run for this thread, so it asks first.";

/**
 * Who answers a Reviewed thread's prompts. The person's choice (a Project's,
 * else Settings') wins; absent, the provider's own reviewer where it has one
 * and Octant Shield everywhere else. "Provider's own" on a provider without
 * one means Shield, since that choice only ever meant "where it exists". A
 * chosen Shield that cannot run leaves no reviewer: the thread asks first and
 * says why, rather than quietly handing the prompts to a reviewer the person
 * did not pick.
 */
export function resolveAutoReviewer(input: {
  readonly chosen?: AutoReviewer | undefined;
  readonly providerReview: boolean;
  readonly shield?: ShieldAvailability | undefined;
}):
  | { readonly status: "reviewer"; readonly reviewer: AutoReviewer }
  | { readonly status: "none"; readonly reason: string } {
  const preferred = input.chosen ?? (input.providerReview ? "provider" : "octant-shield");
  if (preferred === "provider" && input.providerReview) {
    return { status: "reviewer", reviewer: "provider" };
  }
  const shield = input.shield;
  if (shield?.available === true) return { status: "reviewer", reviewer: "octant-shield" };
  if (shield === undefined) {
    return {
      status: "none",
      reason:
        preferred === "octant-shield" && input.providerReview
          ? SHIELD_UNAVAILABLE_REASON
          : AUTO_UNSUPPORTED_REASON,
    };
  }
  return { status: "none", reason: shield.reason };
}

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

/** The posture a picker choice stores. */
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
 * provider's reviewer delegated is Provider review, and `full-access` is Full
 * access, whichever retired form (Trusted, or Off with its `sandboxOff`
 * stamp) a journal wrote it in. Plan is read-only at Guarded.
 */
export function guardrailLevelOf(access: ThreadAccess): GuardrailLevel {
  if (access.executionPolicy === "full-access") return "full-access";
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
  /** The person's Auto reviewer choice: the Project's, else Settings'. */
  readonly reviewer?: AutoReviewer | undefined;
}): GuardrailResolution {
  const surfaceMode = input.mode ?? "code";
  const mode = permissionModeOf(input.access);
  const level = guardrailLevelOf(input.access);
  const readOnly = input.access.executionPolicy === "plan";
  const egress = guardrailEgress(surfaceMode, input.access.executionPolicy);
  const ownSandbox = input.capabilities.providerSandbox;
  const reviewer = resolveAutoReviewer({
    chosen: input.reviewer,
    providerReview: input.capabilities.providerReview,
    shield: input.capabilities.shield,
  });
  if (level === "provider-review" && reviewer.status === "none") {
    return {
      status: "unsupported",
      mode: "auto",
      reason: reviewer.reason,
      fallback: {
        status: "supported",
        level: "guarded",
        mode: "ask-first",
        readOnly: false,
        folderEditsWaived: input.access.executionPolicy === "auto-accept-edits",
        sandbox: ownSandbox ? "both" : "octant",
        approver: "person",
        egress,
        outsideContent: "gates",
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
        approver:
          level !== "provider-review"
            ? "person"
            : reviewer.status === "reviewer" && reviewer.reviewer === "octant-shield"
              ? "octant-shield"
              : "provider-review",
        egress,
        outsideContent: "gates",
      };
    case "full-access":
      // What Full access means in the providers' own apps: no sandbox, Octant's
      // or the provider's, and nobody asked. Network is open.
      return {
        status: "supported",
        level,
        mode,
        readOnly: false,
        folderEditsWaived: true,
        sandbox: "none",
        approver: "none",
        egress,
        outsideContent: "recorded",
      };
  }
}

/**
 * Whether Octant Shield answers this thread's approval prompts: Auto on a
 * prompting posture, with Shield the reviewer that runs. Everywhere else the
 * prompts go to the person, the provider's own reviewer, or nobody (Full
 * access).
 */
export function shieldReviewsPrompts(input: {
  readonly access: ThreadAccess;
  readonly capabilities: GuardrailCapabilities;
  readonly reviewer?: AutoReviewer | undefined;
}): boolean {
  const posture = input.access.executionPolicy;
  if (posture !== "approval-gated" && posture !== "auto-accept-edits") return false;
  const resolved = resolveGuardrail(input);
  return resolved.status === "supported" && resolved.approver === "octant-shield";
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

/**
 * Whether outside content is recorded only: Code at Full access, where the
 * mark tags the tool row and the thread card and never asks or blocks. Work
 * is not on the shared levels, so its mark gates as before.
 */
export function outsideContentRecordedOnly(input: {
  readonly mode: ToolActionAuthority["mode"];
  readonly executionPolicy: ThreadAccess["executionPolicy"];
}): boolean {
  if (input.mode !== "code") return false;
  const guardrail = resolveGuardrail({
    access: { executionPolicy: input.executionPolicy },
    capabilities: { providerReview: true, providerSandbox: false },
    mode: "code",
  });
  return guardrail.status === "supported" && guardrail.outsideContent === "recorded";
}
