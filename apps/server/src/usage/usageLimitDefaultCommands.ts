/**
 * The mode commands the usage-limit defaults run: each mode's ordinary
 * schedule-resume and snooze-at-reset commands, sent as the host (the routine
 * host scope, journaled as the `system` actor) with the resume record marked
 * `origin: "default"`. Kept apart from the wiring so the same code the host
 * runs is what the mode services' tests drive.
 */
import {
  decodeAggregateVersion,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeEventActor,
  type WindowId,
} from "@octant/contracts";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { ChatServiceExecutionContext } from "../chat/chatService";
import type { CodeServiceExecutionContext } from "../code/codeService";
import type { WorkThreadExecutionContext } from "../work/workThreadService";
import type { UsageLimitStop } from "./usageLimitDefaults";

export interface UsageLimitDefaultCommandPorts {
  /** The routine host scope the commands run under; no window lends them identity. */
  readonly hostScope: WindowId;
  /** The thread aggregate's current version, read when the command is built. */
  readonly readVersion: (
    aggregateType: "chat-thread" | "work-thread" | "code-thread",
    threadId: string,
  ) => number;
  readonly chat: {
    readonly execute: (input: unknown, context?: ChatServiceExecutionContext) => Promise<unknown>;
  };
  readonly work: {
    readonly execute: (
      windowId: WindowId,
      input: unknown,
      context?: WorkThreadExecutionContext,
    ) => Promise<unknown>;
  };
  readonly code: {
    readonly execute: (
      windowId: WindowId,
      input: never,
      signal?: AbortSignal,
      context?: CodeServiceExecutionContext,
    ) => unknown;
  };
}

export function usageLimitDefaultCommands(ports: UsageLimitDefaultCommandPorts): {
  readonly scheduleResume: (stop: UsageLimitStop) => Promise<void>;
  readonly snoozeAtReset: (stop: UsageLimitStop) => Promise<void>;
} {
  const hostActor = decodeEventActor({ kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID });
  const version = (stop: UsageLimitStop) =>
    decodeAggregateVersion(ports.readVersion(`${stop.mode}-thread`, stop.threadId));
  return {
    scheduleResume: async (stop) => {
      const expectedVersion = version(stop);
      const context = { usageResumeOrigin: "default" as const, actor: hostActor };
      if (stop.mode === "chat") {
        await ports.chat.execute(
          {
            kind: "schedule-chat-usage-resume",
            threadId: stop.threadId,
            expectedVersion,
            turnId: stop.turnId,
            attemptId: stop.attemptId,
          },
          context,
        );
      } else if (stop.mode === "work") {
        await ports.work.execute(
          ports.hostScope,
          {
            kind: "schedule-work-usage-resume",
            threadId: stop.threadId,
            expectedVersion,
            turnId: stop.turnId,
          },
          context,
        );
      } else {
        await ports.code.execute(
          ports.hostScope,
          {
            kind: "schedule-code-usage-resume",
            threadId: decodeCodeThreadId(stop.threadId),
            expectedVersion,
            operationId: decodeCodeOperationId(stop.turnId),
          } as never,
          undefined,
          context,
        );
      }
    },
    snoozeAtReset: async (stop) => {
      const expectedVersion = version(stop);
      const context = { actor: hostActor };
      if (stop.mode === "chat") {
        await ports.chat.execute(
          { kind: "snooze-chat-thread-at-usage-reset", threadId: stop.threadId, expectedVersion },
          context,
        );
      } else if (stop.mode === "work") {
        await ports.work.execute(
          ports.hostScope,
          { kind: "snooze-work-thread-at-usage-reset", threadId: stop.threadId, expectedVersion },
          context,
        );
      } else {
        await ports.code.execute(
          ports.hostScope,
          {
            kind: "snooze-code-thread-at-usage-reset",
            threadId: decodeCodeThreadId(stop.threadId),
            expectedVersion,
          } as never,
          undefined,
          context,
        );
      }
    },
  };
}
