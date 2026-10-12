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
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
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
        return { kind: "refused", detail: refusalDetail(error) };
      }
    },
  };
}
