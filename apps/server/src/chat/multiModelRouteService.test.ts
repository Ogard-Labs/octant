import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeChatThreadId,
  decodeChatTurnId,
  type AggregateVersion,
  type ChatThread,
} from "@octant/contracts";
import type { HostId } from "@octant/contracts/host";
import type {
  MultiModelPoolCandidate,
  MultiModelRoutingVendorId,
} from "@octant/contracts/multi-model-pool";
import type { MultiModelCandidateRuntimeFacts } from "@octant/domain/multi-model-pool-policy";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { PersistenceService } from "../persistence/persistenceService";
import { MultiModelRouteService, type ResolveTurnRouteInput } from "./multiModelRouteService";

const directories: Array<string> = [];
const now = "2026-08-10T12:00:00.000Z";
const ids = {
  actor: "85000000-0000-4000-8000-000000000001",
  correlation: "85000000-0000-4000-8000-000000000002",
  providerA: "85000000-0000-4000-8000-000000000003",
  providerB: "85000000-0000-4000-8000-000000000004",
  thread: "85000000-0000-4000-8000-000000000010",
  turn: "85000000-0000-4000-8000-000000000020",
  turnOther: "85000000-0000-4000-8000-000000000021",
} as const;
const localHost = "85000000-0000-4000-8000-000000000099" as HostId;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-multi-model-route-service-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function thread(): ChatThread {
  return {
    id: decodeChatThreadId(ids.thread),
    title: "Pooled thread",
    lifecycle: "active",
    providerInstanceId: ids.providerA,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be calm.",
    version: 1 as AggregateVersion,
    createdAt: now,
    updatedAt: now,
  } as ChatThread;
}

function fixture(): {
  readonly persistence: PersistenceService;
  readonly service: MultiModelRouteService;
} {
  const connection = openConnection();
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  journal.append({
    aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
    expectedVersion: 0,
    events: [
      {
        eventId: crypto.randomUUID(),
        eventName: "chat.thread-created@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { kind: "thread-created", thread: thread() },
      },
    ],
  });
  const persistence = { connection, journal } as unknown as PersistenceService;
  let uuidCounter = 0;
  const service = new MultiModelRouteService({
    persistence,
    uuid: () => `85100000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`,
    clock: () => now,
  });
  return { persistence, service };
}

function candidate(providerInstanceId: string, modelId: string): MultiModelPoolCandidate {
  return { hostId: localHost, providerInstanceId, modelId } as MultiModelPoolCandidate;
}

function facts(
  target: MultiModelPoolCandidate,
  override: Partial<MultiModelCandidateRuntimeFacts> = {},
): MultiModelCandidateRuntimeFacts {
  return {
    candidate: target,
    routingVendorId: "openai" as MultiModelRoutingVendorId,
    configured: true,
    readiness: "ready",
    modelAvailable: true,
    compatibleModes: ["chat"],
    projectAllowed: true,
    profileAllowed: true,
    supportedCapabilities: [],
    authorityAllowed: true,
    ...override,
  };
}

function baseInput(
  turnId: string,
  override: Partial<ResolveTurnRouteInput> = {},
): ResolveTurnRouteInput {
  const candidateA = candidate(ids.providerA, "model-a");
  const candidateB = candidate(ids.providerB, "model-b");
  return {
    threadId: decodeChatThreadId(ids.thread),
    turnId: decodeChatTurnId(turnId),
    request: {
      pool: {
        candidates: [candidateA, candidateB],
        mixedVendorEnabled: true,
        fallbackAllowed: true,
        higherCostFallbackAllowed: false,
      },
      requestedCandidate: candidateA,
      requiredCapabilities: [],
    },
    activeHostId: localHost,
    mode: "chat",
    parentRoutingVendorId: "openai" as MultiModelRoutingVendorId,
    parentCandidate: candidateA,
    runtimeFacts: [facts(candidateA), facts(candidateB)],
    ...override,
  };
}

describe("MultiModelRouteService", () => {
  it("resolves and durably persists exactly one selected route before execution", async () => {
    const { persistence, service } = fixture();
    const decision = await service.resolveTurnRoute(baseInput(ids.turn));

    expect(decision.decision.kind).toBe("selected");
    expect(String(decision.turnId)).toBe(ids.turn);
    const persisted = service.readDecision(decision.turnId);
    expect(persisted).toEqual(decision);
    const row = persistence.connection
      .prepare("SELECT thread_id FROM chat_turn_route_projection WHERE turn_id = ?")
      .get(ids.turn) as { readonly thread_id: string } | undefined;
    expect(row?.thread_id).toBe(ids.thread);
  });

  it("records a durable actionable Waiting decision when no candidate is eligible, without a selected route", async () => {
    const { service } = fixture();
    const decision = await service.resolveTurnRoute(
      baseInput(ids.turn, {
        runtimeFacts: [
          facts(candidate(ids.providerA, "model-a"), { readiness: "unavailable" }),
          facts(candidate(ids.providerB, "model-b"), { readiness: "unavailable" }),
        ],
      }),
    );

    expect(decision.decision.kind).toBe("waiting");
    if (decision.decision.kind === "waiting") {
      expect(decision.decision.reason).toBe("no-eligible-candidate");
      expect(decision.decision.message.length).toBeGreaterThan(0);
    }
  });

  it("selects only an explicitly permitted fallback when the requested candidate is unavailable", async () => {
    const { service } = fixture();
    const decision = await service.resolveTurnRoute(
      baseInput(ids.turn, {
        runtimeFacts: [
          facts(candidate(ids.providerA, "model-a"), { readiness: "unavailable", costRank: 1 }),
          facts(candidate(ids.providerB, "model-b"), { costRank: 1 }),
        ],
      }),
    );

    expect(decision.decision.kind).toBe("selected");
    if (decision.decision.kind === "selected") {
      expect(decision.decision.selectionKind).toBe("fallback");
      expect(decision.decision.selectedCandidate.providerInstanceId).toBe(ids.providerB);
    }
  });

  it("never re-derives or overwrites an already-accepted route on retry (idempotent by turnId)", async () => {
    const { service } = fixture();
    const first = await service.resolveTurnRoute(baseInput(ids.turn));
    expect(first.decision.kind).toBe("selected");

    // A retry passes materially different runtime facts (as if the
    // previously-selected candidate went unavailable in the meantime). The
    // already-accepted decision for this turnId must be returned unchanged.
    const second = await service.resolveTurnRoute(
      baseInput(ids.turn, {
        runtimeFacts: [
          facts(candidate(ids.providerA, "model-a"), { readiness: "unavailable" }),
          facts(candidate(ids.providerB, "model-b"), { readiness: "unavailable" }),
        ],
      }),
    );

    expect(second).toEqual(first);
  });

  it("keeps decisions for different turns independent", async () => {
    const { service } = fixture();
    const first = await service.resolveTurnRoute(baseInput(ids.turn));
    const second = await service.resolveTurnRoute(
      baseInput(ids.turnOther, {
        runtimeFacts: [
          facts(candidate(ids.providerA, "model-a"), { readiness: "unavailable" }),
          facts(candidate(ids.providerB, "model-b")),
        ],
      }),
    );

    expect(String(first.turnId)).toBe(ids.turn);
    expect(String(second.turnId)).toBe(ids.turnOther);
    expect(second).not.toEqual(first);
  });
});
