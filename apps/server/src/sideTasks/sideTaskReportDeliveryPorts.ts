import {
  decodeChatThreadId,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeProviderSessionId,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type ChatThread,
  type ChatThreadView,
  type CodeEvidenceReference,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodeThread,
  type CodeThreadId,
  type SideTaskReportDeliveryMark,
  type SideTaskReportOwed,
  type ThreadDeliveryMark,
  type WindowId,
  type WorkThread,
  type WorkThreadId,
  type WorkTurnLookupResult,
  type WorkTurnState,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { CodeServiceError } from "../code/codeService";
import { WorkTurnServiceError } from "../work/workTurnService";
import { ChatServiceError, type ChatService } from "../chat/chatService";
import { sideTaskReportDeliveryPrompt } from "./sideTaskReportDeliveryPrompt";

/**
 * What the service asks a mode when owed side-task reports want a delivery
 * turn in the parent. `alreadyDelivered` answers whether a parent turn
 * already carries a report mark naming the id — coverage is per report,
 * because one turn may cover any subset of what is owed. `dispatch` admits
 * the one journaled delivery turn and answers whether it landed.
 */
/**
 * `refused` is only for a parent that no longer exists, so the report could
 * never land. Every other refusal names a standing a person can change: the
 * parent is busy, archived, marked Done or paused, its mode is off, or its
 * sign-in runs only turns a person sends. Those wait, so nothing is dropped.
 */
export interface SideTaskReportDeliveryModePort {
  readonly alreadyDelivered: (
    parentThreadId: string,
    reportId: string,
  ) => boolean | Promise<boolean>;
  readonly dispatch: (
    parentThreadId: string,
    reports: ReadonlyArray<SideTaskReportOwed>,
  ) => Promise<
    | { readonly kind: "dispatched" }
    | { readonly kind: "deferred"; readonly detail: string }
    | { readonly kind: "refused"; readonly detail: string }
  >;
}

/** A deletion is final from its request on: no reopen brings the thread back. */
const threadIsGone = (thread: Pick<ChatThread | WorkThread, "lifecycle">): boolean =>
  thread.lifecycle === "deleting" || thread.lifecycle === "deleted";

const refusalDetail = (error: unknown): string =>
  error instanceof Error ? error.message : "The delivery could not be admitted.";

const reportMark = (reports: ReadonlyArray<SideTaskReportOwed>): SideTaskReportDeliveryMark => ({
  kind: "side-task-report",
  reportIds: reports.map((report) => report.reportId),
});

/**
 * The turn a mode journaled must carry a report mark naming every report the
 * batch asked for; a mark covering only some would settle reports the turn
 * never carried, so a partial answer refuses rather than claims delivery.
 */
function sideTaskReportReceipt(
  reports: ReadonlyArray<SideTaskReportOwed>,
  mark: ThreadDeliveryMark | undefined,
): { readonly kind: "dispatched" } | { readonly kind: "deferred"; readonly detail: string } {
  if (mark?.kind !== "side-task-report") {
    return {
      kind: "deferred",
      detail: "The parent did not journal a side-task report delivery mark.",
    };
  }
  const covered = new Set(mark.reportIds.map(String));
  if (reports.some((report) => !covered.has(String(report.reportId)))) {
    return {
      kind: "deferred",
      detail: "The parent's delivery mark covers only some of the requested reports.",
    };
  }
  return { kind: "dispatched" };
}

const markCovers = (mark: ThreadDeliveryMark | undefined, reportId: string): boolean =>
  mark?.kind === "side-task-report" && mark.reportIds.some((id) => String(id) === reportId);

/**
 * A Work parent takes the reports as one ordinary turn, under the host scope
 * a delivery owes its parent by. Work being off, the parent marked Done, or a
 * mid-turn parent is waited out rather than failed: the reports stay owed and
 * the parent's next commit or the retry cadence tries again.
 */
export function createWorkSideTaskReportDeliveryPort(input: {
  readonly uuid: () => string;
  readonly isEnabled: () => boolean;
  readonly readThread: (threadId: WorkThreadId) => WorkThread | undefined;
  readonly listTurns: (threadId: WorkThreadId) => ReadonlyArray<WorkTurnState>;
  readonly startFirstTurn: (windowId: WindowId, input: unknown) => Promise<WorkTurnLookupResult>;
}): SideTaskReportDeliveryModePort {
  return {
    alreadyDelivered: (parentThreadId, reportId) =>
      input
        .listTurns(decodeWorkThreadId(parentThreadId))
        .some((turn) => markCovers(turn.delivery, reportId)),
    dispatch: async (parentThreadId, reports) => {
      const first = reports[0];
      if (first === undefined || first.parentMode !== "work") {
        return { kind: "refused", detail: "No side-task reports were supplied." };
      }
      const delivery = reportMark(reports);
      if (!input.isEnabled()) {
        return { kind: "deferred", detail: "Work is turned off on this host." };
      }
      const thread = input.readThread(decodeWorkThreadId(parentThreadId));
      if (thread === undefined || threadIsGone(thread)) {
        return { kind: "refused", detail: "The parent Work thread is gone." };
      }
      if (thread.bindingRevisionId === undefined) {
        return { kind: "deferred", detail: "The parent has no current Work binding." };
      }
      if (thread.completionConfirmed === true) {
        return { kind: "deferred", detail: "The parent Work thread is marked Done." };
      }
      try {
        const result = await input.startFirstTurn(ROUTINE_HOST_SCOPE_ID, {
          kind: "start-work-thread-turn",
          requestId: decodeWorkTurnRequestId(input.uuid()),
          threadId: thread.id,
          turnId: decodeWorkTurnId(input.uuid()),
          prompt: sideTaskReportDeliveryPrompt(reports),
          authority: {
            hostId: LOCAL_HOST_ID,
            projectId: thread.projectId,
            bindingRevisionId: thread.bindingRevisionId,
            workingDirectory: ".",
            confinementPosture: "project-root-confined",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
          },
          delivery,
        });
        return result.kind === "accepted"
          ? sideTaskReportReceipt(reports, result.turn.delivery)
          : {
              kind: "deferred",
              detail:
                "message" in result && typeof result.message === "string"
                  ? result.message
                  : "The delivery was not admitted.",
            };
      } catch (error) {
        if (error instanceof WorkTurnServiceError && error.failure.category === "stale") {
          return { kind: "deferred", detail: "The parent Work thread is mid-turn." };
        }
        if (input.readThread(thread.id)?.completionConfirmed === true) {
          return { kind: "deferred", detail: "The parent Work thread is marked Done." };
        }
        return { kind: "deferred", detail: refusalDetail(error) };
      }
    },
  };
}

/**
 * A Code parent takes the reports as one provider turn, staged as evidence and
 * admitted through the ordinary operation path so its replay and recovery
 * rules apply unchanged.
 */
export function createCodeSideTaskReportDeliveryPort(input: {
  readonly uuid: () => string;
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  /** Whether the thread's session is being compacted, which holds every new turn. */
  readonly compacting?: (threadId: CodeThreadId) => boolean;
  readonly busy: (threadId: CodeThreadId) => boolean;
  /** The report marks journaled on the thread's conversation turns. */
  readonly turnDeliveryMarks: (threadId: string) => ReadonlyArray<ThreadDeliveryMark>;
  readonly stageEvidence?: (
    windowId: WindowId,
    threadId: CodeThreadId,
    text: string,
  ) => Promise<CodeEvidenceReference> | CodeEvidenceReference;
  readonly executeOperation?: (
    windowId: WindowId,
    command: CodeOperationCommand,
  ) => Promise<CodeOperationResult> | CodeOperationResult;
}): SideTaskReportDeliveryModePort {
  return {
    alreadyDelivered: (parentThreadId, reportId) =>
      input.turnDeliveryMarks(parentThreadId).some((mark) => markCovers(mark, reportId)),
    dispatch: async (parentThreadId, reports) => {
      const first = reports[0];
      if (first === undefined || first.parentMode !== "code") {
        return { kind: "refused", detail: "No side-task reports were supplied." };
      }
      const delivery = reportMark(reports);
      const thread = input.readThread(decodeCodeThreadId(parentThreadId));
      if (thread === undefined) {
        return { kind: "refused", detail: "The parent Code thread is gone." };
      }
      if (
        input.stageEvidence === undefined ||
        input.executeOperation === undefined ||
        input.busy(thread.id)
      ) {
        return { kind: "deferred", detail: "The parent cannot take a Code turn right now." };
      }
      if (input.compacting?.(thread.id) === true) {
        return { kind: "deferred", detail: "The parent Code thread's session is being compacted." };
      }
      try {
        const prompt = await input.stageEvidence(
          ROUTINE_HOST_SCOPE_ID,
          thread.id,
          sideTaskReportDeliveryPrompt(reports),
        );
        const result = await input.executeOperation(ROUTINE_HOST_SCOPE_ID, {
          kind: "start-provider-turn",
          operationId: decodeCodeOperationId(input.uuid()),
          threadId: thread.id,
          checkoutId: thread.checkoutId,
          sessionId: decodeProviderSessionId(input.uuid()),
          prompt,
          delivery,
        });
        return result.kind === "provider-turn-state" &&
          (result.state === "running" || result.state === "waiting" || result.state === "completed")
          ? sideTaskReportReceipt(reports, result.delivery)
          : {
              kind: "deferred",
              detail:
                result.kind === "provider-turn-state" && result.failure !== undefined
                  ? result.failure.message
                  : "The delivery was not admitted.",
            };
      } catch (error) {
        if (error instanceof CodeServiceError && error.failure.category === "waiting") {
          return { kind: "deferred", detail: error.failure.message };
        }
        return { kind: "deferred", detail: refusalDetail(error) };
      }
    },
  };
}

/**
 * A Chat parent takes the reports as one host-composed turn, admitted through
 * the ordinary Chat command path like an agent-result delivery. The command
 * names the report ids; the service composes the prompt from the journaled
 * reports and journals the turn with the report mark.
 */
export function createChatSideTaskReportDeliveryPort(input: {
  readonly readThread: (threadId: ReturnType<typeof decodeChatThreadId>) => ChatThread | undefined;
  readonly readThreadView: (
    threadId: ReturnType<typeof decodeChatThreadId>,
  ) => ChatThreadView | undefined;
  readonly chat: Pick<ChatService, "read" | "execute">;
}): SideTaskReportDeliveryModePort {
  return {
    alreadyDelivered: (parentThreadId, reportId) => {
      const threadId = decodeChatThreadId(parentThreadId);
      return (input.readThreadView(threadId)?.turns ?? []).some((turn) =>
        markCovers(turn.delivery, reportId),
      );
    },
    dispatch: async (parentThreadId, reports) => {
      const first = reports[0];
      if (first === undefined || first.parentMode !== "chat") {
        return { kind: "refused", detail: "No side-task reports were supplied." };
      }
      const threadId = decodeChatThreadId(parentThreadId);
      const parent = input.readThread(threadId);
      if (parent === undefined || threadIsGone(parent)) {
        return { kind: "refused", detail: "The parent Chat thread is gone." };
      }
      try {
        const thread = input.chat.read(threadId).thread;
        const result = await input.chat.execute({
          kind: "deliver-chat-side-task-report",
          threadId: thread.id,
          expectedVersion: thread.version,
          reportIds: reports.map((report) => report.reportId),
        });
        return result.kind === "turn-created"
          ? sideTaskReportReceipt(reports, result.turn.delivery)
          : { kind: "deferred", detail: "The delivery was not admitted." };
      } catch (error) {
        if (
          error instanceof ChatServiceError &&
          (error.failure.category === "waiting" || error.failure.category === "stale")
        ) {
          return { kind: "deferred", detail: "The parent Chat thread is mid-turn." };
        }
        return {
          kind: "deferred",
          detail: error instanceof Error ? error.message : "The delivery could not be admitted.",
        };
      }
    },
  };
}
