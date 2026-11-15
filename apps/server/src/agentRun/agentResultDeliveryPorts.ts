import {
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeProviderSessionId,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type AgentRun,
  type AgentRunId,
  type CodeEvidenceReference,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodeThread,
  type CodeThreadId,
  type WindowId,
  type WorkThread,
  type WorkThreadId,
  type WorkTurnLookupResult,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { Effect } from "effect";
import type { LiveTurnConnection } from "../liveTurn/liveTurnRegistry";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { CodeServiceError } from "../code/codeService";
import { WorkTurnServiceError } from "../work/workTurnService";
import { agentResultDeliveryReceipt } from "./agentResultDeliveryBatch";
import { agentResultDeliveryBatchPrompt } from "./agentResultDeliveryPrompt";
import type { AgentResultDeliveryModePort } from "./agentResultDeliveryService";

/**
 * What a delivery asks of the host. A child's result is owed to its parent by
 * the host, so delivery runs under the host scope: it once borrowed whichever
 * local window was registered, deferring forever with none open and otherwise
 * acting under that window's identity and, for Code, its Project binding.
 */
export interface AgentResultDeliveryPortDependencies {
  readonly uuid: () => string;
  readonly resultText: (runId: AgentRunId) => string | undefined;
}

const deliveryMark = (runs: ReadonlyArray<AgentRun>, run: AgentRun) => ({
  kind: "agent-result" as const,
  runId: run.id,
  runIds: runs.map((child) => child.id),
  runGenerations: runs.map((child) => ({
    runId: child.id,
    generation: child.generation ?? 1,
  })),
});

const refusalDetail = (error: unknown): string =>
  error instanceof Error ? error.message : "The delivery could not be admitted.";

/**
 * A Work parent takes the result as one ordinary turn. The turn path rereads
 * the thread and its active Project; it does not read the mode switch, which
 * an open window used to stand in for, so the host asks the switch itself.
 * Work being off is waited out rather than failed: turning a mode off never
 * discards its data, and the result lands once Work is back on.
 */
export function createWorkAgentResultDeliveryPort(
  input: AgentResultDeliveryPortDependencies & {
    readonly isEnabled: () => boolean;
    readonly readThread: (threadId: WorkThreadId) => WorkThread | undefined;
    readonly startFirstTurn: (windowId: WindowId, input: unknown) => Promise<WorkTurnLookupResult>;
  },
): AgentResultDeliveryModePort {
  return {
    inspect: async (run) =>
      input.readThread(decodeWorkThreadId(String(run.parentThreadId))) === undefined
        ? { kind: "invalid", detail: "The parent Work thread is gone." }
        : { kind: "ready" },
    dispatch: async (runs) => {
      const run = runs[0];
      if (run === undefined) return { kind: "refused", detail: "No child results were supplied." };
      const delivery = deliveryMark(runs, run);
      if (!input.isEnabled()) {
        return { kind: "deferred", detail: "Work is turned off on this host." };
      }
      const thread = input.readThread(decodeWorkThreadId(String(run.parentThreadId)));
      if (thread === undefined || thread.bindingRevisionId === undefined) {
        return { kind: "refused", detail: "The parent Work thread is gone." };
      }
      // A parent a person marked Done takes no turn, but the result is still
      // owed: it waits, readable on the child's run, and lands as a turn once
      // the thread is reopened, whose commit wakes this delivery.
      if (thread.completionConfirmed === true) {
        return { kind: "deferred", detail: "The parent Work thread is marked Done." };
      }
      try {
        const result = await input.startFirstTurn(ROUTINE_HOST_SCOPE_ID, {
          kind: "start-work-thread-turn",
          requestId: decodeWorkTurnRequestId(input.uuid()),
          threadId: thread.id,
          turnId: decodeWorkTurnId(input.uuid()),
          prompt: agentResultDeliveryBatchPrompt(runs, input.resultText),
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
          ? agentResultDeliveryReceipt(delivery, result.turn.delivery)
          : {
              kind: "refused",
              detail:
                "message" in result && typeof result.message === "string"
                  ? result.message
                  : "The delivery was not admitted.",
            };
      } catch (error) {
        if (error instanceof WorkTurnServiceError && error.failure.category === "stale") {
          return { kind: "deferred", detail: "The parent Work thread is mid-turn." };
        }
        // Marked Done while the turn was prepared: a refusal here would settle
        // the result as failed, and reopening could no longer deliver it.
        if (input.readThread(thread.id)?.completionConfirmed === true) {
          return { kind: "deferred", detail: "The parent Work thread is marked Done." };
        }
        return { kind: "refused", detail: refusalDetail(error) };
      }
    },
  };
}

/**
 * A Code parent takes the result as one provider turn. Staging and admission
 * both authorize the host scope through Code Project access, which reaches
 * only an active Code Project, so an inactive one refuses the delivery.
 */
export function createCodeAgentResultDeliveryPort(
  input: AgentResultDeliveryPortDependencies & {
    readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
    /** Whether the thread's session is being compacted, which holds every new turn. */
    readonly compacting?: (threadId: CodeThreadId) => boolean;
    readonly stageEvidence?: (
      windowId: WindowId,
      threadId: CodeThreadId,
      text: string,
    ) => Promise<CodeEvidenceReference> | CodeEvidenceReference;
    readonly executeOperation?: (
      windowId: WindowId,
      command: CodeOperationCommand,
    ) => Promise<CodeOperationResult> | CodeOperationResult;
  },
): AgentResultDeliveryModePort {
  return {
    inspect: async (run) =>
      input.readThread(decodeCodeThreadId(String(run.parentThreadId))) === undefined
        ? { kind: "invalid", detail: "The parent Code thread is gone." }
        : { kind: "ready" },
    dispatch: async (runs) => {
      const run = runs[0];
      if (run === undefined) return { kind: "refused", detail: "No child results were supplied." };
      const delivery = deliveryMark(runs, run);
      const thread = input.readThread(decodeCodeThreadId(String(run.parentThreadId)));
      if (
        thread === undefined ||
        input.stageEvidence === undefined ||
        input.executeOperation === undefined
      ) {
        return { kind: "refused", detail: "The parent Code thread is gone." };
      }
      // The result waits the compaction out rather than being spent on a
      // refused turn; it is offered again when the compaction ends.
      if (input.compacting?.(thread.id) === true) {
        return { kind: "deferred", detail: "The parent Code thread's session is being compacted." };
      }
      try {
        const prompt = await input.stageEvidence(
          ROUTINE_HOST_SCOPE_ID,
          thread.id,
          agentResultDeliveryBatchPrompt(runs, input.resultText),
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
          ? agentResultDeliveryReceipt(delivery, result.delivery)
          : {
              kind: "refused",
              detail:
                result.kind === "provider-turn-state" && result.failure !== undefined
                  ? result.failure.message
                  : "The delivery was not admitted.",
            };
      } catch (error) {
        // A compaction that began while the result was being staged refuses
        // the turn as `waiting`, and the result waits it out. The refusal
        // says so itself: by now the compaction may already have ended.
        if (error instanceof CodeServiceError && error.failure.category === "waiting") {
          return { kind: "deferred", detail: error.failure.message };
        }
        return { kind: "refused", detail: refusalDetail(error) };
      }
    },
  };
}

/**
 * Steers finished children's results into their parent's running turn, so
 * the parent's agent reads them now rather than after its turn ends. The
 * results are the same framed prompt a delivery turn would carry, and the
 * parent's taint is already recorded: every approval gate reads that mark
 * when it decides, so the rest of the turn acts as having read outside
 * content. A turn that marked itself as not covered by that mark alone, or a
 * runtime that takes no note or not one this long, leaves the delivery to
 * wait for a turn of its own.
 */
export function createAgentResultSteering(input: {
  readonly liveTurn: (threadId: string) => LiveTurnConnection | undefined;
  readonly resultText: (runId: AgentRunId) => string | undefined;
}): (runs: ReadonlyArray<AgentRun>) => Promise<"steered" | "not-steered"> {
  return async (runs) => {
    const run = runs[0];
    if (run === undefined) return "not-steered";
    const live = input.liveTurn(String(run.parentThreadId));
    const steer = live?.connection.steer;
    if (live === undefined || steer === undefined || !live.takesSteeredResults) {
      return "not-steered";
    }
    const outcome = await Effect.runPromise(
      steer({
        sessionId: live.sessionId,
        message: agentResultDeliveryBatchPrompt(runs, input.resultText),
        source: "agent-result",
      }).pipe(Effect.catchAll(() => Effect.succeed("unsupported" as const))),
    );
    return outcome === "steered" ? "steered" : "not-steered";
  };
}
