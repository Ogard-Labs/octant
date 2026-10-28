import { randomUUID } from "node:crypto";
import { decodeChatThreadId, decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import { createAgentRunInteractions } from "../agentRun/agentRunInteractions";
import { readApprovalOutsideContent } from "../context/externalContentTaintProjection";
import { awaitsLeadQuestion } from "../harness/leadApprovalAttention";
import { NativeHarnessApprovalStore } from "../harness/nativeHarnessApprovals";
import {
  NativeHarnessQuestionStore,
  type NativeHarnessQuestionStoreOptions,
} from "../harness/nativeHarnessQuestions";
import { NativeHarnessSessionStore } from "../harness/nativeHarnessSessionStore";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";

export type HarnessStateDependencies = Pick<ServerStart, "persistence"> &
  Pick<AuthorityWiring, "agentRunParentAuthority" | "agentRunPersistence"> &
  Pick<FoundationsWiring, "workThreadProjection">;

/**
 * The native harness's session, question, and approval stores, and the
 * interactions an agent run asks through. Agent runs, providers, and every
 * mode read them, so they are built ahead of all three. Code shows a question
 * inline, so its runtime subscribes to the question stores below rather than
 * the stores holding it.
 */
export function wireHarnessState(deps: HarnessStateDependencies) {
  const { agentRunParentAuthority, agentRunPersistence, persistence, workThreadProjection } = deps;

  const questionAskedListeners: Array<NonNullable<NativeHarnessQuestionStoreOptions["onAsked"]>> =
    [];
  const questionSettledListeners: Array<
    NonNullable<NativeHarnessQuestionStoreOptions["onSettled"]>
  > = [];
  const onHarnessQuestionAsked = (
    listener: NonNullable<NativeHarnessQuestionStoreOptions["onAsked"]>,
  ): void => {
    questionAskedListeners.push(listener);
  };
  const onHarnessQuestionSettled = (
    listener: NonNullable<NativeHarnessQuestionStoreOptions["onSettled"]>,
  ): void => {
    questionSettledListeners.push(listener);
  };

  const nativeHarnessSessions = new NativeHarnessSessionStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
    // Read once, while the store replays at start-up: restart reconciliation
    // has already marked the thread's remote turn interrupted.
    runsOnSshTarget: (threadId) => {
      const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
      return (
        thread !== undefined &&
        persistence.readCodeCheckout(thread.checkoutId)?.kind === "remote-root"
      );
    },
  });
  const nativeHarnessQuestions = new NativeHarnessQuestionStore({
    sessions: nativeHarnessSessions,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    onAsked: (input) => {
      for (const listener of questionAskedListeners) listener(input);
    },
    onSettled: (input) => {
      for (const listener of questionSettledListeners) listener(input);
    },
  });
  const nativeHarnessApprovals = new NativeHarnessApprovalStore({
    sessions: nativeHarnessSessions,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    outsideContent: (threadId) => readApprovalOutsideContent(persistence.connection, threadId),
  });
  const agentRunInteractions = createAgentRunInteractions({
    getById: (id) => agentRunPersistence.getById(id),
    approvals: nativeHarnessApprovals,
    questions: nativeHarnessQuestions,
    providerName: (id) => persistence.readProviderInstance(id)?.displayName,
    parentAuthority: agentRunParentAuthority,
    parentLead: (run) => {
      const id = String(run.parentThreadId);
      const parent =
        run.routingReceipt.mode === "chat"
          ? persistence.readChatThread(decodeChatThreadId(id))
          : run.routingReceipt.mode === "work"
            ? workThreadProjection.read(decodeWorkThreadId(id))
            : persistence.readCodeThread(decodeCodeThreadId(id));
      return parent?.lifecycle === "active"
        ? {
            hostId: run.routingReceipt.hostId,
            providerInstanceId: parent.providerInstanceId,
            modelId: parent.modelId,
          }
        : undefined;
    },
  });

  // The lead's own question parks a Work thread on the person as a pending
  // Work question does. Code shows it through its inline question path, and a
  // Chat lead's question is journaled on the Chat attempt, not here.
  const threadAwaitsHarnessQuestion = (threadId: string): boolean =>
    awaitsLeadQuestion(
      { questions: nativeHarnessQuestions, sessions: nativeHarnessSessions },
      threadId,
    );

  return {
    agentRunInteractions,
    nativeHarnessApprovals,
    nativeHarnessQuestions,
    nativeHarnessSessions,
    onHarnessQuestionAsked,
    onHarnessQuestionSettled,
    threadAwaitsHarnessQuestion,
  };
}

export type HarnessStateWiring = ReturnType<typeof wireHarnessState>;
