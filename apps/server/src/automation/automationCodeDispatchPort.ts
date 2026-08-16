import { createHash } from "node:crypto";
import {
  decodeCodeDeliveryTarget,
  decodeCodeOperationId,
  type AutomationRun,
  type CodeEvidenceContentId,
  type CodeEvidenceReference,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodeThreadId,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import type {
  AutomationCodeDispatchPort,
  AutomationFirstTurnLaunchOutcome,
  AutomationThreadCreationOutcome,
} from "./automationModeDispatchPorts";
import { automationThreadTitle } from "./automationDispatchService";

export interface AutomationCodeRouteService {
  readonly execute: (
    windowId: WindowId,
    command: unknown,
  ) => Promise<{
    readonly kind: string;
    readonly thread?: { readonly id: CodeThreadId; readonly checkoutId?: string };
  }>;
  readonly bootstrap: (windowId: WindowId) => Promise<{
    readonly threads: ReadonlyArray<{ readonly id: CodeThreadId; readonly checkoutId: string }>;
  }>;
}

export interface AutomationCodeOperationService {
  readonly execute: (windowId: WindowId, command: unknown) => Promise<CodeOperationResult>;
}

export interface AutomationCodeEvidencePort {
  readonly put: (text: string) => CodeEvidenceReference;
}

export interface CreateAutomationCodeDispatchPortOptions {
  readonly codeService: AutomationCodeRouteService;
  readonly operations: AutomationCodeOperationService;
  readonly evidence: AutomationCodeEvidencePort;
  readonly clock: () => UtcTimestamp;
  readonly uuid: () => string;
  /**
   * Source branch for managed worktree creation. Defaults to `development`.
   * The Automation definition binding validates the Project/checkout; the
   * delivery branch is derived deterministically from the occurrence.
   */
  readonly sourceBranch?: string;
  readonly startFromOrigin?: boolean;
  readonly remoteName?: string;
}

/**
 * Production Code adapter for Automation A4. Creates approval-gated threads
 * through the ordinary managed-worktree command path and starts/recovers the
 * first provider turn through CodeOperationService.execute (which owns the
 * stale-`running` recovery seam).
 */
export function createAutomationCodeDispatchPort(
  options: CreateAutomationCodeDispatchPortOptions,
): AutomationCodeDispatchPort {
  return {
    async createApprovalGatedThread(input) {
      return createManagedThread(options, input);
    },
    async startOrRecoverFirstTurn(input) {
      return startOrRecover(options, input);
    },
  };
}

async function createManagedThread(
  options: CreateAutomationCodeDispatchPortOptions,
  input: {
    readonly run: AutomationRun;
    readonly threadId: CodeThreadId;
    readonly title: string;
    readonly windowId: WindowId;
  },
): Promise<AutomationThreadCreationOutcome> {
  const existing = await readThreadIfPresent(options.codeService, input.windowId, input.threadId);
  if (existing) {
    return { kind: "existing", threadId: input.threadId as never };
  }

  const snapshot = input.run.definitionSnapshot;
  if (snapshot.binding.kind !== "code") {
    return {
      kind: "failed",
      reason: "thread-creation-failed",
      message: "Code Automation binding is missing.",
    };
  }
  const now = options.clock();
  const deliveryTarget = decodeCodeDeliveryTarget({
    branchIntent: automationDeliveryBranch(String(input.run.occurrenceKey)),
    remoteName: options.remoteName ?? "origin",
    proposedBaseRepository: String(snapshot.binding.repositoryId),
    proposedBaseBranch: options.sourceBranch ?? "development",
    outcomeKind: "local-implementation",
    confirmedAt: snapshot.deliveryTarget.confirmedAt,
  });

  try {
    const created = await options.codeService.execute(input.windowId, {
      kind: "create-managed-code-thread",
      threadId: input.threadId,
      projectId: snapshot.projectId,
      bindingRevisionId: snapshot.binding.bindingRevisionId,
      title: input.title.length > 0 ? input.title : automationThreadTitle(snapshot.displayName),
      providerInstanceId: snapshot.executionProfile.providerInstanceId,
      modelId: snapshot.executionProfile.modelId,
      executionPolicy: "approval-gated",
      permissionPersistence: snapshot.executionProfile.permissionPersistence,
      deliveryTarget,
      sourceBranch: options.sourceBranch ?? "development",
      startFromOrigin: options.startFromOrigin ?? false,
      ...(options.remoteName === undefined ? {} : { remoteName: options.remoteName }),
    });
    if (created.kind === "managed-thread-created" && created.thread !== undefined) {
      return {
        kind: "created",
        threadId: created.thread.id as never,
        createdAt: now,
      };
    }
    if (created.kind === "thread-created" && created.thread !== undefined) {
      return {
        kind: "created",
        threadId: created.thread.id as never,
        createdAt: now,
      };
    }
    return {
      kind: "failed",
      reason: "thread-creation-failed",
      message: "Managed Code thread creation did not return a thread receipt.",
    };
  } catch (error) {
    return {
      kind: "failed",
      reason: mapCreationFailure(error),
      message: error instanceof Error ? error.message : "Managed Code thread creation failed.",
    };
  }
}

async function startOrRecover(
  options: CreateAutomationCodeDispatchPortOptions,
  input: {
    readonly run: AutomationRun;
    readonly threadId: CodeThreadId;
    readonly firstTurnRequestId: string;
    readonly promptDigest: string;
    readonly windowId: WindowId;
  },
): Promise<AutomationFirstTurnLaunchOutcome> {
  const prompt = options.evidence.put(input.run.definitionSnapshot.taskPrompt);
  if (prompt.digest !== input.promptDigest && input.promptDigest.length > 0) {
    // Digest mismatch is still launched with the immutable task prompt; the
    // dispatch intent digest is the audit trail for the prompt bytes used.
  }
  const operationId = decodeCodeOperationId(
    deterministicOperationUuid(`automation-code-op:${String(input.run.occurrenceKey)}`),
  );
  const sessionId = input.firstTurnRequestId;
  const checkoutId = await resolveCheckoutId(options, input);
  if (checkoutId === undefined) {
    return {
      kind: "failed",
      reason: "provider-launch-failed",
      message: "Code thread checkout is unavailable for the Automation first turn.",
    };
  }
  const command: CodeOperationCommand = {
    kind: "start-provider-turn",
    threadId: input.threadId,
    checkoutId: checkoutId as never,
    operationId,
    sessionId: sessionId as never,
    prompt,
  };
  try {
    const result = await options.operations.execute(input.windowId, command);
    if (
      result.kind === "provider-turn-state" &&
      (result.state === "running" || result.state === "waiting")
    ) {
      return {
        kind: "accepted",
        runtimeReceipt: `code-operation:${String(operationId)}`,
        acceptedAt: options.clock(),
      };
    }
    if (result.kind === "operation-failed") {
      return {
        kind: "failed",
        reason: "provider-launch-failed",
        message: result.failure.message,
      };
    }
    return {
      kind: "failed",
      reason: "provider-launch-failed",
      message: "Code provider turn did not accept the Automation first turn.",
    };
  } catch (error) {
    return {
      kind: "failed",
      reason: "recovery-failed",
      message: error instanceof Error ? error.message : "Code provider turn recovery failed.",
    };
  }
}

async function resolveCheckoutId(
  options: CreateAutomationCodeDispatchPortOptions,
  input: {
    readonly threadId: CodeThreadId;
    readonly windowId: WindowId;
    readonly run: AutomationRun;
  },
): Promise<string | undefined> {
  try {
    const bootstrap = await options.codeService.bootstrap(input.windowId);
    const match = bootstrap.threads.find((thread) => String(thread.id) === String(input.threadId));
    if (match !== undefined) return String(match.checkoutId);
  } catch {
    // Fall through.
  }
  return undefined;
}

async function readThreadIfPresent(
  codeService: AutomationCodeRouteService,
  windowId: WindowId,
  threadId: CodeThreadId,
): Promise<boolean> {
  try {
    const bootstrap = await codeService.bootstrap(windowId);
    return bootstrap.threads.some((thread) => String(thread.id) === String(threadId));
  } catch {
    return false;
  }
}

function automationDeliveryBranch(occurrenceKey: string): string {
  const digest = createHash("sha256")
    .update("octant.automation-delivery-branch.v1\0")
    .update(occurrenceKey)
    .digest("hex")
    .slice(0, 12);
  return `automation/${digest}`;
}

function deterministicOperationUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function mapCreationFailure(
  error: unknown,
): "thread-creation-failed" | "unavailable" | "unauthorized" | "conflict" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("unauthorized")) return "unauthorized";
  if (message.includes("conflict") || message.includes("already exists")) return "conflict";
  if (message.includes("unavailable") || message.includes("waiting")) return "unavailable";
  return "thread-creation-failed";
}

export function automationCodeEvidenceFromText(): {
  readonly put: (value: string) => CodeEvidenceReference;
} {
  return {
    put: (value: string) => {
      const bytes = new TextEncoder().encode(value);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const idBytes = Buffer.from(digest.slice(0, 32), "hex");
      idBytes[6] = ((idBytes[6] as number) & 0x0f) | 0x40;
      idBytes[8] = ((idBytes[8] as number) & 0x3f) | 0x80;
      const hex = idBytes.toString("hex");
      const contentId =
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as CodeEvidenceContentId;
      return {
        contentId,
        digest,
        byteLength: bytes.byteLength,
      };
    },
  };
}
