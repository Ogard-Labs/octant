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
  WorkDefaultAccess,
  WorkPlanReturnAccess,
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
  /**
   * Opt-in sandbox at Full access: when the posture is `full-access` and this
   * is set, confinement and proxied egress stay on while prompts stay off.
   * Absent or false is the default and replays older journals unchanged.
   */
  readonly fullAccessSandbox?: boolean | undefined;
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

export const FULL_ACCESS_SANDBOX_UNSUPPORTED =
  "This provider can't keep the sandbox at Full access yet, so the turn did not start. Turn the sandbox off for this thread, or use Codex or an Octant Harness model.";

/**
 * Runtimes that honor the opt-in sandbox at Full access: Codex, whose process
 * stays inside Octant's profile, Claude, whose commands keep its own sandbox
 * and whose file tools keep Octant's path gate, Pi, which launches inside the
 * wall Accept edits has with its approvals off, OpenCode, whose server runs
 * inside that wall under Full access's permission rules, ACP agents, which
 * launch inside it in their own Full access mode, and the Octant Harness,
 * whose commands run on the confined shell. Every other runtime launches unwrapped at Full
 * access, so a sandboxed thread on one of them is refused rather than run
 * open while it says it is sandboxed.
 */
export function fullAccessSandboxSupported(driverKind: ProviderDriverKind): boolean {
  return (
    driverKind === "codex" ||
    driverKind === "claude" ||
    driverKind === "pi" ||
    driverKind === "opencode" ||
    isAcpAgentKind(driverKind) ||
    isNativeHarnessDriverKind(driverKind)
  );
}

/**
 * Whether a turn must refuse to start: the thread asked for the sandbox at
 * Full access and its runtime cannot keep it. An unknown runtime refuses.
 */
export function refusesFullAccessSandbox(input: {
  readonly access: ThreadAccess;
  readonly driverKind: ProviderDriverKind | undefined;
}): boolean {
  return (
    input.access.executionPolicy === "full-access" &&
    input.access.fullAccessSandbox === true &&
    (input.driverKind === undefined || !fullAccessSandboxSupported(input.driverKind))
  );
}

/**
 * Why Octant's own terminals and commands cannot run below Full access on a
 * Windows host. Below Full access they run inside Octant's process sandbox, and
 * Windows has no sandbox Octant can use yet: its launcher is built but has not
 * run on a person's Windows machine. A provider turn is judged by
 * {@link hostProviderTurnRefusal} instead, since the provider's own approvals
 * hold it there.
 */
export const WINDOWS_SANDBOX_MISSING_REASON =
  "This needs Octant's process sandbox, which Windows does not have yet. On this computer Octant's own terminals and commands run only at Full access; switch the thread to Full access with the sandbox off, or run it on a Mac or Linux host.";

/**
 * Whether a turn at `access` needs Octant's process sandbox: every level
 * below Full access, and Full access with the sandbox kept.
 */
export function levelNeedsSandbox(access: ThreadAccess): boolean {
  return access.executionPolicy !== "full-access" || access.fullAccessSandbox === true;
}

/**
 * Why one of Octant's own terminals or commands at `access` refuses on this
 * host, or undefined when it may run. The caller passes the level the work runs at
 * (a turn's clamped level, not only the thread's stored one), and the host's
 * own platform.
 */
export function hostSandboxRefusal(input: {
  readonly platform: string | undefined;
  readonly access: ThreadAccess;
}): string | undefined {
  return input.platform === "win32" && levelNeedsSandbox(input.access)
    ? WINDOWS_SANDBOX_MISSING_REASON
    : undefined;
}

/**
 * Why Strict refuses on a Windows host below Full access. Strict runs the
 * provider inside Octant's process sandbox instead of its own approvals alone,
 * and Windows has no Octant sandbox yet; at Full access Strict confines nothing
 * on any platform, so it runs there.
 */
export const WINDOWS_STRICT_REFUSAL =
  "Strict needs a sandbox Windows doesn't have yet. Turn Strict off for this thread to run it with the provider's own approvals, or run it on a Mac or Linux host.";

/** Why Full access with the sandbox kept refuses on a Windows host. */
export const WINDOWS_KEPT_SANDBOX_REFUSAL =
  "Keeping the sandbox at Full access needs a sandbox Windows doesn't have yet. Turn Keep the sandbox off, or run it on a Mac or Linux host.";

/**
 * Why a Chat provider launch refuses on a Windows host. Chat has no folder or
 * shell, which a provider runtime is held to by Octant's sandbox; a provider's
 * own approvals do not remove its file and shell tools.
 */
export const WINDOWS_CHAT_PROVIDER_REFUSAL =
  "Chat keeps a provider without a folder or shell through Octant's sandbox, which Windows doesn't have yet. Use Work or Code, or an Octant Harness model, on this computer.";

/**
 * Why a provider turn at `access` refuses on this host, or undefined when it
 * may start. On Windows a turn below Full access runs with the provider's own
 * approvals and no Octant sandbox claimed, so only what needs Octant's sandbox
 * refuses there: Strict below Full access and Full access with the sandbox
 * kept. Octant's own terminals and commands keep {@link hostSandboxRefusal}.
 */
export function hostProviderTurnRefusal(input: {
  readonly platform: string | undefined;
  readonly access: ThreadAccess;
  readonly strict: boolean;
}): string | undefined {
  if (input.platform !== "win32") return undefined;
  if (input.access.executionPolicy === "full-access") {
    return input.access.fullAccessSandbox === true ? WINDOWS_KEPT_SANDBOX_REFUSAL : undefined;
  }
  return input.strict ? WINDOWS_STRICT_REFUSAL : undefined;
}

/**
 * How one provider launch runs on a Windows host, decided from that launch's
 * own mode, level and Strict value, so no earlier launch or cached read admits
 * another. `unconfined` starts the provider with no Octant sandbox: at Full
 * access with no approvals, below it with the provider's own approvals, every
 * ask still answered and journaled on the server. A launch that does not say
 * whether it is Strict is Strict.
 */
export type WindowsProviderLaunch =
  | { readonly status: "unconfined"; readonly approvals: "none" | "provider" }
  | { readonly status: "refused"; readonly reason: string };

export function windowsProviderLaunch(input: {
  readonly mode: "chat" | "work" | "code";
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly fullAccessSandbox?: boolean | undefined;
  readonly strict?: boolean | undefined;
}): WindowsProviderLaunch {
  if (input.mode === "chat") return { status: "refused", reason: WINDOWS_CHAT_PROVIDER_REFUSAL };
  if (input.executionPolicy === "full-access") {
    return input.fullAccessSandbox === true
      ? { status: "refused", reason: WINDOWS_KEPT_SANDBOX_REFUSAL }
      : { status: "unconfined", approvals: "none" };
  }
  if (input.strict !== false) return { status: "refused", reason: WINDOWS_STRICT_REFUSAL };
  return { status: "unconfined", approvals: "provider" };
}

/**
 * Whether a Windows host reads a provider's version and model catalog with no
 * Octant sandbox, for a read that serves no one thread: while new threads start
 * at open Full access, or while neither the Code nor the Work default in
 * Settings is Strict, since the turns such a read serves then run unconfined.
 */
export function hostReadsProviderCatalogUnconfined(input: {
  readonly code?:
    | {
        readonly defaultExecutionPolicy: ProviderExecutionPolicy;
        readonly defaultFullAccessSandbox?: boolean | undefined;
        readonly defaultStrict?: boolean | undefined;
      }
    | undefined;
  readonly work?:
    | {
        readonly defaultAccess: WorkAccess;
        readonly defaultFullAccessSandbox?: boolean | undefined;
        readonly defaultStrict?: boolean | undefined;
      }
    | undefined;
}): boolean {
  return (
    hostStartsThreadsAtOpenFullAccess(input) ||
    (input.code?.defaultStrict !== true && input.work?.defaultStrict !== true)
  );
}

/**
 * Whether this host starts new threads at Full access with the sandbox off:
 * Settings › Code's default mode, or Settings › Work's default access, with
 * the sandbox not kept. Choosing either shows the one-time Full access
 * warning. A Windows host reads a provider's model catalog unconfined only
 * then, because that catalog serves turns that run unconfined.
 */
export function hostStartsThreadsAtOpenFullAccess(input: {
  readonly code?:
    | {
        readonly defaultExecutionPolicy: ProviderExecutionPolicy;
        readonly defaultFullAccessSandbox?: boolean | undefined;
      }
    | undefined;
  readonly work?:
    | {
        readonly defaultAccess: WorkAccess;
        readonly defaultFullAccessSandbox?: boolean | undefined;
      }
    | undefined;
}): boolean {
  return (
    (input.code?.defaultExecutionPolicy === "full-access" &&
      input.code.defaultFullAccessSandbox !== true) ||
    (input.work?.defaultAccess === "full-access" && input.work.defaultFullAccessSandbox !== true)
  );
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
 * mode does, Plan included.
 */
export function workThreadAccessOf(access: WorkAccess): {
  readonly executionPolicy: ProviderExecutionPolicy;
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
    case "plan":
      return { executionPolicy: "plan", autoApprove: false };
  }
}

/**
 * Whether `access` asks for no more than `ceiling`. Plan is within every
 * level and holds only itself; Ask first is within every other level and
 * Full access holds every level; Auto and Accept edits widen different things
 * (who answers, and which writes ask), so neither holds the other.
 */
export function workAccessWithin(access: WorkAccess, ceiling: WorkAccess): boolean {
  if (access === ceiling || access === "plan") return true;
  if (ceiling === "plan") return false;
  return access === "ask-first" || ceiling === "full-access";
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

/**
 * The Work default (Settings › Work, a Work Project's start mode) a Code mode
 * picker choice stands for; Plan has none, since no thread starts in Plan.
 */
export function workAccessOfPermissionMode(mode: PermissionMode): WorkDefaultAccess | undefined {
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

/** The level a Work thread's mode picker choice sets, Plan included. */
export function workThreadAccessOfMode(mode: PermissionMode): WorkAccess {
  return workAccessOfPermissionMode(mode) ?? "plan";
}

/** The Code mode picker choice a Work access stands for. */
export function permissionModeOfWorkAccess(access: WorkAccess): PermissionMode {
  switch (access) {
    case "auto":
      return "auto";
    case "ask-first":
      return "ask-first";
    case "auto-accept-edits":
      return "accept-edits";
    case "full-access":
      return "full-access";
    case "plan":
      return "plan";
  }
}

/**
 * Where an agent's ask to change a Work thread's level takes it, as
 * `levelChangeTarget` does for Code: entering Plan remembers the level it
 * left, never Full access, which only the person chooses; leaving Plan
 * returns there, or to Ask first when nothing guarded was recorded.
 */
export function workLevelChangeTarget(
  thread: { readonly access: WorkAccess; readonly planReturnAccess?: WorkAccess | undefined },
  kind: "enter-plan" | "exit-plan",
): { readonly to: WorkAccess; readonly planReturnAccess?: WorkPlanReturnAccess } {
  if (kind === "enter-plan")
    return { to: "plan", planReturnAccess: workPlanReturnOf(thread.access) };
  return { to: workPlanReturnOf(thread.planReturnAccess ?? "ask-first") };
}

/** The guarded level a thread leaving `access` for Plan comes back to. */
export function workPlanReturnOf(access: WorkAccess): WorkPlanReturnAccess {
  return access === "full-access" || access === "plan" ? "ask-first" : access;
}

/**
 * What a Work turn records about the level it ran at: shell and Git follow
 * the level as they do in Code (Plan grants neither; at most a sandbox holds
 * a shell to read-only programs), and a Full access turn runs with no OS
 * sandbox. Worktrees, pull requests and Code checkouts stay Code's.
 */
export function workTurnCapabilityFacts(
  access: WorkAccess,
  fullAccessSandbox = false,
): WorkTurnCapabilityFacts {
  const level = guardrailLevelOf(workThreadAccessOf(access));
  const shell = access === "plan" ? "denied" : level;
  return {
    workspace: "project-backed",
    confinement:
      level === "full-access" && !fullAccessSandbox ? "unconfined" : "project-root-confined",
    shell,
    git: shell,
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
  const sandboxedFullAccess =
    input.access.executionPolicy === "full-access" && input.access.fullAccessSandbox === true;
  const egress = guardrailEgress(surfaceMode, input.access.executionPolicy, sandboxedFullAccess);
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
      // or the provider's, and nobody asked. Network is open. The opt-in
      // `fullAccessSandbox` flag keeps Octant's confinement and proxied egress
      // while leaving every approval answered allow.
      return {
        status: "supported",
        level,
        mode,
        readOnly: false,
        folderEditsWaived: true,
        sandbox: sandboxedFullAccess ? (ownSandbox ? "both" : "octant") : "none",
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
  sandboxedFullAccess = false,
): ToolNetworkEgressPolicy {
  if (mode === "chat") return "none";
  if (executionPolicy === "plan") return "none";
  // Auto-accepting edits says nothing about the network, so it keeps exactly
  // the egress approval-gated Code already has.
  if (executionPolicy === "approval-gated" || executionPolicy === "auto-accept-edits") {
    return "provider-endpoints-only";
  }
  // Full access opens the network, unless the thread opted into the sandbox,
  // which keeps the same proxied egress the guarded levels have.
  if (executionPolicy === "full-access" && sandboxedFullAccess) return "provider-endpoints-only";
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
 * Whether a new thread that starts at Full access keeps the sandbox, when the
 * request that created it did not say: the Project's choice, else Settings',
 * else off (Full access stays open, as it always was).
 */
export function defaultFullAccessSandboxFor(input: {
  readonly project?: { readonly defaultFullAccessSandbox?: boolean | undefined } | undefined;
  readonly settings?: { readonly defaultFullAccessSandbox?: boolean | undefined } | undefined;
}): boolean {
  return (
    input.project?.defaultFullAccessSandbox ?? input.settings?.defaultFullAccessSandbox ?? false
  );
}

/** Why the host refuses `octant agent --full-access` for a thread Strict covers. */
export const STRICT_REFUSES_FULL_ACCESS_RUN_FLAG =
  "Strict is on for this thread, and Strict refuses the per-run Full access flag. Turn Strict off for the thread, its Project or in Settings to use it.";

/**
 * Whether Strict is on for one launch or call: the thread's own choice, else
 * its Project's, else Settings', else off. Read at each launch and each call,
 * never stamped on the thread, so a thread that never chose follows its
 * Project and Settings as they are now. Strict restores the protections Octant
 * adds beside a provider's own (Architecture: "Octant adds no restrictions of
 * its own unless Strict is on"); off, the provider's own settings decide.
 */
export function resolveStrict(input: {
  readonly thread?: { readonly strict?: boolean | undefined } | undefined;
  readonly project?: { readonly defaultStrict?: boolean | undefined } | undefined;
  readonly settings?: { readonly defaultStrict?: boolean | undefined } | undefined;
}): boolean {
  return (
    input.thread?.strict ?? input.project?.defaultStrict ?? input.settings?.defaultStrict ?? false
  );
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

/** Why an allow answered after the thread's posture changed is refused. */
export const APPROVAL_POSTURE_CHANGED_MESSAGE =
  "This thread's permissions changed since this was asked, so it asks again.";

/**
 * The posture a pending approval is asked under, as one comparable value: the
 * mode, who answers prompts, the Full access sandbox, how long a grant lasts,
 * and the coordinator gate. Two asks under the same posture read the same.
 */
export function approvalPostureOf(
  access: ThreadAccess & {
    readonly permissionPersistence?: string | undefined;
    readonly coordinator?: boolean | undefined;
  },
): string {
  return JSON.stringify([
    access.executionPolicy,
    access.autoApprove === true,
    access.fullAccessSandbox === true,
    access.permissionPersistence ?? null,
    access.coordinator === true,
  ]);
}

/** A Work thread's posture for {@link approvalPostureOf}: its access level and sandbox. */
export function workApprovalPostureOf(thread: {
  readonly access: WorkAccess;
  readonly fullAccessSandbox?: boolean | undefined;
}): string {
  return approvalPostureOf({
    ...workThreadAccessOf(thread.access),
    fullAccessSandbox: thread.fullAccessSandbox,
  });
}

/**
 * Whether a person's answer to a pending approval may reach the provider. An
 * allow given under a wider posture must not take effect after the person
 * narrowed it, and an allow given under any other posture than the one the
 * thread holds now was not decided against it, so either is asked again under
 * the current posture. A denial never widens and is delivered as given. A
 * posture that cannot be read matches nothing.
 */
export function approvalAnswerUnderPosture(input: {
  readonly approved: boolean;
  readonly askedUnder: string | undefined;
  readonly current: string | undefined;
}): "deliver" | "ask-again" {
  if (!input.approved) return "deliver";
  return input.askedUnder !== undefined && input.askedUnder === input.current
    ? "deliver"
    : "ask-again";
}
