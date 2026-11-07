import { randomUUID } from "node:crypto";
import {
  LOCAL_HOST_ID,
  decodeChatThreadId,
  decodeUtcTimestamp,
  type ChatThreadId,
  type WindowId,
} from "@octant/contracts";
import { BenchmarkEventStore } from "../benchmarks/benchmarkEventStore";
import {
  BENCHMARKS_PROJECT_ID,
  BENCHMARKS_PROJECT_NAME,
  createBenchmarkChatPort,
} from "../benchmarks/benchmarkChatPort";
import { createBenchmarkRouteHandler } from "../benchmarks/benchmarkRoutes";
import { BenchmarkRunner } from "../benchmarks/benchmarkRunner";
import { BenchmarkService } from "../benchmarks/benchmarkService";
import { extractReply } from "../chat/threadDialogueService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { ChatWiring } from "./chat";
import type { WorkspaceWiring } from "./workspace";

/**
 * Purges one cell thread through the thread retention service. That service is
 * built after the routes that need it, so the wiring hands the routes a slot
 * the host fills once it exists; a purge asked before then fails, and the run
 * is kept.
 */
export interface BenchmarkThreadPurgeSlot {
  purge?: (threadId: string) => Promise<"purged" | "absent" | "failed">;
}

export type BenchmarksDependencies = Pick<ServerStart, "persistence"> &
  Pick<AuthorityWiring, "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "turnMetrics"> &
  Pick<WorkspaceWiring, "projectService"> &
  Pick<ChatWiring, "chatService"> & {
    readonly threadPurge: BenchmarkThreadPurgeSlot;
    readonly allowedRendererHttpOrigin?: string | null;
  };

export function wireBenchmarks(deps: BenchmarksDependencies) {
  const {
    chatService,
    persistence,
    projectService,
    threadPurge,
    turnMetrics,
    windowAuthorityStore,
  } = deps;
  const clock = () => new Date().toISOString();
  const store = new BenchmarkEventStore({
    journal: persistence.journal,
    connection: persistence.connection,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock,
  });
  const projection = persistence.benchmarkProjection;
  const chat = createBenchmarkChatPort({
    chat: {
      read: (threadId: ChatThreadId) => chatService.read(threadId),
      execute: async (command) => chatService.execute(command),
    },
    answer: (threadId, turnId) =>
      extractReply(chatService.read(decodeChatThreadId(threadId)), turnId),
  });
  const benchmarkRunner = new BenchmarkRunner({
    chat,
    projection,
    store,
    turnMetrics,
    projectId: BENCHMARKS_PROJECT_ID,
    clock,
  });
  const service = new BenchmarkService({
    projection,
    store,
    turnMetrics,
    runner: benchmarkRunner,
    contenderAvailable: (providerInstanceId, modelId) => {
      const instance = persistence.readProviderInstance(providerInstanceId as never);
      if (instance === undefined || !instance.enabled) return false;
      const catalog = persistence.readProviderCatalog?.(providerInstanceId as never);
      if (catalog === undefined) return true;
      const models = (catalog as { readonly models?: ReadonlyArray<{ readonly id: string }> })
        .models;
      return models?.some((model) => model.id === modelId) ?? true;
    },
    ensureProject: async (windowId: WindowId) => {
      const existing = persistence.readProject(BENCHMARKS_PROJECT_ID);
      if (existing !== undefined) {
        return existing.type === "chat" && existing.lifecycle === "active"
          ? { status: "ready" }
          : { status: "refused", message: "The Benchmarks Project is archived or unavailable." };
      }
      try {
        await projectService.executeProject(windowId, {
          kind: "create-chat-project",
          projectId: BENCHMARKS_PROJECT_ID,
          expectedVersion: 0,
          name: BENCHMARKS_PROJECT_NAME,
          hostId: LOCAL_HOST_ID,
        });
        return { status: "ready" };
      } catch (error) {
        return {
          status: "refused",
          message:
            error instanceof Error ? error.message : "The Benchmarks Project could not be created.",
        };
      }
    },
    purgeThread: async (threadId) => (await threadPurge.purge?.(threadId)) ?? "failed",
    clock: () => decodeUtcTimestamp(clock()),
    uuid: randomUUID,
  });
  const benchmarkRoutes = createBenchmarkRouteHandler({
    windowAuthorityStore,
    ...(deps.allowedRendererHttpOrigin === undefined
      ? {}
      : { allowedRendererHttpOrigin: deps.allowedRendererHttpOrigin }),
    service,
  });
  return { benchmarkRoutes, benchmarkRunner };
}

export type BenchmarksWiring = ReturnType<typeof wireBenchmarks>;
