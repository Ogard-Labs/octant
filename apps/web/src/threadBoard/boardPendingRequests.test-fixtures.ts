import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { vi } from "vitest";
import type { BoardPendingRequestSource } from "./useBoardPendingRequests";

export const BOARD_NOW = Date.parse("2026-10-06T10:00:00.000Z");

/** An instant the given number of minutes before {@link BOARD_NOW}. */
export function minutesAgo(minutes: number): string {
  return new Date(BOARD_NOW - minutes * 60_000).toISOString();
}

/**
 * What the host lists for a Work thread's waiting approval or question. The
 * handle is built from the thread id so a test can tell which card answered.
 */
export function workRequest(input: {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly kind: "approval" | "question";
  readonly text: string;
  readonly minutesAgo: number;
  readonly requestId?: string;
  readonly options?: ReadonlyArray<{ readonly label: string }>;
}): PendingRequest {
  return {
    mode: "work",
    kind: input.kind,
    projectId: "project-work",
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    text: input.text,
    ...(input.kind === "question" ? { options: input.options ?? [] } : {}),
    requestedAt: minutesAgo(input.minutesAgo),
    answer: { requestId: input.requestId ?? `request-${input.threadId}`, expectedVersion: 7 },
  } as unknown as PendingRequest;
}

/** What the host lists for a Code thread's waiting approval or question. */
export function codeRequest(input: {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly kind: "approval" | "question";
  readonly text: string;
  readonly minutesAgo: number;
  readonly options?: ReadonlyArray<{ readonly label: string }>;
}): PendingRequest {
  return {
    mode: "code",
    kind: input.kind,
    projectId: "project-code",
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    text: input.text,
    ...(input.kind === "question" ? { options: input.options ?? [] } : {}),
    requestedAt: minutesAgo(input.minutesAgo),
    answer:
      input.kind === "approval"
        ? {
            threadId: input.threadId,
            checkoutId: "checkout-1",
            approvalId: `approval-${input.threadId}`,
          }
        : {
            threadId: input.threadId,
            checkoutId: "checkout-1",
            requestId: `input-${input.threadId}`,
          },
  } as unknown as PendingRequest;
}

/** A reader whose n-th read returns the n-th list; the last list repeats. */
export function pendingReader(
  ...reads: ReadonlyArray<ReadonlyArray<PendingRequest>>
): PendingRequestClient {
  let index = 0;
  return {
    list: vi.fn(async () => {
      const requests = reads[Math.min(index, reads.length - 1)] ?? [];
      index += 1;
      return { requests, truncated: false };
    }),
  };
}

export function answerClients() {
  return {
    chatClient: { execute: vi.fn(async () => ({})) },
    codeClient: {
      executeOperation: vi.fn(async () => ({ kind: "operation-accepted" })),
      putEvidence: vi.fn(async () => ({ evidenceId: "evidence-1" })),
    },
    workRequestClient: { execute: vi.fn(async () => ({})) },
    workTurnClient: { startFirstTurn: vi.fn(async () => ({ kind: "accepted" })) },
  };
}

/** What the host lists for a Code thread whose finished turn closed by asking. */
export function codeDecisionRequest(input: {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly text: string;
  readonly minutesAgo: number;
  readonly options: ReadonlyArray<{ readonly label: string; readonly recommended: boolean }>;
}): PendingRequest {
  return {
    mode: "code",
    kind: "decision",
    projectId: "project-code",
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    text: input.text,
    options: input.options,
    requestedAt: minutesAgo(input.minutesAgo),
    answer: {
      threadId: input.threadId,
      checkoutId: "checkout-1",
      operationId: `operation-${input.threadId}`,
    },
  } as unknown as PendingRequest;
}

export function boardPendingSource(
  reader: PendingRequestClient | undefined,
  clients: ReturnType<typeof answerClients> = answerClients(),
): BoardPendingRequestSource {
  return {
    pendingRequestClient: reader,
    answerClients: clients as unknown as BoardPendingRequestSource["answerClients"],
    feedRevision: 0,
    settings: {},
    workspace: {},
    now: BOARD_NOW,
  };
}
