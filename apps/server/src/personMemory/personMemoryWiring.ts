import { randomUUID } from "node:crypto";
import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeProviderSessionId,
  PERSON_MEMORY_REQUEST_SHAPE,
  PERSON_MEMORY_USAGE_AGGREGATE_TYPE,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import { activeChatTurns } from "@octant/domain";
import { smallestShieldModel } from "@octant/domain/shield-judge-policy";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { completeOnceOutcome } from "../harness/nativeHarnessSingleShot";
import type { PersistenceService } from "../persistence/persistenceService";
import { recordOneShotUsage } from "../shield/shieldUsageLedger";
import type { PersonMemoryStore } from "./personMemoryStore";
import { PersonMemorySweep, type PersonMemoryThreadSource } from "./personMemorySweep";

/** The newest person messages a thread is distilled from; older ones are past the input cap anyway. */
const PERSON_MESSAGE_LIMIT = 60;

/** Path-shaped runs in text: home-relative (`~`, `$HOME`, `${HOME}`) or absolute. */
const PATH_SHAPED = /(?:~|\$HOME|\$\{HOME\})?\/[^\s"'`<>()]+/g;

/** Whether text names a path the secret guard protects, ignoring punctuation that ends a sentence. */
function namesProtectedPath(text: string, protectedSecretPath: (path: string) => boolean): boolean {
  return [...text.matchAll(PATH_SHAPED)].some((match) =>
    protectedSecretPath(match[0].replace(/[.,;:!?'"]+$/u, "")),
  );
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
  >;
  readonly store: PersonMemoryStore;
  readonly workThreads: {
    readonly list: () => ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly projectId: string;
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
      readonly completedAt?: string | undefined;
    }>;
  };
  readonly workPersonMessages: (threadId: string, limit: number) => ReadonlyArray<string>;
  readonly codePersonMessages: (threadId: string, limit: number) => ReadonlyArray<string>;
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  readonly scratchRoot: string;
  readonly protectedSecretPath: (path: string) => boolean;
}): PersonMemorySweep {
  const { persistence } = input;
  const chat: PersonMemoryThreadSource = {
    mode: "chat",
    // A Chat being deleted is on its way out; learning from it now would
    // spend a call on a thread whose memory the delete then erases.
    threads: () =>
      persistence.readChatThreads().filter((thread) => thread.lifecycle !== "deleting"),
    read: (threadId) => {
      const thread = persistence
        .readChatThreads()
        .find((candidate) => String(candidate.id) === threadId);
      const view = persistence.readChatThreadView(decodeChatThreadId(threadId));
      if (thread === undefined || view === undefined) return undefined;
      const bodies = new Map(
        view.contents.map((content) => [String(content.contentId), content.body]),
      );
      return {
        title: thread.title,
        projectId: thread.projectId === undefined ? undefined : String(thread.projectId),
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        personMessages: activeChatTurns(view.turns)
          .flatMap((turn) => bodies.get(String(turn.userMessageRef.contentId)) ?? [])
          .slice(-PERSON_MESSAGE_LIMIT),
      };
    },
  };
  const work: PersonMemoryThreadSource = {
    mode: "work",
    threads: () => input.workThreads.list(),
    read: (threadId) => {
      const thread = input.workThreads.list().find((candidate) => candidate.id === threadId);
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
    threads: () => persistence.readCodeThreads(),
    read: (threadId) => {
      const thread = persistence
        .readCodeThreads()
        .find((candidate) => String(candidate.id) === String(decodeCodeThreadId(threadId)));
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
