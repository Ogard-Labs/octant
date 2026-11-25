import { randomUUID } from "node:crypto";
import {
  type ChatThread,
  type ChatThreadView,
  type ChatTurn,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderSessionId,
  decodeSpendCeilingReservationId,
  PERSON_MEMORY_REQUEST_SHAPE,
  PERSON_MEMORY_USAGE_AGGREGATE_TYPE,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import { activeChatTurns } from "@octant/domain";
import { isProviderAllowedByProjectPolicy } from "@octant/domain/project-provider-policy";
import { smallestShieldModel } from "@octant/domain/shield-judge-policy";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { completeOnceOutcome } from "../harness/nativeHarnessSingleShot";
import type { PersistenceService } from "../persistence/persistenceService";
import { recordOneShotUsage } from "../shield/shieldUsageLedger";
import type { SpendCeilingService } from "../spendCeilingService";
import { namesProtectedPath } from "./namesProtectedPath";
import type { PersonMemoryStore } from "./personMemoryStore";
import {
  PersonMemorySweep,
  type PersonMemoryThreadSource,
  type PersonMessage,
} from "./personMemorySweep";

interface WorkThreadFacts {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly completedAt?: string | undefined;
}

type CodeThread = ReturnType<PersistenceService["readCodeThreads"]>[number];

/** The newest person messages a thread is distilled from; older ones are past the input cap anyway. */
const PERSON_MESSAGE_LIMIT = 60;

/**
 * A Chat thread's newest messages from the person. A turn the host started to
 * deliver a subagent's result carries that result where the person's message
 * would be, so it is left out, as it is for a Work or Code thread.
 */
export function chatPersonMessages(
  view: {
    readonly turns: ReadonlyArray<
      Pick<ChatTurn, "id" | "supersedes" | "rewound" | "delivery" | "userMessageRef"> & {
        readonly createdAt?: string;
      }
    >;
    readonly contents: ReadonlyArray<
      Pick<ChatThreadView["contents"][number], "contentId" | "body">
    >;
  },
  limit: number,
  /** Whether a turn's message is the person's own words, as the store reads marks. */
  counts: (turn: { readonly turnId: string; readonly began: string }) => boolean,
  /** Whether the host marked the turn's message typed by the person. */
  typed: (turnId: string) => boolean = () => false,
): ReadonlyArray<PersonMessage> {
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content.body]));
  return activeChatTurns(view.turns)
    .filter((turn) => turn.delivery === undefined)
    .filter((turn) => counts({ turnId: String(turn.id), began: turn.createdAt ?? "" }))
    .flatMap((turn) => {
      const text = bodies.get(String(turn.userMessageRef.contentId));
      return text === undefined
        ? []
        : [
            {
              id: String(turn.id),
              at: turn.createdAt ?? "",
              text,
              typed: typed(String(turn.id)),
            },
          ];
    })
    .slice(-limit);
}

/**
 * When a thread's stream last recorded anything, which is when its last turn
 * ended as well as when it began. Chat reads its own stream; Code reads the
 * thread's operations through the index that starts at the thread. Newest
 * first and one row, so the cost does not grow with the thread's length.
 */
export function latestEventAt(
  connection: PersistenceService["connection"],
  key:
    | { readonly aggregateType: string; readonly aggregateId: string; readonly eventName?: string }
    | { readonly aggregateType: string; readonly threadId: string },
): string | undefined {
  const row =
    "threadId" in key
      ? connection
          .prepare(
            `SELECT occurred_at AS at FROM event_journal
             WHERE aggregate_type = ?
               AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
             ORDER BY global_sequence DESC LIMIT 1`,
          )
          .get(key.aggregateType, key.threadId)
      : key.eventName === undefined
        ? connection
            .prepare(
              `SELECT occurred_at AS at FROM event_journal
               WHERE aggregate_type = ? AND aggregate_id = ?
               ORDER BY global_sequence DESC LIMIT 1`,
            )
            .get(key.aggregateType, key.aggregateId)
        : connection
            .prepare(
              `SELECT occurred_at AS at FROM event_journal
               WHERE aggregate_type = ? AND aggregate_id = ? AND event_name = ?
               ORDER BY global_sequence DESC LIMIT 1`,
            )
            .get(key.aggregateType, key.aggregateId, key.eventName);
  return (row as { readonly at: string } | undefined)?.at;
}

/**
 * The sweep over Chat, Work, and Code with the host's own reads: each mode's
 * threads, and only the messages the person wrote in one. The model call is
 * a tool-less one-shot in a scratch folder outside every Project, on the
 * thread's own provider account unless Settings picks another.
 */
export function createPersonMemorySweep(input: {
  readonly persistence: Pick<
    PersistenceService,
    | "connection"
    | "journal"
    | "readChatThreads"
    | "readChatThreadView"
    | "readCodeThreads"
    | "readProviderInstance"
    | "readProviderCatalog"
    | "readProject"
  >;
  readonly store: PersonMemoryStore;
  readonly workThreads: {
    readonly list: () => ReadonlyArray<WorkThreadFacts>;
  };
  /** The newest messages the person wrote in a Work or Code thread that count as theirs. */
  readonly workPersonMessages: (threadId: string, limit: number) => ReadonlyArray<PersonMessage>;
  readonly codePersonMessages: (threadId: string, limit: number) => ReadonlyArray<PersonMessage>;
  /** When the person last wrote to a Work or Code thread, whether it counts or not. */
  readonly workLastMessageAt: (threadId: string) => string | undefined;
  /** When a Work thread's newest turn last changed, which is when it ended. */
  readonly workLastActivityAt: (threadId: string) => string | undefined;
  readonly codeLastMessageAt: (threadId: string) => string | undefined;
  /** A turn is running or waiting in the thread. */
  readonly turnRunning: (threadId: string) => boolean;
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  /** Why the account the person chose cannot be asked now; undefined when it can. */
  readonly accountUnavailable: (providerInstanceId: ProviderInstanceId) => string | undefined;
  readonly scratchRoot: string;
  readonly protectedSecretPath: (path: string) => boolean;
  /** The thread's and its Project's spend ceilings, asked before each call. */
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle">;
}): PersonMemorySweep {
  const { persistence } = input;
  // Each pass lists a mode's threads once; reading one thread uses that list
  // instead of scanning it again for every thread.
  const listedChat = new Map<string, ChatThread>();
  const listedCode = new Map<string, CodeThread>();
  const chat: PersonMemoryThreadSource = {
    mode: "chat",
    // A Chat being deleted is on its way out; learning from it now would
    // spend a call on a thread whose memory the delete then erases.
    threads: () => {
      const threads = persistence.readChatThreads().filter((thread) => thread.lifecycle !== "deleting");
      listedChat.clear();
      for (const thread of threads) listedChat.set(String(thread.id), thread);
      return threads;
    },
    peek: (threadId) => ({
      lastMessageAt: latestEventAt(persistence.connection, {
        aggregateType: "chat-thread",
        aggregateId: threadId,
        eventName: "chat.turn-created@1",
      }),
      lastActivityAt: latestEventAt(persistence.connection, {
        aggregateType: "chat-thread",
        aggregateId: threadId,
      }),
      running: input.turnRunning(threadId),
    }),
    read: (threadId) => {
      const thread =
        listedChat.get(threadId) ??
        persistence.readChatThreads().find((candidate) => String(candidate.id) === threadId);
      const view = persistence.readChatThreadView(decodeChatThreadId(threadId));
      if (thread === undefined || view === undefined) return undefined;
      return {
        title: thread.title,
        projectId: thread.projectId === undefined ? undefined : String(thread.projectId),
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        personMessages: chatPersonMessages(
          view,
          PERSON_MESSAGE_LIMIT,
          (turn) => input.store.countsAsPersonWords({ mode: "chat", threadId, ...turn }),
          (turnId) => input.store.isTurnTyped({ mode: "chat", threadId, turnId }),
        ),
      };
    },
  };
  const listedWork = new Map<string, WorkThreadFacts>();
  const work: PersonMemoryThreadSource = {
    mode: "work",
    threads: () => {
      const threads = input.workThreads.list();
      listedWork.clear();
      for (const thread of threads) listedWork.set(thread.id, thread);
      return threads;
    },
    peek: (threadId) => ({
      lastMessageAt: input.workLastMessageAt(threadId),
      lastActivityAt: input.workLastActivityAt(threadId),
      running: input.turnRunning(threadId),
    }),
    read: (threadId) => {
      const thread =
        listedWork.get(threadId) ??
        input.workThreads.list().find((candidate) => candidate.id === threadId);
      if (thread === undefined) return undefined;
      return {
        title: thread.title,
        projectId: thread.projectId,
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        personMessages: input.workPersonMessages(threadId, PERSON_MESSAGE_LIMIT),
      };
    },
  };
  const code: PersonMemoryThreadSource = {
    mode: "code",
    threads: () => {
      const threads = persistence.readCodeThreads();
      listedCode.clear();
      for (const thread of threads) listedCode.set(String(thread.id), thread);
      return threads;
    },
    peek: (threadId) => ({
      lastMessageAt: input.codeLastMessageAt(threadId),
      lastActivityAt: latestEventAt(persistence.connection, {
        aggregateType: "code-operation",
        threadId,
      }),
      running: input.turnRunning(threadId),
    }),
    read: (threadId) => {
      const decoded = String(decodeCodeThreadId(threadId));
      const thread =
        listedCode.get(decoded) ??
        persistence.readCodeThreads().find((candidate) => String(candidate.id) === decoded);
      if (thread === undefined) return undefined;
      return {
        title: thread.title,
        projectId: String(thread.projectId),
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        personMessages: input.codePersonMessages(threadId, PERSON_MESSAGE_LIMIT),
      };
    },
  };
  return new PersonMemorySweep({
    store: input.store,
    sources: [chat, work, code],
    namesProtectedPath: (text) => namesProtectedPath(text, input.protectedSecretPath),
    model: {
      projectAllows: ({ projectId, model }) => {
        if (projectId === undefined) return true;
        const project = persistence.readProject(decodeProjectId(projectId));
        // A Chat Project keeps no provider rule; any other Project's rule judges
        // the provider and model that would read its threads.
        if (project === undefined || project.type === "chat") return true;
        const instance = persistence.readProviderInstance(model.providerInstanceId);
        if (instance === undefined) return false;
        const facts = persistence
          .readProviderCatalog?.(model.providerInstanceId)
          ?.models.find((candidate) => candidate.id === model.modelId);
        return isProviderAllowedByProjectPolicy(project, instance, facts);
      },
      admit: ({ mode, threadId, projectId, upperBoundTokens }) => {
        if (input.spendCeiling === undefined) {
          return { status: "admitted", settle: () => undefined };
        }
        const reservationId = decodeSpendCeilingReservationId(randomUUID());
        const admission = input.spendCeiling.admit({
          reservationId,
          threadId,
          threadType: `${mode}-thread`,
          ...(projectId === undefined ? {} : { projectId }),
          turnUpperBoundTokens: upperBoundTokens,
          // Learning is spend, not a turn of the thread's own.
          countsAsTurn: false,
        });
        if (admission.status === "refused") return { status: "refused" };
        return {
          status: "admitted",
          settle: (usage) =>
            input.spendCeiling?.settle({
              reservationId,
              ...(usage === undefined
                ? {}
                : { observedTokens: usage.inputTokens + usage.outputTokens }),
            }),
        };
      },
      resolve: ({ chosen, thread }) => {
        const model =
          chosen ??
          (() => {
            const models =
              persistence.readProviderCatalog?.(thread.providerInstanceId)?.models ?? [];
            return {
              providerInstanceId: thread.providerInstanceId,
              modelId: smallestShieldModel(models)?.id ?? thread.modelId,
            };
          })();
        const instance = persistence.readProviderInstance(model.providerInstanceId);
        if (instance === undefined || !instance.enabled) return undefined;
        // A chosen account that is not ready or is at its limit makes the
        // thread wait for a later pass; it is never distilled on another.
        if (chosen !== undefined && input.accountUnavailable(chosen.providerInstanceId)) {
          return undefined;
        }
        return { model, driverKind: String(instance.driverKind) };
      },
      complete: async ({ model, instructions, prompt, timeoutMs }) => {
        const driver = input.resolveDriver(model.providerInstanceId);
        if (driver === undefined) return { status: "unavailable" };
        const outcome = await completeOnceOutcome({
          driver,
          providerInstanceId: model.providerInstanceId,
          modelId: model.modelId,
          sessionId: decodeProviderSessionId(randomUUID()),
          projectRoot: input.scratchRoot,
          instructions,
          prompt,
          timeoutMs,
        });
        if (outcome.status === "completed") {
          return {
            status: "answered",
            text: outcome.text,
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          };
        }
        // A reply steered by outside content is not used, but it was paid for.
        return outcome.status === "withheld" ? { status: "withheld" } : { status: "unavailable" };
      },
      recordUsage: ({ threadId, model, usage }) =>
        recordOneShotUsage(
          {
            connection: persistence.connection,
            journal: persistence.journal,
            clock: () => new Date().toISOString(),
            uuid: randomUUID,
          },
          {
            threadId,
            providerInstanceId: model.providerInstanceId,
            modelId: model.modelId,
            usage,
            aggregateType: PERSON_MEMORY_USAGE_AGGREGATE_TYPE,
            requestShape: PERSON_MEMORY_REQUEST_SHAPE,
          },
        ),
    },
  });
}
