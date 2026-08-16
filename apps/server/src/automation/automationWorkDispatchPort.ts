import { createHash } from "node:crypto";
import type { AutomationRun, WorkThreadId, UtcTimestamp, WindowId } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { decodeWorkTurnId, decodeWorkTurnRequestId } from "@octant/contracts/work-turns";
import { WorkTurnServiceError } from "../work/workTurnService";
import type {
  AutomationWorkDispatchPort,
  AutomationFirstTurnLaunchOutcome,
  AutomationThreadCreationOutcome,
} from "./automationModeDispatchPorts";
import { automationThreadTitle } from "./automationDispatchService";

export interface AutomationWorkRouteService {
  readonly execute: (
    windowId: WindowId,
    command: unknown,
  ) => Promise<{
    readonly kind: string;
    readonly thread?: { readonly id: WorkThreadId };
  }>;
  readonly bootstrap: (windowId: WindowId) => Promise<{
    readonly threads: ReadonlyArray<{ readonly id: WorkThreadId }>;
  }>;
}

export interface AutomationWorkTurnService {
  readonly startFirstTurn: (
    windowId: WindowId,
    command: unknown,
  ) => Promise<{
    readonly kind: string;
    readonly turn?: { readonly requestId: string; readonly status?: string };
    readonly message?: string;
  }>;
}

export interface CreateAutomationWorkDispatchPortOptions {
  readonly threads: AutomationWorkRouteService;
  readonly turns: AutomationWorkTurnService;
  readonly clock: () => UtcTimestamp;
  readonly uuid: () => string;
}

/**
 * Production Work adapter for Automation A4. Creates Project-bound threads
 * through the ordinary `create-work-thread` path and starts/recovers the
 * first provider turn through {@link WorkTurnService.startFirstTurn}, which
 * owns request-id idempotency for the occurrence's first-turn identity.
 */
export function createAutomationWorkDispatchPort(
  options: CreateAutomationWorkDispatchPortOptions,
): AutomationWorkDispatchPort {
  return {
    available: true,
    unavailableReason: undefined,
    async createThread(input) {
      return createWorkThread(options, input);
    },
    async startOrRecoverFirstTurn(input) {
      return startOrRecover(options, input);
    },
  };
}

async function createWorkThread(
  options: CreateAutomationWorkDispatchPortOptions,
  input: {
    readonly run: AutomationRun;
    readonly threadId: WorkThreadId;
    readonly title: string;
    readonly windowId: WindowId;
  },
): Promise<AutomationThreadCreationOutcome> {
  const existing = await readThreadIfPresent(options.threads, input.windowId, input.threadId);
  if (existing) {
    return { kind: "existing", threadId: input.threadId as never };
  }

  const snapshot = input.run.definitionSnapshot;
  if (snapshot.binding.kind !== "work") {
    return {
      kind: "failed",
      reason: "thread-creation-failed",
      message: "Work Automation binding is missing.",
    };
  }
  const now = options.clock();
  const title = input.title.length > 0 ? input.title : automationThreadTitle(snapshot.displayName);

  try {
    const created = await options.threads.execute(input.windowId, {
      kind: "create-work-thread",
      threadId: input.threadId,
      projectId: snapshot.projectId,
      title,
      providerInstanceId: snapshot.executionProfile.providerInstanceId,
      modelId: snapshot.executionProfile.modelId,
      hostId: LOCAL_HOST_ID,
      bindingRevisionId: snapshot.binding.bindingRevisionId,
      workingDirectory: ".",
    });
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
      message: "Work thread creation did not return a thread receipt.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Work thread creation failed.";
    if (/already exists/i.test(message)) {
      const raced = await readThreadIfPresent(options.threads, input.windowId, input.threadId);
      if (raced) {
        return { kind: "existing", threadId: input.threadId as never };
      }
    }
    return {
      kind: "failed",
      reason: mapCreationFailure(error),
      message,
    };
  }
}

async function startOrRecover(
  options: CreateAutomationWorkDispatchPortOptions,
  input: {
    readonly run: AutomationRun;
    readonly threadId: WorkThreadId;
    readonly firstTurnRequestId: string;
    readonly promptDigest: string;
    readonly windowId: WindowId;
  },
): Promise<AutomationFirstTurnLaunchOutcome> {
  const snapshot = input.run.definitionSnapshot;
  if (snapshot.binding.kind !== "work") {
    return {
      kind: "failed",
      reason: "provider-launch-failed",
      message: "Work Automation binding is missing for the first turn.",
    };
  }
  void input.promptDigest;
  const turnId = decodeWorkTurnId(
    deterministicUuid(`automation-work-turn:${String(input.run.occurrenceKey)}`),
  );
  const command = {
    kind: "start-work-thread-turn" as const,
    requestId: decodeWorkTurnRequestId(String(input.firstTurnRequestId)),
    threadId: input.threadId,
    turnId,
    prompt: snapshot.taskPrompt,
    authority: {
      hostId: LOCAL_HOST_ID,
      projectId: snapshot.projectId,
      bindingRevisionId: snapshot.binding.bindingRevisionId,
      workingDirectory: "." as const,
      confinementPosture: "project-root-confined" as const,
      providerInstanceId: snapshot.executionProfile.providerInstanceId,
      modelId: snapshot.executionProfile.modelId,
    },
  };

  try {
    const result = await options.turns.startFirstTurn(input.windowId, command);
    if (result.kind === "accepted") {
      return {
        kind: "accepted",
        runtimeReceipt: `work-turn:${String(input.firstTurnRequestId)}`,
        acceptedAt: options.clock(),
      };
    }
    if (result.kind === "ambiguous") {
      // Ambiguous recovery still proves the request id was claimed; treat as
      // accepted so the dispatcher can record the durable acceptance receipt.
      return {
        kind: "accepted",
        runtimeReceipt: `work-turn:${String(input.firstTurnRequestId)}`,
        acceptedAt: options.clock(),
      };
    }
    return {
      kind: "failed",
      reason: "provider-launch-failed",
      message: result.message ?? "Work provider turn did not accept the Automation first turn.",
    };
  } catch (error) {
    if (error instanceof WorkTurnServiceError) {
      if (error.failure.category === "unavailable" && /capacity/i.test(error.failure.message)) {
        return { kind: "waiting-capacity", message: error.failure.message };
      }
      return {
        kind: "failed",
        reason:
          error.failure.category === "interrupted" ? "recovery-failed" : "provider-launch-failed",
        message: error.failure.message,
      };
    }
    return {
      kind: "failed",
      reason: "recovery-failed",
      message: error instanceof Error ? error.message : "Work provider turn recovery failed.",
    };
  }
}

async function readThreadIfPresent(
  threads: AutomationWorkRouteService,
  windowId: WindowId,
  threadId: WorkThreadId,
): Promise<boolean> {
  try {
    const bootstrap = await threads.bootstrap(windowId);
    return bootstrap.threads.some((thread) => String(thread.id) === String(threadId));
  } catch {
    return false;
  }
}

function deterministicUuid(seed: string): string {
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
  if (message.includes("unauthorized") || message.includes("not authorized")) return "unauthorized";
  if (message.includes("conflict") || message.includes("already exists")) return "conflict";
  if (message.includes("unavailable") || message.includes("waiting")) return "unavailable";
  return "thread-creation-failed";
}
