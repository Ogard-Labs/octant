import { isAcpAgentKind } from "@octant/contracts/acp-agent-profiles";
import type {
  AutoReviewer,
  GuardrailLevel,
  ProviderDriverKind,
  PermissionMode,
  ProviderExecutionPolicy,
  ToolActionAuthority,
  ToolNetworkEgressPolicy,
  WorkAccess,
  WorkTurnCapabilityFacts,
} from "@octant/contracts";
import { isNativeHarnessDriverKind } from "./providerPolicy";

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
 * The posture a Work thread's access stores. Work and Code share one
 * capability set, so a Work level runs a session exactly as the same Code
 * mode does; Work has no Plan overlay.
 */
export function workThreadAccessOf(access: WorkAccess): {
  readonly executionPolicy: Exclude<ProviderExecutionPolicy, "plan">;
  readonly autoApprove: boolean;
} {
  switch (access) {
    case "ask-first":
      return { executionPolicy: "approval-gated", autoApprove: false };
    case "auto":
      return { executionPolicy: "approval-gated", autoApprove: true };
    case "auto-accept-edits":
      return { executionPolicy: "auto-accept-edits", autoApprove: false };
    case "full-access":
      return { executionPolicy: "full-access", autoApprove: false };
  }
}

/**
 * Whether `access` asks for no more than `ceiling`. Ask first is within
 * every level and Full access holds every level; Auto and Accept edits widen
 * different things (who answers, and which writes ask), so neither holds the
 * other.
 */
export function workAccessWithin(access: WorkAccess, ceiling: WorkAccess): boolean {
  return access === ceiling || access === "ask-first" || ceiling === "full-access";
}

/**
 * The level a turn runs at when its caller's authority (a goal-loop round, a
 * routine, a delegation) is `ceiling`: the thread's own when the ceiling
 * holds it, else the ceiling when the thread holds that, else Ask first.
 */
export function clampWorkAccess(thread: WorkAccess, ceiling: WorkAccess): WorkAccess {
  if (workAccessWithin(thread, ceiling)) return thread;
  if (workAccessWithin(ceiling, thread)) return ceiling;
  return "ask-first";
}

/** The Work access a Code mode picker choice stands for; Plan has none. */
export function workAccessOfPermissionMode(mode: PermissionMode): WorkAccess | undefined {
  switch (mode) {
    case "auto":
      return "auto";
    case "ask-first":
      return "ask-first";
    case "accept-edits":
      return "auto-accept-edits";
    case "full-access":
      return "full-access";
    case "plan":
      return undefined;
  }
}

/**
 * What a Work turn records about the level it ran at: shell and Git follow
 * the level as they do in Code, and a Full access turn runs with no OS
 * sandbox. Worktrees, pull requests and Code checkouts stay Code's.
 */
export function workTurnCapabilityFacts(access: WorkAccess): WorkTurnCapabilityFacts {
  const level = guardrailLevelOf(workThreadAccessOf(access));
  return {
    workspace: "project-backed",
    confinement: level === "full-access" ? "unconfined" : "project-root-confined",
    shell: level,
    git: level,
    worktree: "denied",
    pullRequest: "denied",
    code: "denied",
  };
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

/** The Auto reviewer a thread's person chose: its Project's, else Settings'. */
export function chosenAutoReviewer(input: {
  readonly project?: { readonly autoReviewer?: AutoReviewer | undefined } | undefined;
  readonly settings?: { readonly autoReviewer?: AutoReviewer | undefined } | undefined;
}): AutoReviewer | undefined {
  return input.project?.autoReviewer ?? input.settings?.autoReviewer;
}

/**
 * Runtimes whose approval prompts reach Octant before the call runs, so
 * Octant Shield can answer them: the Octant Harness, whose tool calls pass
 * Octant's approval path, the Anthropic and OpenAI coding runtimes
 * (`canUseTool`, app-server approval requests), OpenCode (`permission.asked`),
 * every ACP agent (`session/request_permission`), and Pi (its extension's
 * confirmation).
 */
export function shieldRoutesApprovals(driverKind: ProviderDriverKind): boolean {
  if (isNativeHarnessDriverKind(driverKind) || isAcpAgentKind(driverKind)) return true;
  return (
    driverKind === "claude" ||
    driverKind === "codex" ||
    driverKind === "opencode" ||
    driverKind === "pi"
  );
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
 * Approved egress defaults (2026-08-12): Chat and Plan get none; Work and Code
 * at a prompting posture get provider endpoints only; Work and Code at Full
 * access are unrestricted. Work and Code are guarded identically
 * (2026-10-31), so Work's egress follows the level as Code's does. The
 * Seatbelt builder materializes it.
 */
function guardrailEgress(
  mode: ToolActionAuthority["mode"],
  executionPolicy: ProviderExecutionPolicy,
): ToolNetworkEgressPolicy {
  if (mode === "chat") return "none";
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
 * Whether outside content is recorded only: Work or Code at Full access, where
 * the mark tags the tool row and the thread card and never asks or blocks.
 * It follows the level the thread runs at, so a person turns the gate down
 * for one thread, or for a Project's new threads, by setting that scope's
 * level, and back up the same way. Chat never reaches Full access.
 */
export function outsideContentRecordedOnly(input: {
  readonly mode: ToolActionAuthority["mode"];
  readonly executionPolicy: ThreadAccess["executionPolicy"];
}): boolean {
  if (input.mode === "chat") return false;
  const guardrail = resolveGuardrail({
    access: { executionPolicy: input.executionPolicy },
    capabilities: { providerReview: true, providerSandbox: false },
    mode: input.mode,
  });
  return guardrail.status === "supported" && guardrail.outsideContent === "recorded";
}

/**
 * Whether moving from one mode to another lowers the guardrail and so is
 * journaled. Ask first and Plan are the most guarded postures, so a move to
 * either never counts. Auto and Accept edits each waive something different
 * (who answers, which writes ask) and neither holds the other, so a move
 * between them counts too: the record errs toward more of the person's
 * changes being kept.
 */
export function guardrailLowered(from: PermissionMode, to: PermissionMode): boolean {
  return from !== to && to !== "ask-first" && to !== "plan";
}

/**
 * The mode a new Work thread starts in: the Project's own choice, else Work's
 * default in Settings, else Ask first.
 */
export function defaultWorkPermissionModeFor(input: {
  readonly project?: { readonly defaultPermissionMode?: PermissionMode | undefined } | undefined;
  readonly settings?: { readonly defaultAccess: WorkAccess } | undefined;
}): PermissionMode {
  return (
    input.project?.defaultPermissionMode ??
    permissionModeOf(workThreadAccessOf(input.settings?.defaultAccess ?? "ask-first"))
  );
}

export type GuardrailLevelScope = "global" | "project" | "thread";

/**
 * Where a thread's level in force comes from. A thread keeps the level it
 * started with, so the scope is read from the settings as they stand: a level
 * equal to its Project's override is the Project's, else one equal to the
 * global default is the global one, else the person set it on the thread.
 */
export function guardrailScopeOf(input: {
  readonly mode: PermissionMode;
  readonly projectDefault?: PermissionMode | undefined;
  readonly globalDefault: PermissionMode;
}): GuardrailLevelScope {
  if (input.projectDefault !== undefined) {
    return input.mode === input.projectDefault ? "project" : "thread";
  }
  return input.mode === input.globalDefault ? "global" : "thread";
}
