import { automationFileContext, automationDispatchPromptText } from "./automationFileContext";
import { automationPromptDigest } from "./automationAuthorityRevalidation";
import { createHash } from "node:crypto";
import {
  automationFollowUpTurnPrompt,
  type AutomationRun,
  type WorkThreadId,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  decodeWorkTurnId,
  decodeStartWorkThreadTurnCommand,
  decodeWorkTurnRequestId,
  type WorkTurnRequestId,
  type WorkTurnState,
  type WorkExternalInputReceipt,
  type StartWorkThreadTurnCommand,
} from "@octant/contracts/work-turns";
import { sameWorkExternalInput, workExternalInputReceipt } from "../work/workExternalInput";
import { WorkTurnServiceError, type WorkTurnStartOptions } from "../work/workTurnService";
import type {
  AutomationWorkDispatchPort,
  AutomationFirstTurnLaunchOutcome,
  AutomationThreadCreationOutcome,
} from "./automationModeDispatchPorts";
import { automationThreadTitle } from "./automationDispatchService";

export interface AutomationWorkRouteService {
  readonly execute: (
    scopeId: WindowId,
    command: unknown,
  ) => Promise<{
    readonly kind: string;
    readonly thread?: { readonly id: WorkThreadId };
  }>;
  readonly bootstrap: (windowId: WindowId) => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: WorkThreadId;
      readonly workingDirectory?: string | undefined;
    }>;
  }>;
}

export interface AutomationWorkTurnService {
  readonly startFirstTurn: (
    scopeId: WindowId,
    command: unknown,
    options?: Pick<WorkTurnStartOptions, "accessCeiling" | "externalData" | "admissionCurrent">,
  ) => Promise<{
    readonly kind: string;
    readonly turn?: {
      readonly requestId: string;
      readonly status?: string;
      readonly externalInput?: WorkTurnState["externalInput"];
    };
    readonly message?: string;
  }>;
}

export interface CreateAutomationWorkDispatchPortOptions {
  readonly threads: AutomationWorkRouteService;
  readonly turns: AutomationWorkTurnService;
  readonly clock: () => UtcTimestamp;
  readonly uuid: () => string;
  /** Existing host projection, required to prove input-backed acceptance before live source reads. */
  readonly readTurn?: (requestId: WorkTurnRequestId) => WorkTurnState | undefined;
  readonly prepareFileInput?: (
    run: AutomationRun,
    signal: AbortSignal,
  ) => Promise<(() => boolean) | undefined>;
  readonly markFileInput?: (input: {
    readonly run: AutomationRun;
    readonly threadId: WorkThreadId;
    readonly contentReference: string;
  }) => boolean;
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
    readonly scopeId: WindowId;
  },
): Promise<AutomationThreadCreationOutcome> {
  const existing = await readThreadIfPresent(options.threads, input.scopeId, input.threadId);
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
    const created = await options.threads.execute(input.scopeId, {
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
      const raced = await readThreadIfPresent(options.threads, input.scopeId, input.threadId);
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
    readonly scopeId: WindowId;
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
  const fileContext = automationFileContext(input.run);
  // A follow-up goes back into a thread a person made, which may work in a
  // subfolder of the Project; its turn names that folder, as the person's own
  // next turn would.
  const followUp = snapshot.targetPolicy === "same-thread";
  const workingDirectory = followUp
    ? ((await readThreadWorkingDirectory(options.threads, input.scopeId, input.threadId)) ?? ".")
    : ".";
  const turnId = decodeWorkTurnId(
    deterministicUuid(`automation-work-turn:${String(input.run.occurrenceKey)}`),
  );
  const command = decodeStartWorkThreadTurnCommand({
    kind: "start-work-thread-turn",
    requestId: decodeWorkTurnRequestId(String(input.firstTurnRequestId)),
    threadId: input.threadId,
    turnId,
    prompt: followUp ? automationFollowUpTurnPrompt(snapshot.taskPrompt) : snapshot.taskPrompt,
    authority: {
      hostId: LOCAL_HOST_ID,
      projectId: snapshot.projectId,
      bindingRevisionId: snapshot.binding.bindingRevisionId,
      workingDirectory,
      confinementPosture: "project-root-confined" as const,
      providerInstanceId: snapshot.executionProfile.providerInstanceId,
      modelId: snapshot.executionProfile.modelId,
    },
  });

  try {
    const expectedInput =
      fileContext === undefined ? undefined : workExternalInputReceipt(fileContext);
    if (fileContext !== undefined) {
      if (
        options.readTurn === undefined ||
        input.promptDigest !== automationPromptDigest(automationDispatchPromptText(input.run))
      )
        return unconfirmedFileInput();
      const retained = options.readTurn(command.requestId);
      if (retained !== undefined) {
        if (!matchesFileAcceptance(retained, command, expectedInput)) return unconfirmedFileInput();
        // This is the original acceptance, not a new delivery or a provider-completion claim.
        return {
          kind: "accepted",
          runtimeReceipt: `work-turn:${String(input.firstTurnRequestId)}`,
          acceptedAt: retained.acceptedAt,
        };
      }
    }
    const fileCurrent =
      fileContext === undefined ? undefined : await prepareFileAdmission(options, input.run);
    if (
      fileContext !== undefined &&
      (fileCurrent?.() !== true || options.markFileInput === undefined)
    )
      return {
        kind: "failed",
        reason: "provider-launch-failed",
        message: "File input delivery is unavailable or its retained admission changed.",
      };
    // A routine thread takes its access from the host's Work default, the
    // level a Work Project's new threads start at. Nobody is present for this
    // turn, so it runs ask-first unless the routine's captured authority
    // itself is auto-accept-edits, or the person opted this routine into the
    // Project's level, Full access included, or picked a level on the routine,
    // which is the ceiling; the ceiling only narrows.
    if (
      fileContext !== undefined &&
      options.markFileInput?.({
        run: input.run,
        threadId: input.threadId,
        contentReference: fileContext.referenceId,
      }) !== true
    )
      return {
        kind: "failed",
        reason: "provider-launch-failed",
        message: "The observed file context could not be recorded. No task was sent.",
      };
    const result = await options.turns.startFirstTurn(input.scopeId, command, {
      ...(fileContext === undefined
        ? {}
        : {
            externalData: fileContext,
            admissionCurrent: () => fileCurrent?.() === true,
          }),
      ...(snapshot.projectLevel === "opted-in"
        ? {}
        : {
            accessCeiling:
              snapshot.runLevel ??
              (input.run.authoritySnapshot.effective.executionPolicy === "auto-accept-edits"
                ? "auto-accept-edits"
                : "ask-first"),
          }),
    });
    if (
      fileContext !== undefined &&
      (result.kind === "accepted" || result.kind === "ambiguous") &&
      (result.turn?.requestId !== command.requestId ||
        !sameWorkExternalInput(result.turn?.externalInput, expectedInput) ||
        !matchesFileAcceptance(options.readTurn?.(command.requestId), command, expectedInput))
    )
      return unconfirmedFileInput();
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

function matchesFileAcceptance(
  retained: WorkTurnState | undefined,
  command: StartWorkThreadTurnCommand,
  expectedInput: WorkExternalInputReceipt | undefined,
): boolean {
  if (retained === undefined) return false;
  const expected = command.authority;
  return (
    retained.requestId === command.requestId &&
    retained.threadId === command.threadId &&
    retained.turnId === command.turnId &&
    retained.projectId === expected.projectId &&
    retained.prompt === command.prompt &&
    retained.delivery === undefined &&
    (retained.attachments?.length ?? 0) === 0 &&
    (retained.extensionSelections?.length ?? 0) === 0 &&
    retained.authority.hostId === expected.hostId &&
    retained.authority.projectId === expected.projectId &&
    retained.authority.bindingRevisionId === expected.bindingRevisionId &&
    retained.authority.workingDirectory === expected.workingDirectory &&
    retained.authority.confinementPosture === expected.confinementPosture &&
    retained.authority.providerInstanceId === expected.providerInstanceId &&
    retained.authority.modelId === expected.modelId &&
    sameWorkExternalInput(retained.externalInput, expectedInput)
  );
}

function unconfirmedFileInput(): AutomationFirstTurnLaunchOutcome {
  return {
    kind: "failed",
    reason: "recovery-failed",
    message:
      "File input acceptance is unconfirmed for this Work request. Open the existing task; do not resend automatically.",
  };
}

/** One finite acquisition stage; a late filesystem result can never resume dispatch. */
async function prepareFileAdmission(
  options: CreateAutomationWorkDispatchPortOptions,
  run: AutomationRun,
): Promise<(() => boolean) | undefined> {
  if (options.prepareFileInput === undefined) return undefined;
  const controller = new AbortController();
  const deadline = performance.now() + 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const prepared = Promise.resolve(options.prepareFileInput(run, controller.signal)).then(
      (proof) => {
        if (controller.signal.aborted || performance.now() >= deadline) {
          controller.abort();
          return undefined;
        }
        return proof === undefined ? undefined : () => !controller.signal.aborted && proof();
      },
    );
    return await Promise.race([
      prepared,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, 10_000);
      }),
    ]);
  } catch {
    controller.abort();
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readThreadIfPresent(
  threads: AutomationWorkRouteService,
  scopeId: WindowId,
  threadId: WorkThreadId,
): Promise<boolean> {
  try {
    const bootstrap = await threads.bootstrap(scopeId);
    return bootstrap.threads.some((thread) => String(thread.id) === String(threadId));
  } catch {
    return false;
  }
}

async function readThreadWorkingDirectory(
  threads: AutomationWorkRouteService,
  scopeId: WindowId,
  threadId: WorkThreadId,
): Promise<string | undefined> {
  try {
    const bootstrap = await threads.bootstrap(scopeId);
    return bootstrap.threads.find((thread) => String(thread.id) === String(threadId))
      ?.workingDirectory;
  } catch {
    return undefined;
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
