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
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
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
 * alone: the Work projections, the provider runtime registry, the browser
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
      ...selection,
    });

  return {
    browserAuthority,
    codeBoardEventStore,
    codeEvidence,
    isProjectPolicyTargetAllowed,
    providerRuntimeRegistry,
    selectCodeConversation,
    workThreadProjection,
    workTurnProjection,
  };
}

export type FoundationsWiring = ReturnType<typeof wireFoundations>;
