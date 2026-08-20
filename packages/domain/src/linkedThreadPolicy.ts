import {
  LINKED_THREAD_MAX_ACTIVE_GLOBAL,
  LINKED_THREAD_MAX_ACTIVE_PER_HOST,
  LINKED_THREAD_MAX_ACTIVE_PER_PROJECT,
  LINKED_THREAD_MAX_ACTIVE_PER_SOURCE,
  LINKED_THREAD_MAX_NESTING_DEPTH,
  LINKED_THREAD_NO_IMPLICIT_TRANSFERS,
  decodeAgentRunAuthority,
  decodeLinkedThreadCreationReceipt,
  decodeLinkedThreadCreationRequest,
  decodeLinkedThreadLimitSnapshot,
  decodeLinkedThreadReceiptId,
  type AgentRunAuthority,
  type LinkedThreadCreationReceipt,
  type LinkedThreadCreationRequest,
  type LinkedThreadLimitSnapshot,
  type LinkedThreadRoutingReceipt,
  type LinkedThreadScope,
  type LinkedThreadWorkspaceScope,
  type UtcTimestamp,
} from "@octant/contracts";

export type LinkedThreadPolicyRejectionCode =
  | "invalid-request"
  | "invalid-provenance"
  | "invalid-snapshot"
  | "invalid-scope"
  | "invalid-routing"
  | "scope-change-required"
  | "scope-change-unsupported"
  | "authority-widening"
  | "limit-reached"
  | "provider-capacity-unavailable"
  | "duplicate-conflict";

export class LinkedThreadPolicyRejected extends Error {
  override readonly name = "LinkedThreadPolicyRejected";

  constructor(
    readonly code: LinkedThreadPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: LinkedThreadPolicyRejectionCode, message: string): never {
  throw new LinkedThreadPolicyRejected(code, message);
}

function decodeOrReject<T>(
  decode: (input: unknown) => T,
  input: unknown,
  code: LinkedThreadPolicyRejectionCode,
  message: string,
): T {
  try {
    return decode(input);
  } catch {
    return reject(code, message);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameWorkspace(
  left: LinkedThreadWorkspaceScope,
  right: LinkedThreadWorkspaceScope,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "chat-virtual":
      return right.kind === "chat-virtual" && left.projectId === right.projectId;
    case "work-root":
      return (
        right.kind === "work-root" &&
        left.projectId === right.projectId &&
        left.rootId === right.rootId
      );
    case "code-worktree":
      return (
        right.kind === "code-worktree" &&
        left.projectId === right.projectId &&
        left.repositoryId === right.repositoryId &&
        left.bindingRevisionId === right.bindingRevisionId &&
        left.checkoutId === right.checkoutId &&
        left.verified === right.verified
      );
  }
}

export function linkedThreadScopesEqual(
  left: LinkedThreadScope,
  right: LinkedThreadScope,
): boolean {
  return (
    left.hostId === right.hostId &&
    left.mode === right.mode &&
    sameWorkspace(left.workspace, right.workspace)
  );
}

function scopeProjectId(scope: LinkedThreadScope): string | null | undefined {
  const workspace = scope.workspace;
  if (workspace.kind === "chat-virtual") return workspace.projectId;
  if (workspace.kind === "work-root" || workspace.kind === "code-worktree") {
    return workspace.projectId;
  }
  return undefined;
}

function assertScopeIsExecutable(scope: LinkedThreadScope): void {
  if (scope.workspace.kind === "code-worktree" && !scope.workspace.verified) {
    reject("invalid-scope", "A linked Code worktree must be verified before admission.");
  }
}

function assertRoutingMatchesScope(
  receipt: LinkedThreadRoutingReceipt,
  scope: LinkedThreadScope,
  contextSnapshotId: string,
  label: string,
): void {
  if (receipt.contextSnapshotId !== contextSnapshotId) {
    reject("invalid-routing", `${label} routing receipt must name the bounded context snapshot.`);
  }
  if (receipt.hostId !== scope.hostId || receipt.mode !== scope.mode) {
    reject(
      "invalid-routing",
      `${label} routing receipt must remain in the recorded host and mode.`,
    );
  }
  const expectedProjectId = scopeProjectId(scope);
  if (
    (expectedProjectId === undefined && receipt.projectId !== undefined) ||
    (expectedProjectId === null && receipt.projectId !== undefined) ||
    (typeof expectedProjectId === "string" && receipt.projectId !== expectedProjectId)
  ) {
    reject(
      "invalid-routing",
      `${label} routing receipt must remain in the recorded Project scope.`,
    );
  }
  if (
    receipt.selectedProviderInstanceId !== receipt.executionResolution.providerInstanceId ||
    receipt.selectedModelId !== receipt.executionResolution.modelId ||
    receipt.hostId !== receipt.executionResolution.hostId
  ) {
    reject(
      "invalid-routing",
      `${label} routing receipt has inconsistent provider or host identity.`,
    );
  }
  if (
    receipt.selectedFallback !== undefined &&
    receipt.selectedFallback.providerInstanceId === receipt.selectedProviderInstanceId &&
    receipt.selectedFallback.modelId === receipt.selectedModelId
  ) {
    reject("invalid-routing", "A selected fallback must differ from the primary provider/model.");
  }
}

function assertRoutingAuthorityMatches(
  receipt: LinkedThreadRoutingReceipt,
  authority: AgentRunAuthority,
): void {
  const permissions = receipt.executionResolution.effectivePermissions;
  for (const key of ["filesystem", "shell", "git", "network", "tools", "subagents"] as const) {
    if (permissions[key] !== authority[key]) {
      reject(
        "invalid-routing",
        `Target routing receipt permission ${key} must match the requested authority clamp.`,
      );
    }
  }
  if (receipt.executionResolution.executionPolicy !== authority.executionPolicy) {
    reject(
      "invalid-routing",
      "Target routing receipt execution policy must match its authority clamp.",
    );
  }
  if (receipt.executionResolution.permissionPersistence !== authority.permissionPersistence) {
    reject(
      "invalid-routing",
      "Target routing receipt permission persistence must match its authority clamp.",
    );
  }
}

function assertProvenance(request: LinkedThreadCreationRequest): void {
  const snapshot = request.contextSnapshot;
  const provenance = request.continuedFrom;
  if (
    provenance.contextSnapshotId !== snapshot.id ||
    provenance.sourceThreadId !== snapshot.sourceThreadId ||
    provenance.sourceVersion !== snapshot.sourceVersion
  ) {
    reject(
      "invalid-provenance",
      "continuedFrom must exactly identify the bounded source snapshot.",
    );
  }
  if (
    request.targetThreadIds.some(
      (targetId) => String(targetId) === String(provenance.sourceThreadId),
    )
  ) {
    reject("invalid-provenance", "A linked thread cannot target its own source thread.");
  }
  assertScopeIsExecutable(provenance.sourceScope);
  assertScopeIsExecutable(request.targetScope);
  assertRoutingMatchesScope(
    provenance.sourceRoutingReceipt,
    provenance.sourceScope,
    snapshot.id,
    "Source",
  );
  assertRoutingMatchesScope(request.routingReceipt, request.targetScope, snapshot.id, "Target");
  assertRoutingAuthorityMatches(request.routingReceipt, request.requestedAuthority);
}

function assertScopeChangeAllowed(input: {
  readonly sourceScope: LinkedThreadScope;
  readonly targetScope: LinkedThreadScope;
  readonly scopeChange?: LinkedThreadCreationRequest["scopeChange"];
  readonly targetScopeAvailable: boolean;
  readonly targetScopeAuthorized: boolean;
}): void {
  if (input.targetScopeAvailable !== true || input.targetScopeAuthorized !== true) {
    reject(
      "scope-change-unsupported",
      "The linked target scope is unavailable or unauthorized; no implicit scope change is allowed.",
    );
  }
  if (linkedThreadScopesEqual(input.sourceScope, input.targetScope)) return;
  if (input.scopeChange === undefined) {
    reject(
      "scope-change-required",
      "Cross-Project, host, mode, root, or worktree linking requires an explicit confirmed scope change.",
    );
  }
}

const executionRank: Record<AgentRunAuthority["executionPolicy"], number> = {
  plan: 0,
  "approval-gated": 1,
  "auto-accept-edits": 2,
  "full-access": 3,
};

function assertModeAuthorityCeiling(authority: AgentRunAuthority, scope: LinkedThreadScope): void {
  const workspace = scope.workspace;
  if (scope.mode === "chat" && (authority.filesystem || authority.shell || authority.git)) {
    reject(
      "authority-widening",
      "Chat linked threads cannot receive filesystem, shell, or Git authority.",
    );
  }
  if (scope.mode === "work" && (authority.shell || authority.git)) {
    reject("authority-widening", "Work linked threads cannot receive shell or Git authority.");
  }
  if (
    workspace.kind === "chat-virtual" &&
    workspace.projectId === null &&
    authority.permissionPersistence === "project-default"
  ) {
    reject(
      "authority-widening",
      "Unprojected Chat linked threads cannot persist permissions at Project scope.",
    );
  }
}

export function clampLinkedThreadAuthority(input: {
  readonly requestedAuthority: AgentRunAuthority;
  readonly targetCeiling: AgentRunAuthority;
  readonly globalCeiling?: AgentRunAuthority;
  readonly targetScope?: LinkedThreadScope;
}): AgentRunAuthority {
  const requested = decodeOrReject(
    decodeAgentRunAuthority,
    input.requestedAuthority,
    "authority-widening",
    "Requested linked-thread authority is invalid.",
  );
  const target = decodeOrReject(
    decodeAgentRunAuthority,
    input.targetCeiling,
    "authority-widening",
    "Target linked-thread authority ceiling is invalid.",
  );
  const global =
    input.globalCeiling === undefined
      ? undefined
      : decodeOrReject(
          decodeAgentRunAuthority,
          input.globalCeiling,
          "authority-widening",
          "Global linked-thread authority ceiling is invalid.",
        );

  if (input.targetScope !== undefined) {
    assertModeAuthorityCeiling(target, input.targetScope);
    assertScopeIsExecutable(input.targetScope);
  }
  const ceilings = global === undefined ? [target] : [target, global];
  const capabilityKeys = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;
  const effective: AgentRunAuthority = {
    filesystem: requested.filesystem && ceilings.every((ceiling) => ceiling.filesystem),
    shell: requested.shell && ceilings.every((ceiling) => ceiling.shell),
    git: requested.git && ceilings.every((ceiling) => ceiling.git),
    network: requested.network && ceilings.every((ceiling) => ceiling.network),
    tools: requested.tools && ceilings.every((ceiling) => ceiling.tools),
    subagents: requested.subagents && ceilings.every((ceiling) => ceiling.subagents),
    executionPolicy: ceilings.reduce<AgentRunAuthority["executionPolicy"]>(
      (current, ceiling) =>
        executionRank[ceiling.executionPolicy] < executionRank[current]
          ? ceiling.executionPolicy
          : current,
      requested.executionPolicy,
    ),
    permissionPersistence:
      requested.permissionPersistence === "project-default" &&
      ceilings.every((ceiling) => ceiling.permissionPersistence === "project-default")
        ? "project-default"
        : "current-session",
  };

  for (const key of capabilityKeys) {
    if (requested[key] && !effective[key]) {
      reject(
        "authority-widening",
        `Linked-thread authority cannot widen ${key} beyond its target ceiling.`,
      );
    }
  }
  if (executionRank[requested.executionPolicy] > executionRank[effective.executionPolicy]) {
    reject(
      "authority-widening",
      "Linked-thread execution authority policy cannot widen its target ceiling.",
    );
  }
  if (
    requested.permissionPersistence === "project-default" &&
    effective.permissionPersistence !== "project-default"
  ) {
    reject(
      "authority-widening",
      "Linked-thread permission authority persistence cannot widen its target ceiling.",
    );
  }
  if (input.targetScope !== undefined) assertModeAuthorityCeiling(effective, input.targetScope);
  return effective;
}

export function assertLinkedThreadLimits(input: unknown): LinkedThreadLimitSnapshot {
  const limits = decodeOrReject(
    decodeLinkedThreadLimitSnapshot,
    input,
    "limit-reached",
    "Linked-thread admission limits are invalid.",
  );
  if (limits.nestingDepth > LINKED_THREAD_MAX_NESTING_DEPTH) {
    reject(
      "limit-reached",
      `Linked-thread nesting depth exceeds ${LINKED_THREAD_MAX_NESTING_DEPTH}.`,
    );
  }
  const dimensions = [
    [limits.activeGlobal, limits.requestedCount, LINKED_THREAD_MAX_ACTIVE_GLOBAL, "global"],
    [limits.activeForSource, limits.requestedCount, LINKED_THREAD_MAX_ACTIVE_PER_SOURCE, "source"],
    [
      limits.activeForProject,
      limits.requestedCount,
      LINKED_THREAD_MAX_ACTIVE_PER_PROJECT,
      "Project",
    ],
    [limits.activeForHost, limits.requestedCount, LINKED_THREAD_MAX_ACTIVE_PER_HOST, "host"],
  ] as const;
  for (const [active, requested, maximum, label] of dimensions) {
    if (active + requested > maximum) {
      reject("limit-reached", `Linked-thread ${label} concurrency limit reached (${maximum}).`);
    }
  }
  const provider = limits.providerCapacity;
  if (provider.status !== "available") {
    reject("provider-capacity-unavailable", `Provider capacity is ${provider.status}.`);
  }
  if (
    provider.remaining < limits.requestedCount ||
    provider.active + limits.requestedCount > provider.limit
  ) {
    reject(
      "provider-capacity-unavailable",
      "Provider capacity cannot admit the requested linked threads.",
    );
  }
  return limits;
}

function receiptMatchesRequest(
  request: LinkedThreadCreationRequest,
  receipt: LinkedThreadCreationReceipt,
): boolean {
  return (
    request.requestId === receipt.requestId &&
    request.requestFingerprint === receipt.requestFingerprint &&
    sameJson(request.targetThreadIds, receipt.targetThreadIds) &&
    request.continuedFrom.sourceThreadId === receipt.continuedFrom.sourceThreadId &&
    request.continuedFrom.sourceVersion === receipt.continuedFrom.sourceVersion &&
    sameJson(request.continuedFrom.sourceScope, receipt.continuedFrom.sourceScope) &&
    sameJson(
      request.continuedFrom.sourceRoutingReceipt,
      receipt.continuedFrom.sourceRoutingReceipt,
    ) &&
    request.contextSnapshot.id === receipt.contextSnapshotId &&
    sameJson(request.targetScope, receipt.targetScope) &&
    sameJson(request.routingReceipt, receipt.routingReceipt) &&
    sameJson(request.scopeChange, receipt.scopeChange) &&
    request.nestingDepth === receipt.nestingDepth
  );
}

export function resolveLinkedThreadReplay(input: {
  readonly request: unknown;
  readonly existingReceipt?: unknown;
}):
  | { readonly kind: "new" }
  | { readonly kind: "duplicate"; readonly receipt: LinkedThreadCreationReceipt } {
  const request = decodeOrReject(
    decodeLinkedThreadCreationRequest,
    input.request,
    "invalid-request",
    "Linked-thread creation request is invalid.",
  );
  if (input.existingReceipt === undefined) return { kind: "new" };
  const receipt = decodeOrReject(
    decodeLinkedThreadCreationReceipt,
    input.existingReceipt,
    "duplicate-conflict",
    "Existing linked-thread receipt is invalid.",
  );
  if (request.requestId !== receipt.requestId) return { kind: "new" };
  if (!receiptMatchesRequest(request, receipt)) {
    reject(
      "duplicate-conflict",
      "Duplicate request ID already has a different linked-thread request fingerprint or scope.",
    );
  }
  return { kind: "duplicate", receipt };
}

export interface AdmitLinkedThreadCreationInput {
  readonly request: unknown;
  readonly receiptId: unknown;
  readonly targetAuthorityCeiling: AgentRunAuthority;
  readonly globalAuthorityCeiling?: AgentRunAuthority;
  readonly limits: unknown;
  readonly targetScopeAvailable: boolean;
  readonly targetScopeAuthorized: boolean;
  readonly existingReceipt?: unknown;
  readonly now: UtcTimestamp;
}

export type AdmitLinkedThreadCreationResult =
  | { readonly kind: "accepted"; readonly receipt: LinkedThreadCreationReceipt }
  | { readonly kind: "duplicate"; readonly receipt: LinkedThreadCreationReceipt };

export function admitLinkedThreadCreation(
  input: AdmitLinkedThreadCreationInput,
): AdmitLinkedThreadCreationResult {
  const request = decodeOrReject(
    decodeLinkedThreadCreationRequest,
    input.request,
    "invalid-request",
    "Linked-thread creation request is invalid.",
  );
  const replay = resolveLinkedThreadReplay({ request, existingReceipt: input.existingReceipt });
  if (replay.kind === "duplicate") return replay;

  const receiptId = decodeOrReject(
    decodeLinkedThreadReceiptId,
    input.receiptId,
    "invalid-request",
    "Linked-thread receipt ID is invalid.",
  );
  const now = input.now;
  if (request.contextSnapshot.sourceThreadId !== request.continuedFrom.sourceThreadId) {
    reject("invalid-snapshot", "Context snapshot source identity does not match continuedFrom.");
  }
  assertProvenance(request);
  assertScopeChangeAllowed({
    sourceScope: request.continuedFrom.sourceScope,
    targetScope: request.targetScope,
    scopeChange: request.scopeChange,
    targetScopeAvailable: input.targetScopeAvailable,
    targetScopeAuthorized: input.targetScopeAuthorized,
  });

  const limits = assertLinkedThreadLimits(input.limits);
  if (limits.requestedCount !== request.targetThreadIds.length) {
    reject(
      "limit-reached",
      "Requested target count does not match the supplied target thread IDs.",
    );
  }
  if (limits.nestingDepth !== request.nestingDepth) {
    reject("limit-reached", "Requested nesting depth does not match the admission limit snapshot.");
  }
  if (
    limits.providerCapacity.status !== "available" ||
    limits.providerCapacity.providerInstanceId !== request.routingReceipt.selectedProviderInstanceId
  ) {
    reject(
      "provider-capacity-unavailable",
      "Provider capacity receipt does not match the selected provider.",
    );
  }

  const authorityInput = {
    requestedAuthority: request.requestedAuthority,
    targetCeiling: input.targetAuthorityCeiling,
    targetScope: request.targetScope,
    ...(input.globalAuthorityCeiling === undefined
      ? {}
      : { globalCeiling: input.globalAuthorityCeiling }),
  } satisfies Parameters<typeof clampLinkedThreadAuthority>[0];
  const effectiveAuthority = clampLinkedThreadAuthority(authorityInput);
  const receipt: LinkedThreadCreationReceipt = {
    receiptId,
    requestId: request.requestId,
    requestFingerprint: request.requestFingerprint,
    continuedFrom: request.continuedFrom,
    contextSnapshotId: request.contextSnapshot.id,
    targetThreadIds: request.targetThreadIds,
    createdThreadIds: request.targetThreadIds,
    targetScope: request.targetScope,
    routingReceipt: request.routingReceipt,
    effectiveAuthority,
    transferPolicy: LINKED_THREAD_NO_IMPLICIT_TRANSFERS,
    ...(request.scopeChange === undefined ? {} : { scopeChange: request.scopeChange }),
    nestingDepth: request.nestingDepth,
    status: "accepted",
    createdAt: now,
    updatedAt: now,
  };
  // Validate the constructed receipt before it can become a durable event.
  decodeOrReject(
    decodeLinkedThreadCreationReceipt,
    receipt,
    "invalid-request",
    "Linked-thread creation receipt could not be constructed.",
  );
  return { kind: "accepted", receipt };
}
