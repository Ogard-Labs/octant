import { decodeAgentRunId } from "@octant/contracts";
import {
  AgentRunClientFailure,
  type AgentRunClient,
} from "@octant/client-runtime/agent-run-client";
import { useCallback } from "react";
import {
  agentRunCommandFailureMessage,
  agentRunTransportFailureMessage,
} from "./agentsCenterModel";

export interface AgentRunControlCommands {
  acknowledge(input: {
    readonly runId: string;
    readonly version: number;
  }): Promise<string | undefined>;
  cancel(input: { readonly runId: string }): Promise<string | undefined>;
  steer(input: {
    readonly runId: string;
    readonly version: number;
    readonly message: string;
  }): Promise<string | undefined>;
  retry(input: { readonly runId: string; readonly version: number }): Promise<string | undefined>;
  resume(input: { readonly runId: string; readonly version: number }): Promise<string | undefined>;
}

export function useAgentRunControlCommands(
  client: AgentRunClient,
  onSuccess?: () => void | Promise<void>,
): AgentRunControlCommands {
  const refresh = useCallback(async () => {
    await onSuccess?.();
  }, [onSuccess]);

  const acknowledge = useCallback(
    async (input: { readonly runId: string; readonly version: number }) => {
      try {
        const result = await client.acknowledge({
          runId: decodeAgentRunId(input.runId),
          expectedVersion: input.version,
        });
        if (result.kind === "run-command-failed") {
          return agentRunCommandFailureMessage(result);
        }
        await refresh();
        return undefined;
      } catch (error) {
        return agentRunTransportFailureMessage(
          error,
          error instanceof AgentRunClientFailure
            ? error.message
            : "AgentRun acknowledgement failed. Retry against authoritative state.",
        );
      }
    },
    [client, refresh],
  );

  const cancel = useCallback(
    async (input: { readonly runId: string }) => {
      try {
        const { results } = await client.cancel({
          runId: decodeAgentRunId(input.runId),
          scope: "subtree",
        });
        const failed = results.find((result) => result.kind === "run-command-failed");
        if (failed !== undefined) {
          return agentRunCommandFailureMessage(failed);
        }
        await refresh();
        return undefined;
      } catch (error) {
        return agentRunTransportFailureMessage(
          error,
          error instanceof AgentRunClientFailure
            ? error.message
            : "AgentRun cancellation failed. Retry against authoritative state.",
        );
      }
    },
    [client, refresh],
  );

  const command = useCallback(
    async (
      action: "steer" | "retry" | "resume",
      input: { readonly runId: string; readonly version: number; readonly message?: string },
    ) => {
      try {
        const runId = decodeAgentRunId(input.runId);
        const result =
          action === "steer"
            ? await client.steer({
                runId,
                expectedVersion: input.version,
                message: input.message ?? "",
              })
            : action === "retry"
              ? await client.retry({ runId, expectedVersion: input.version })
              : await client.resume({ runId, expectedVersion: input.version });
        if (result.kind === "run-command-failed") {
          return agentRunCommandFailureMessage(result);
        }
        await refresh();
        return undefined;
      } catch (error) {
        return agentRunTransportFailureMessage(
          error,
          error instanceof AgentRunClientFailure
            ? error.message
            : "AgentRun command failed. Retry against authoritative state.",
        );
      }
    },
    [client, refresh],
  );

  return {
    acknowledge,
    cancel,
    steer: (input) => command("steer", input),
    retry: (input) => command("retry", input),
    resume: (input) => command("resume", input),
  };
}
