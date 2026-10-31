import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type CodeThreadId,
  LOCAL_HOST_ID,
  type ProviderInstance,
  type ProviderModel,
  ReplayCursor,
} from "@octant/contracts";
import { isProviderAllowedByProjectPolicy } from "@octant/domain";
import { Schema } from "effect";
import {
  deriveToolHostId,
  ServerBrowserAuthorityResolver,
} from "../browser/browserAuthorityResolver";
import { CodeEvidenceStore } from "../code/codeEvidenceStore";
import { CodeOperationEventStore } from "../code/codeOperationEventStore";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { requireJournalHydration } from "../persistence/journalHydration";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { HostMemoryGuard } from "../hostMemoryGuard";
import { readSystemMemory } from "../hostMemorySignal";
import { readHostMemoryLimits } from "../persistence/hostMemoryLimitsProjection";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { WorkArtifactProjection } from "../work/workArtifactProjection";
import { hydrateWorkArtifactProjectionFromJournal } from "../work/workPromotionProjectPort";
import {
  admittedParentCodeContext,
  type AdmittedParentCodeContextInput,
} from "../agentRun/agentRunParentContext";
import {
  hydrateWorkThreadProjectionFromJournal,
  WorkThreadProjection,
} from "../work/workThreadProjection";
import {
  hydrateWorkTurnProjectionFromJournal,
  WorkTurnProjection,
} from "../work/workTurnProjection";
import type { ServerStart } from "./serverShape";

export type FoundationsDependencies = Pick<ServerStart, "latencyStats" | "options" | "persistence">;

/**
 * What every other area reads and what depends on persistence and options
 * alone: the Work projections (threads, turns, and artifacts), the provider runtime registry, the browser
 * authority, and the Code reads an agent run's parent context is built from.
 * They are built first so that no area has to reach for one through a getter.
 */
export function wireFoundations(deps: FoundationsDependencies) {
  const { latencyStats, options, persistence } = deps;

  const workThreadProjection = new WorkThreadProjection();
  requireJournalHydration(
    hydrateWorkThreadProjectionFromJournal({
      replay: (cursor) =>
        persistence.journal.replayAggregateType({
          ...Schema.decodeUnknownSync(ReplayCursor)({
            afterSequence: cursor.afterSequence,
            limit: cursor.limit,
          }),
          aggregateType: cursor.aggregateType ?? "work-thread",
        }),
      projection: workThreadProjection,
    }),
    "Work thread",
  );
  const workTurnProjection = new WorkTurnProjection();
  requireJournalHydration(
    hydrateWorkTurnProjectionFromJournal({
      replay: (cursor) =>
        persistence.journal.replayAggregateType({
          ...Schema.decodeUnknownSync(ReplayCursor)({
            afterSequence: cursor.afterSequence,
            limit: cursor.limit,
          }),
          aggregateType: cursor.aggregateType ?? "work-turn",
        }),
      projection: workTurnProjection,
    }),
    "Work turn",
  );
  workTurnProjection.markInterruptedOnRestart(new Date().toISOString());
  const workArtifactProjection = new WorkArtifactProjection();
  requireJournalHydration(
    hydrateWorkArtifactProjectionFromJournal({
      replay: (cursor) =>
        persistence.journal.replayAggregateType({
          ...Schema.decodeUnknownSync(ReplayCursor)({
            afterSequence: cursor.afterSequence,
            limit: cursor.limit,
          }),
          aggregateType: cursor.aggregateType ?? "work-artifact",
        }),
      projection: workArtifactProjection,
    }),
    "Work artifact",
  );

  const providerRuntimeRegistry =
    options.providerRuntimeRegistry ??
    new ProviderRuntimeRegistry({
      receiptDirectory: join(persistence.dataDirectory, "providers", "runtime-receipts"),
      observeAcquireMs: (durationMs, kind) =>
        latencyStats.record(
          kind === "started" ? "provider-runtime-acquire" : "provider-runtime-reuse",
          durationMs,
        ),
    });

  // The guard eases the host before the system has to kill it: it stops only
  // what is idle and never a running turn. `start` and `stop` belong to the
  // server's startup and shutdown, so a host that never binds writes nothing.
  const hostMemoryGuard = new HostMemoryGuard({
    stateFile: join(persistence.dataDirectory, "host-memory.json"),
    readSystem: () => readSystemMemory(),
    readProcessRssBytes: () => process.memoryUsage.rss(),
    readLimits: () => readHostMemoryLimits(persistence.connection),
    relief: {
      releaseIdle: () => providerRuntimeRegistry.releaseIdle(),
      trimCaches: () => {
        persistence.connection.exec("PRAGMA shrink_memory");
        // Bun frees its heap garbage on demand; Node has no such call.
        const bun = (globalThis as { readonly Bun?: { readonly gc?: (force: boolean) => void } })
          .Bun;
        bun?.gc?.(true);
        return true;
      },
      activeTurns: () => providerRuntimeRegistry.activeSessionTotal(),
    },
  });

  const browserAuthority = new ServerBrowserAuthorityResolver({
    hostId: deriveToolHostId(persistence.dataDirectory),
    workspaceHostId: LOCAL_HOST_ID,
    persistence,
    workThreads: workThreadProjection,
  });

  const codeEvidence = new CodeEvidenceStore({ connection: persistence.connection });
  const codeBoardEventStore = new CodeOperationEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  // The catalog, not the runtime observation, carries a model's data tags,
  // so an `eu-zdr` policy is judged against it.
  const isProjectPolicyTargetAllowed = (
    project: Exclude<
      ReturnType<typeof persistence.readProject>,
      undefined | { readonly type: "chat" }
    >,
    providerInstanceId: ProviderInstance["id"],
    modelId: ProviderModel["id"],
  ): boolean => {
    const provider = persistence.readProviderInstance(providerInstanceId);
    if (provider === undefined) return false;
    const model = persistence
      .readProviderCatalog?.(providerInstanceId)
      ?.models.find((candidate) => String(candidate.id) === String(modelId));
    return isProviderAllowedByProjectPolicy(project, provider, model);
  };
  // A child's parent context and a provider switch's handoff read a Code
  // thread through one selector, so both carry the same bounds, attribution,
  // taint and omissions.
  const selectCodeConversation = (
    threadId: CodeThreadId,
    selection: Pick<
      AdmittedParentCodeContextInput,
      "purpose" | "excludeOperationId" | "throughOperationId" | "afterOperationId" | "inherited"
    > = {},
  ) =>
    admittedParentCodeContext({
      threadId,
      externalContentIngested: readThreadExternalContentTaint(
        persistence.connection,
        String(threadId),
      ).externalContentIngested,
      readThread: (id) => persistence.readCodeThread(id),
      readActivity: (id) =>
        persistence
          .readCodeThreadActivity()
          .find((activity) => String(activity.threadId) === String(id)),
      conversation: (input) => codeBoardEventStore.conversation(input),
      readEvidence: (reference) => codeEvidence.read(reference),
      // A provider switch's handoff is read by the model it switches to, so
      // its bound comes from that model's context window when the probe
      // reported it. Other purposes keep the fixed bound.
      ...(selection.purpose === "provider-switch"
        ? (() => {
            const thread = persistence.readCodeThread(threadId);
            if (thread === undefined) return {};
            const contextLimit = providerRuntimeRegistry
              .observedState(thread.providerInstanceId)
              ?.models.find(
                (candidate) => String(candidate.id) === String(thread.modelId),
              )?.contextLimit;
            return contextLimit === undefined ? {} : { targetContextLimitTokens: contextLimit };
          })()
        : {}),
      ...selection,
    });

  return {
    browserAuthority,
    codeBoardEventStore,
    codeEvidence,
    hostMemoryGuard,
    isProjectPolicyTargetAllowed,
    providerRuntimeRegistry,
    selectCodeConversation,
    workArtifactProjection,
    workThreadProjection,
    workTurnProjection,
  };
}

export type FoundationsWiring = ReturnType<typeof wireFoundations>;
