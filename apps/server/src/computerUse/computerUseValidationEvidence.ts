import {
  decodeValidationEvidenceRecord,
  decodeValidationPlan,
  sameToolActionAuthority,
  type EventActor,
  type ToolActionAuthority,
  type ValidationPlanId,
} from "@octant/contracts";
import type { ComputerUseEvidenceEvent } from "./computerUseRuntime";
import type { ValidationEventStore } from "../validation/validationEventStore";

export type ComputerUseValidationEventStorePort = Pick<
  ValidationEventStore,
  "appendPlan" | "appendEvidence"
>;

export function createComputerUseValidationEvidenceRecorder(options: {
  readonly eventStore: ComputerUseValidationEventStorePort;
  readonly uuid: () => string;
  readonly clock: () => string;
}): { readonly record: (event: ComputerUseEvidenceEvent) => Promise<void> } {
  const sessions = new Map<string, EvidenceSession>();
  return {
    record: async (event) => {
      let session = sessions.get(event.sessionId);
      if (session === undefined) {
        if (event.event.sequence !== 1) throw invalidSequence();
        const planId = options.uuid() as ValidationPlanId;
        const plan = decodeValidationPlan({
          planId,
          authority: event.authority,
          steps: [
            {
              stepId: "computer-use-lifecycle",
              description: "Host-owned computer-use lifecycle and cleanup",
              sources: [source(event)],
              expectedOutcome: "passed",
            },
          ],
          createdAt: event.event.occurredAt,
        });
        options.eventStore.appendPlan({ plan, expectedVersion: 0 });
        session = {
          planId,
          nextSequence: 1,
          expectedVersion: 1,
          threadId: event.threadId,
          actionId: event.actionId,
          correlationId: event.correlationId,
          requestedBy: event.requestedBy,
          authority: event.authority,
        };
        sessions.set(event.sessionId, session);
      }
      if (!matches(session, event) || event.event.sequence !== session.nextSequence) {
        throw invalidSequence();
      }
      const evidence = decodeValidationEvidenceRecord({
        evidenceId: options.uuid(),
        planId: session.planId,
        stepId: "computer-use-lifecycle",
        source: source(event),
        outcome: outcome(event.event.kind),
        authority: event.authority,
        observedAt: event.event.occurredAt,
        detail: event.event.detail,
        redacted: event.event.kind === "observation-recorded",
      });
      options.eventStore.appendEvidence({
        evidence,
        expectedVersion: session.expectedVersion,
      });
      session.nextSequence += 1;
      session.expectedVersion += 1;
    },
  };
}

interface EvidenceSession {
  readonly planId: ValidationPlanId;
  nextSequence: number;
  expectedVersion: number;
  readonly threadId: string;
  readonly actionId: string;
  readonly correlationId: string;
  readonly requestedBy: EventActor;
  readonly authority: ToolActionAuthority;
}

function source(event: ComputerUseEvidenceEvent) {
  return {
    kind: "computer-use-observation" as const,
    reference: `computer-use:${event.sessionId}:${event.threadId}:${event.event.sequence}`,
    actionId: event.actionId as never,
    correlationId: event.correlationId as never,
  };
}

function matches(session: EvidenceSession, event: ComputerUseEvidenceEvent): boolean {
  return (
    session.threadId === event.threadId &&
    session.actionId === event.actionId &&
    session.correlationId === event.correlationId &&
    session.requestedBy.kind === event.requestedBy.kind &&
    session.requestedBy.actorId === event.requestedBy.actorId &&
    sameToolActionAuthority(session.authority, event.authority)
  );
}

function outcome(kind: ComputerUseEvidenceEvent["event"]["kind"]) {
  switch (kind) {
    case "action-completed":
    case "cleanup-completed":
      return "passed" as const;
    case "approval-denied":
    case "session-failed":
      return "failed" as const;
    case "stop-requested":
    case "cleanup-failed":
    case "session-interrupted":
      return "interrupted" as const;
    default:
      return "inconclusive" as const;
  }
}

function invalidSequence(): Error {
  return new Error("Computer-use evidence sequence is invalid.");
}
