import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { ChatClientFailure, type ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { latestActiveChatAttempt } from "@octant/client-runtime";
import {
  WorkTurnClientFailure,
  type WorkTurnClient,
} from "@octant/client-runtime/work-turn-client";
import {
  decodeAgentRunId,
  decodeChatThreadId,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeWorkThreadId,
} from "@octant/contracts";
import type { WorkingNowRow } from "./workingNow";

/**
 * What stopping a row came to. A refusal carries the host's own words so the
 * row can say why it kept running instead of going quiet.
 */
export type StopRowOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "nothing-running" }
  | { readonly kind: "refused"; readonly message: string };

/** The readers and commands a window already holds; a mode without one cannot be stopped from here. */
export interface StopRowClients {
  readonly chatClient: ChatClient | undefined;
  readonly codeClient: CodeClient | undefined;
  readonly workTurnClient: WorkTurnClient | undefined;
  readonly agentRunClient: AgentRunClient | undefined;
}

const UNAVAILABLE: StopRowOutcome = {
  kind: "refused",
  message: "This window cannot stop that work.",
};

function failureMessage(error: unknown): string {
  if (error instanceof ChatClientFailure || error instanceof WorkTurnClientFailure) {
    return error.message;
  }
  return "The turn could not be stopped. Try again.";
}

/**
 * Stops what a Running row shows, through the command each mode already uses
 * for the Stop control inside an open thread. A start screen has no thread
 * open, so the running turn is read first (the navigation rows carry no turn
 * or attempt id) and then cancelled by the same command with the same guards:
 * a turn that finished meanwhile is reported, never cancelled twice.
 */
export async function stopRunningRow(
  clients: StopRowClients,
  row: WorkingNowRow,
): Promise<StopRowOutcome> {
  try {
    if (row.runId !== undefined) return await stopAgentRun(clients.agentRunClient, row.runId);
    switch (row.mode) {
      case "chat":
        return await stopChatTurn(clients.chatClient, row.threadId);
      case "work":
        return await stopWorkTurn(clients.workTurnClient, row.threadId);
      case "code":
        return await stopCodeTurn(clients.codeClient, row.threadId);
    }
  } catch (error) {
    return { kind: "refused", message: failureMessage(error) };
  }
}

async function stopChatTurn(client: ChatClient | undefined, id: string): Promise<StopRowOutcome> {
  if (client === undefined) return UNAVAILABLE;
  const view = await client.thread(decodeChatThreadId(id));
  const attempt = latestActiveChatAttempt(view);
  if (attempt === undefined) return { kind: "nothing-running" };
  await client.execute({
    kind: "interrupt-chat-turn",
    threadId: view.thread.id,
    expectedVersion: view.thread.version,
    turnId: attempt.turnId,
    attemptId: attempt.id,
  });
  return { kind: "stopped" };
}

async function stopWorkTurn(
  client: WorkTurnClient | undefined,
  id: string,
): Promise<StopRowOutcome> {
  if (client === undefined) return UNAVAILABLE;
  const transcript = await client.transcript(decodeWorkThreadId(id));
  const latest = transcript.turns.at(-1);
  if (latest === undefined || (latest.status !== "accepted" && latest.status !== "running")) {
    return { kind: "nothing-running" };
  }
  await client.cancelFirstTurn({
    kind: "cancel-work-turn",
    requestId: latest.requestId,
    threadId: latest.threadId,
    turnId: latest.turnId,
  });
  return { kind: "stopped" };
}

async function stopCodeTurn(client: CodeClient | undefined, id: string): Promise<StopRowOutcome> {
  if (client === undefined) return UNAVAILABLE;
  const view = await client.thread(decodeCodeThreadId(id));
  const result = await client.executeOperation({
    kind: "cancel-provider-turn",
    operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
    threadId: view.thread.id,
    checkoutId: view.checkout.id,
  });
  return result.kind === "operation-failed"
    ? { kind: "refused", message: result.failure.message }
    : { kind: "stopped" };
}

async function stopAgentRun(
  client: AgentRunClient | undefined,
  id: string,
): Promise<StopRowOutcome> {
  if (client === undefined) return UNAVAILABLE;
  const { results } = await client.cancel({ runId: decodeAgentRunId(id), scope: "self" });
  const refused = results.find((result) => result.kind === "run-command-failed");
  return refused === undefined
    ? { kind: "stopped" }
    : { kind: "refused", message: refused.message ?? "The agent run could not be stopped." };
}
