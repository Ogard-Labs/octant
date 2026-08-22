import type {
  AgentRun,
  AgentRunAuthority,
  AgentRunCommand,
  AgentRunCreationPosture,
  AgentRunLifecycleStatus,
  AgentRunResult,
  AgentRunRoutingReceipt,
  AggregateVersion,
  UtcTimestamp,
} from "@octant/contracts";
import {
  AGENT_RUN_TERMINAL_STATUSES,
  MAX_AGENT_RUN_RESULT_CHARACTERS,
  decodeAgentRunLifecycleStatus,
} from "@octant/contracts";

export type AgentRunPolicyRejectionCode =
  | "posture-rejected"
  | "authority-widening"
  | "limit-reached"
  | "unsupported-transition"
  | "stale-version"
  | "fallback-forbidden"
  | "invalid-completion"
  | "invalid-acknowledgement"
  | "invalid-depth"
  | "invalid-workspace"
  | "pool-route-invalid";

export class AgentRunPolicyRejected extends Error {
  override readonly name = "AgentRunPolicyRejected";

  constructor(
    readonly code: AgentRunPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: AgentRunPolicyRejectionCode, message: string): never {
  throw new AgentRunPolicyRejected(code, message);
}

/**
 * The stable identity of one run's persisted reply.
 *
 * A completion may only reference the reply this journal actually stores for
 * that run, so the reference is derived from the run instead of supplied by
 * whatever observed the session. Anything holding a reference can name the run
 * it belongs to, and reading the run yields the reply itself.
 */
export function agentRunResultReference(runId: AgentRun["id"]): string {
  return `octant://agent-run/${String(runId)}/result`;
}

export const AGENT_RUN_MAX_DEPTH = 2;
export const AGENT_RUN_MAX_ACTIVE_GLOBAL = 4;
export const AGENT_RUN_MAX_ACTIVE_PER_PARENT = 3;

export function isAgentRunTerminalStatus(status: AgentRunLifecycleStatus): boolean {
  return (AGENT_RUN_TERMINAL_STATUSES as ReadonlyArray<string>).includes(status);
}

export function isAgentRunActiveStatus(status: AgentRunLifecycleStatus): boolean {
  return (
    status === "queued" || status === "starting" || status === "running" || status === "waiting"
  );
}

export function assertCreationPostureAllowsAdmission(
  posture: AgentRunCreationPosture,
  options: { readonly confirmed: boolean },
): void {
  if (posture === "off") {
    reject("posture-rejected", "Subagent creation posture is Off.");
  }
  if (posture === "ask" && !options.confirmed) {
    reject("posture-rejected", "Subagent creation posture requires confirmation.");
  }
}

export function clampAgentRunAuthority(input: {
  readonly parentAuthority: AgentRunAuthority;
  readonly requestedAuthority: AgentRunAuthority;
  readonly projectCeiling?: AgentRunAuthority;
  readonly globalCeiling?: AgentRunAuthority;
  /**
   * Parent thread's live effective grant. When provided it is intersected as a
   * ceiling alongside parent/project/global. Mode ceilings alone must not
   * substitute for a narrower live grant.
   */
  readonly liveParentGrant?: AgentRunAuthority;
}): AgentRunAuthority {
  const ceilings = [
    input.parentAuthority,
    input.liveParentGrant,
    input.projectCeiling,
    input.globalCeiling,
  ].filter((value): value is AgentRunAuthority => value !== undefined);

  const intersectBoolean = (
    key: keyof Omit<AgentRunAuthority, "executionPolicy" | "permissionPersistence">,
  ) => input.requestedAuthority[key] && ceilings.every((ceiling) => ceiling[key]);

  const executionRank: Record<AgentRunAuthority["executionPolicy"], number> = {
    plan: 0,
    "approval-gated": 1,
    "auto-accept-edits": 2,
    "full-access": 3,
  };
  const minPolicy = ceilings.reduce<AgentRunAuthority["executionPolicy"]>((current, ceiling) => {
    return executionRank[ceiling.executionPolicy] < executionRank[current]
      ? ceiling.executionPolicy
      : current;
  }, input.requestedAuthority.executionPolicy);

  // Permission persistence may narrow from project-default to current-session only.
  const permissionPersistence =
    input.requestedAuthority.permissionPersistence === "project-default" &&
    ceilings.every((ceiling) => ceiling.permissionPersistence === "project-default")
      ? "project-default"
      : "current-session";

  const clamped: AgentRunAuthority = {
    filesystem: intersectBoolean("filesystem"),
    shell: intersectBoolean("shell"),
    git: intersectBoolean("git"),
    network: intersectBoolean("network"),
    tools: intersectBoolean("tools"),
    subagents: intersectBoolean("subagents"),
    executionPolicy: minPolicy,
    permissionPersistence,
  };

  // Fail closed if the request asked to widen any capability beyond ceilings.
  for (const key of ["filesystem", "shell", "git", "network", "tools", "subagents"] as const) {
    if (input.requestedAuthority[key] && !clamped[key]) {
      reject(
        "authority-widening",
        `Child authority cannot widen ${key} beyond parent/project ceilings.`,
      );
    }
  }
  if (
    executionRank[input.requestedAuthority.executionPolicy] > executionRank[clamped.executionPolicy]
  ) {
    reject(
      "authority-widening",
      "Child execution policy cannot be more privileged than parent/project ceilings.",
    );
  }
  if (
    input.requestedAuthority.permissionPersistence === "project-default" &&
    clamped.permissionPersistence !== "project-default"
  ) {
    reject(
      "authority-widening",
      "Child permission persistence cannot escalate beyond current ceilings.",
    );
  }

  return clamped;
}

/**
 * Clamp a child request against both the mode-derived ceiling and the parent
 * thread's live effective grant. The live grant must itself stay within the
 * mode ceiling; a forged or drifted live grant that claims wider authority
 * fails closed before the child request is considered.
 */
export function clampAgentRunAuthorityAgainstLiveGrant(input: {
  readonly modeCeiling: AgentRunAuthority;
  readonly liveParentGrant: AgentRunAuthority;
  readonly requestedAuthority: AgentRunAuthority;
  readonly projectCeiling?: AgentRunAuthority;
  readonly globalCeiling?: AgentRunAuthority;
}): AgentRunAuthority {
  assertLiveParentGrantWithinModeCeiling(input.liveParentGrant, input.modeCeiling);
  return clampAgentRunAuthority({
    parentAuthority: input.modeCeiling,
    liveParentGrant: input.liveParentGrant,
    requestedAuthority: input.requestedAuthority,
    ...(input.projectCeiling === undefined ? {} : { projectCeiling: input.projectCeiling }),
    ...(input.globalCeiling === undefined ? {} : { globalCeiling: input.globalCeiling }),
  });
}

function assertLiveParentGrantWithinModeCeiling(
  liveParentGrant: AgentRunAuthority,
  modeCeiling: AgentRunAuthority,
): void {
  const booleanKeys = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;
  for (const key of booleanKeys) {
    if (liveParentGrant[key] && !modeCeiling[key]) {
      reject(
        "authority-widening",
        `Live parent grant cannot widen ${key} beyond the mode ceiling.`,
      );
    }
  }
  const executionRank: Record<AgentRunAuthority["executionPolicy"], number> = {
    plan: 0,
    "approval-gated": 1,
    "auto-accept-edits": 2,
    "full-access": 3,
  };
  if (executionRank[liveParentGrant.executionPolicy] > executionRank[modeCeiling.executionPolicy]) {
    reject(
      "authority-widening",
      "Live parent grant cannot exceed the mode ceiling execution policy.",
    );
  }
  if (
    liveParentGrant.permissionPersistence === "project-default" &&
    modeCeiling.permissionPersistence !== "project-default"
  ) {
    reject(
      "authority-widening",
      "Live parent grant cannot escalate permission persistence beyond the mode ceiling.",
    );
  }
}

/**
 * Code children require a verified isolated worktree that is equal-or-narrower
 * than the parent checkout (never the parent checkout itself). Chat virtual
 * and Work root receipts are accepted as already mode-scoped.
 */
export function assertAgentRunSandboxEqualOrNarrower(input: {
  readonly childWorkspace: AgentRun["workspaceReceipt"];
}): void {
  const workspace = input.childWorkspace;
  if (workspace.kind === "chat-virtual" || workspace.kind === "work-root") {
    return;
  }
  if (workspace.kind !== "code-worktree") {
    reject("invalid-workspace", "Unsupported AgentRun workspace sandbox.");
  }
  if (!workspace.verified) {
    reject("invalid-workspace", "Code worktree must be verified before execution.");
  }
  if (workspace.worktreeRoot === workspace.checkoutRoot) {
    reject(
      "invalid-workspace",
      "Code child sandbox must be an isolated worktree, not the parent checkout.",
    );
  }
  if (
    workspace.worktreeRoot.length === 0 ||
    workspace.checkoutRoot.length === 0 ||
    workspace.worktreeRoot.includes("\0") ||
    workspace.checkoutRoot.includes("\0")
  ) {
    reject("invalid-workspace", "Code child sandbox paths are invalid.");
  }
}

export function validateAgentRunDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 0 || depth > AGENT_RUN_MAX_DEPTH) {
    reject("invalid-depth", `AgentRun depth must be between 0 and ${AGENT_RUN_MAX_DEPTH}.`);
  }
}

export function assertAgentRunCapacityAvailable(input: {
  readonly activeGlobal: number;
  readonly activeForParent: number;
}): void {
  if (input.activeGlobal >= AGENT_RUN_MAX_ACTIVE_GLOBAL) {
    reject(
      "limit-reached",
      `Global active AgentRun limit reached (${AGENT_RUN_MAX_ACTIVE_GLOBAL}).`,
    );
  }
  if (input.activeForParent >= AGENT_RUN_MAX_ACTIVE_PER_PARENT) {
    reject(
      "limit-reached",
      `Per-parent active AgentRun limit reached (${AGENT_RUN_MAX_ACTIVE_PER_PARENT}).`,
    );
  }
}

export function validateFallbackSelection(receipt: AgentRunRoutingReceipt): void {
  if (receipt.selectedFallback === undefined) return;

  const selected = receipt.selectedFallback;
  // Fallback cannot change host/mode/project scope already sealed into the receipt.
  // Those fields are part of the immutable receipt and therefore already fixed; this
  // policy rejects fallbacks that claim a different provider/model without reason or
  // that omit an explicit reason.
  if (selected.reason.trim().length === 0) {
    reject("fallback-forbidden", "Fallback selection requires an explicit reason.");
  }

  // Forbid silent provider/model identity loss.
  if (
    selected.providerInstanceId === receipt.selectedProviderInstanceId &&
    selected.modelId === receipt.selectedModelId
  ) {
    reject("fallback-forbidden", "Fallback selection must differ from the primary selection.");
  }

  // Cost/authority widening cannot be proven purely from IDs; require that any
  // degradation be recorded rather than treated as free.
  if (receipt.usageQuality === "unavailable") {
    // Unknown accounting is allowed only as explicit unknown, not as zero.
    // The presence of selectedFallback with unavailable usage is permitted but
    // must remain visible via usageQuality.
  }
}

/** Recovery reason recorded when a pool decision found no eligible candidate. */
export const AGENT_RUN_POOL_WAITING_REASON = "multi-model-pool-no-eligible-candidate";

/**
 * The provider/model that actually executes for a routing receipt: the
 * recorded explicit fallback when one was selected, otherwise the primary
 * (requested) selection. Capacity reservation and process spawn must use
 * this target, never blindly the primary selection.
 */
export function effectiveAgentRunExecutionTarget(receipt: AgentRunRoutingReceipt): {
  readonly providerInstanceId: AgentRunRoutingReceipt["selectedProviderInstanceId"];
  readonly modelId: AgentRunRoutingReceipt["selectedModelId"];
} {
  return receipt.selectedFallback === undefined
    ? { providerInstanceId: receipt.selectedProviderInstanceId, modelId: receipt.selectedModelId }
    : {
        providerInstanceId: receipt.selectedFallback.providerInstanceId,
        modelId: receipt.selectedFallback.modelId,
      };
}

/**
 * A pool route that decided "waiting" admits the child durably but must not
 * reserve capacity or start execution; it enters Waiting with this reason.
 */
export function agentRunPoolRouteWaitingReason(
  receipt: AgentRunRoutingReceipt,
): string | undefined {
  return receipt.poolRoute?.decision.kind === "waiting" ? AGENT_RUN_POOL_WAITING_REASON : undefined;
}

/**
 * Fail-closed consistency between an immutable pool-derived route decision
 * and the routing receipt that carries it. The receipt primary selection is
 * the pool's requested candidate; a fallback decision must surface the
 * explicit fallback it selected; a waiting or requested decision may not
 * claim one; and the decision cannot be re-scoped to another host or mode.
 */
export function validateAgentRunPoolRoute(receipt: AgentRunRoutingReceipt): void {
  const poolRoute = receipt.poolRoute;
  if (poolRoute === undefined) return;
  const decision = poolRoute.decision;
  const requested = decision.request.requestedCandidate ?? decision.request.pool.candidates[0];
  if (requested === undefined) {
    reject("pool-route-invalid", "AgentRun pool route has no requested candidate.");
  }
  if (decision.mode !== receipt.mode) {
    reject("pool-route-invalid", "AgentRun pool route mode must match the routing receipt mode.");
  }
  if (String(decision.activeHostId) !== String(receipt.hostId)) {
    reject("pool-route-invalid", "AgentRun pool route host must match the routing receipt host.");
  }
  if (
    String(requested.hostId) !== String(receipt.hostId) ||
    requested.providerInstanceId !== receipt.selectedProviderInstanceId ||
    requested.modelId !== receipt.selectedModelId
  ) {
    reject(
      "pool-route-invalid",
      "AgentRun pool route requested candidate must match the receipt primary selection.",
    );
  }
  if (decision.kind === "waiting" || decision.selectionKind === "requested") {
    if (receipt.selectedFallback !== undefined) {
      reject(
        "pool-route-invalid",
        "AgentRun pool route without a fallback decision cannot record a selected fallback.",
      );
    }
    return;
  }
  if (
    receipt.selectedFallback === undefined ||
    receipt.selectedFallback.providerInstanceId !== decision.selectedCandidate.providerInstanceId ||
    receipt.selectedFallback.modelId !== decision.selectedCandidate.modelId
  ) {
    reject(
      "pool-route-invalid",
      "AgentRun pool fallback route must surface the explicit fallback it selected.",
    );
  }
}

export function validateWorkspaceReceipt(
  run: Pick<AgentRun, "workspaceReceipt" | "routingReceipt">,
): void {
  const workspace = run.workspaceReceipt;
  const mode = run.routingReceipt.mode;
  if (workspace.mode !== mode) {
    reject("invalid-workspace", "Workspace receipt mode must match routing mode.");
  }
  if (workspace.kind === "chat-virtual" && mode !== "chat") {
    reject("invalid-workspace", "Chat virtual workspace is only valid for chat mode.");
  }
  if (workspace.kind === "work-root" && mode !== "work") {
    reject("invalid-workspace", "Work root workspace is only valid for work mode.");
  }
  if (workspace.kind === "code-worktree") {
    if (mode !== "code") {
      reject("invalid-workspace", "Code worktree workspace is only valid for code mode.");
    }
    if (!workspace.verified) {
      reject("invalid-workspace", "Code worktree must be verified before execution.");
    }
    assertAgentRunSandboxEqualOrNarrower({ childWorkspace: workspace });
  }
}

function nextVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}

function assertExpectedVersion(run: AgentRun, expectedVersion: AggregateVersion): void {
  if (run.version !== expectedVersion) {
    reject("stale-version", `Expected version ${expectedVersion}, got ${run.version}`);
  }
}

const allowedTransitions: Record<
  AgentRunLifecycleStatus,
  ReadonlyArray<AgentRunLifecycleStatus>
> = {
  queued: ["starting", "waiting", "cancelled", "failed", "interrupted"],
  starting: ["running", "waiting", "failed", "cancelled", "interrupted"],
  running: ["waiting", "completed", "failed", "cancelled", "interrupted"],
  waiting: ["starting", "running", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
  interrupted: ["queued", "starting"],
};

export function assertAgentRunTransitionAllowed(
  from: AgentRunLifecycleStatus,
  to: AgentRunLifecycleStatus,
): void {
  decodeAgentRunLifecycleStatus(from);
  decodeAgentRunLifecycleStatus(to);
  if (from === to) {
    reject("unsupported-transition", `AgentRun is already ${from}.`);
  }
  if (!allowedTransitions[from].includes(to)) {
    reject("unsupported-transition", `Cannot transition AgentRun from ${from} to ${to}.`);
  }
  if (to === "completed" && (from === "queued" || from === "starting")) {
    reject("invalid-completion", "Completed requires an observed running child result.");
  }
}

export function applyAgentRunLifecycleTransition(
  run: AgentRun,
  toStatus: AgentRunLifecycleStatus,
  now: UtcTimestamp,
  options: {
    readonly expectedVersion: AggregateVersion;
    readonly recoveryReason?: string;
    readonly result?: AgentRunResult;
    /**
     * The reply text the completion stores. It is validated here and recorded
     * beside the run, never on it: the run keeps only the reply's identity.
     */
    readonly resultText?: string;
  },
): AgentRun {
  assertExpectedVersion(run, options.expectedVersion);
  assertAgentRunTransitionAllowed(run.lifecycleStatus, toStatus);

  if (toStatus === "completed") {
    const result = options.result;
    const resultText = options.resultText;
    if (result === undefined || resultText === undefined || resultText.trim().length === 0) {
      reject("invalid-completion", "Completed requires the reply the child produced.");
    }
    if (resultText.length > MAX_AGENT_RUN_RESULT_CHARACTERS) {
      reject("invalid-completion", "Completed requires a bounded result reply.");
    }
    if (result.reference !== agentRunResultReference(run.id)) {
      reject("invalid-completion", "Completed requires the result reference of this run's reply.");
    }
  }

  if (
    (toStatus === "waiting" || toStatus === "failed" || toStatus === "interrupted") &&
    (options.recoveryReason === undefined || options.recoveryReason.trim().length === 0)
  ) {
    reject("unsupported-transition", `${toStatus} requires a recovery reason.`);
  }

  const version = nextVersion(run.version);
  return {
    ...run,
    lifecycleStatus: toStatus,
    // A recovery reason describes the current blocked or terminal state. Once
    // a capacity waiter starts again, retaining "capacity saturated" would
    // incorrectly report that the active child is still blocked.
    recoveryReason: options.recoveryReason,
    ...(toStatus === "completed" && options.result !== undefined ? { result: options.result } : {}),
    resultAcknowledgement:
      toStatus === "completed"
        ? {
            required: true,
            acknowledged: false,
            followUpReason: "unacknowledged-child-result",
          }
        : run.resultAcknowledgement,
    version,
    updatedAt: now,
  };
}

export function acknowledgeAgentRunResult(
  run: AgentRun,
  now: UtcTimestamp,
  expectedVersion: AggregateVersion,
): AgentRun {
  assertExpectedVersion(run, expectedVersion);
  if (run.lifecycleStatus !== "completed") {
    reject("invalid-acknowledgement", "Only completed AgentRuns can be acknowledged.");
  }
  if (!run.resultAcknowledgement.required) {
    reject("invalid-acknowledgement", "AgentRun result acknowledgement is not required.");
  }
  if (run.resultAcknowledgement.acknowledged) {
    reject("invalid-acknowledgement", "AgentRun result is already acknowledged.");
  }
  return {
    ...run,
    resultAcknowledgement: {
      required: true,
      acknowledged: true,
      acknowledgedAt: now,
    },
    version: nextVersion(run.version),
    updatedAt: now,
  };
}

export function evaluateAgentRunCommand(
  run: AgentRun | undefined,
  command: AgentRunCommand,
  now: UtcTimestamp,
): AgentRun {
  switch (command.kind) {
    case "request-agent-run": {
      if (run !== undefined) {
        reject("unsupported-transition", "AgentRun already exists for this command.");
      }
      // request command itself is admitted only as queued/waiting confirmation.
      throw new Error(
        "request-agent-run must be materialized by the caller with createAgentRunFromRequest",
      );
    }
    case "confirm-agent-run":
    case "start-agent-run":
    case "mark-agent-run-running":
    case "wait-agent-run":
    case "complete-agent-run":
    case "fail-agent-run":
    case "cancel-agent-run":
    case "interrupt-agent-run":
    case "retry-agent-run":
    case "resume-agent-run": {
      if (run === undefined) {
        reject("unsupported-transition", "AgentRun does not exist.");
      }
      break;
    }
    case "acknowledge-agent-run-result": {
      if (run === undefined) {
        reject("unsupported-transition", "AgentRun does not exist.");
      }
      return acknowledgeAgentRunResult(run, now, command.expectedVersion);
    }
  }

  // narrow after existence check
  const current = run as AgentRun;
  switch (command.kind) {
    case "confirm-agent-run":
      // confirmation moves ask-queued request into starting only via explicit start later.
      assertExpectedVersion(current, command.expectedVersion);
      return current;
    case "start-agent-run":
      return applyAgentRunLifecycleTransition(current, "starting", now, {
        expectedVersion: command.expectedVersion,
      });
    case "mark-agent-run-running":
      return applyAgentRunLifecycleTransition(current, "running", now, {
        expectedVersion: command.expectedVersion,
      });
    case "wait-agent-run":
      return applyAgentRunLifecycleTransition(current, "waiting", now, {
        expectedVersion: command.expectedVersion,
        recoveryReason: command.recoveryReason,
      });
    case "complete-agent-run":
      return applyAgentRunLifecycleTransition(current, "completed", now, {
        expectedVersion: command.expectedVersion,
        result: command.result,
        resultText: command.resultText,
      });
    case "fail-agent-run":
      return applyAgentRunLifecycleTransition(current, "failed", now, {
        expectedVersion: command.expectedVersion,
        recoveryReason: command.recoveryReason,
      });
    case "cancel-agent-run":
      return applyAgentRunLifecycleTransition(current, "cancelled", now, {
        expectedVersion: command.expectedVersion,
      });
    case "interrupt-agent-run":
      return applyAgentRunLifecycleTransition(current, "interrupted", now, {
        expectedVersion: command.expectedVersion,
        recoveryReason: command.recoveryReason,
      });
    case "retry-agent-run":
      return applyAgentRunLifecycleTransition(current, "queued", now, {
        expectedVersion: command.expectedVersion,
      });
    case "resume-agent-run":
      return applyAgentRunLifecycleTransition(current, "starting", now, {
        expectedVersion: command.expectedVersion,
      });
    default:
      return current;
  }
}

export function createAgentRunFromRequest(input: {
  readonly runId: AgentRun["id"];
  readonly command: Extract<AgentRunCommand, { kind: "request-agent-run" }>;
  /** Resolved from the persisted parent, never supplied by the child request. */
  readonly parentDepth?: number;
  readonly parentAuthority: AgentRunAuthority;
  /**
   * Parent thread's live effective grant. When omitted, `parentAuthority` is
   * treated as both the mode/parent ceiling and the live grant (legacy call
   * sites). Prefer passing the live grant explicitly so mode ceilings cannot
   * silently substitute for a narrower thread grant.
   */
  readonly liveParentGrant?: AgentRunAuthority;
  readonly projectCeiling?: AgentRunAuthority;
  readonly globalCeiling?: AgentRunAuthority;
  readonly activeGlobal: number;
  readonly activeForParent: number;
  readonly confirmed: boolean;
  readonly now: UtcTimestamp;
}): AgentRun {
  assertCreationPostureAllowsAdmission(input.command.creationPosture, {
    confirmed: input.confirmed,
  });
  const depth =
    input.command.parentRunId === undefined
      ? 0
      : input.parentDepth === undefined
        ? reject("invalid-depth", "AgentRun parent depth must be resolved before admission.")
        : input.parentDepth + 1;
  validateAgentRunDepth(depth);
  assertAgentRunCapacityAvailable({
    activeGlobal: input.activeGlobal,
    activeForParent: input.activeForParent,
  });
  validateFallbackSelection(input.command.routingReceipt);
  validateAgentRunPoolRoute(input.command.routingReceipt);
  const authority =
    input.liveParentGrant === undefined
      ? clampAgentRunAuthority({
          parentAuthority: input.parentAuthority,
          requestedAuthority: input.command.requestedAuthority,
          ...(input.projectCeiling === undefined ? {} : { projectCeiling: input.projectCeiling }),
          ...(input.globalCeiling === undefined ? {} : { globalCeiling: input.globalCeiling }),
        })
      : clampAgentRunAuthorityAgainstLiveGrant({
          modeCeiling: input.parentAuthority,
          liveParentGrant: input.liveParentGrant,
          requestedAuthority: input.command.requestedAuthority,
          ...(input.projectCeiling === undefined ? {} : { projectCeiling: input.projectCeiling }),
          ...(input.globalCeiling === undefined ? {} : { globalCeiling: input.globalCeiling }),
        });
  const run: AgentRun = {
    id: input.runId,
    requestId: input.command.requestId,
    parentThreadId: input.command.parentThreadId,
    parentRunId: input.command.parentRunId,
    depth,
    role: input.command.role,
    task: input.command.task,
    creationPosture: input.command.creationPosture,
    executionKind: input.command.routingReceipt.selectedExecutionKind,
    lifecycleStatus:
      input.command.creationPosture === "ask" && !input.confirmed ? "queued" : "queued",
    authority,
    routingReceipt: input.command.routingReceipt,
    workspaceReceipt: input.command.workspaceReceipt,
    resultAcknowledgement: {
      required: false,
      acknowledged: false,
    },
    version: 1 as AggregateVersion,
    createdAt: input.now,
    updatedAt: input.now,
  };
  validateWorkspaceReceipt(run);
  return run;
}
