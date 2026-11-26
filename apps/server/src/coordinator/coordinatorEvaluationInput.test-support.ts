import { decodeCodeThread, decodeEventActor, decodeWindowId } from "@octant/contracts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OctantInstructionsStore,
  registerOctantInstructionsEvents,
} from "../octantInstructions/octantInstructionsStore";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { createThreadsTools } from "../siblingThreads/siblingThreadTools";
import { fixtureProjectId, type EvaluationCase } from "./coordinatorEvaluation";
import { CoordinatorService } from "./coordinatorService";

const coordinatorId = "20000000-0000-4000-8000-000000000001";
const now = "2026-11-10T12:00:00.000Z";

export function assembleCase(fixture: EvaluationCase, orchestration: string) {
  const threads = [
    { id: coordinatorId, title: "Coordinator", coordinator: true },
    ...fixture.workers.map(({ id, title }) => ({ id, title, coordinatorThreadId: coordinatorId })),
  ].map((thread) =>
    decodeCodeThread({
      projectId: fixtureProjectId,
      bindingRevisionId: "70000000-0000-4000-8000-000000000001",
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId: "30000000-0000-4000-8000-000000000001",
      providerInstanceId: "60000000-0000-4000-8000-000000000001",
      lifecycle: "active",
      modelId: "fixture",
      executionPolicy: "auto-accept-edits",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "feature/fixture",
        remoteName: "origin",
        proposedBaseRepository: "example/fixture",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...thread,
    }),
  );
  const unavailable = (): never => {
    throw new Error("Evaluation fixtures have no side effects.");
  };
  const coordinator = new CoordinatorService({
    readThread: (id) => threads.find((thread) => String(thread.id) === id),
    readThreads: () => threads,
    readProject: () => undefined,
    readSettings: () => undefined,
    isDesignatedPlanner: () => false,
    isMarked: () => false,
    threadState: (id) => fixture.workers.find((worker) => worker.id === id)?.state,
    latestTurnId: () => undefined,
    providerKnown: () => false,
    executeCode: unavailable,
    startHostTurn: unavailable,
    propose: unavailable,
    counts: {
      recordStart: unavailable,
      startsSince: unavailable,
      recordWake: unavailable,
      wakesSince: unavailable,
      recordHostTurn: unavailable,
      hostTurn: unavailable,
    },
    uuid: unavailable,
    now: () => Date.parse(now),
  });
  const roster = coordinator.contextFor(coordinatorId);
  const level = coordinator.levelOf(coordinatorId);
  if (roster === undefined || level === undefined)
    throw new Error("Coordinator fixture lost its roster or level.");
  const { definitions } = createThreadsTools({
    mode: "code",
    windowId: decodeWindowId("10000000-0000-4000-8000-000000000001"),
    service: { answer: unavailable },
    source: { thread: unavailable, projectThreads: unavailable, readTranscript: unavailable },
    callerThreadId: coordinatorId,
    toolConstraints: [],
    profileDisplayName: "Fixture",
    readPosture: () => "plan",
    messaging: {
      send: unavailable,
      recordRefusedSend: unavailable,
      acknowledge: unavailable,
      statusForSender: unavailable,
    },
    coordinator: { levelOf: (id) => coordinator.levelOf(id), start: unavailable },
  });
  const directory = mkdtempSync(join(tmpdir(), "octant-coordinator-eval-"));
  let instructions;
  try {
    const connection = openSqlite(join(directory, "fixture.sqlite"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const journal = new Journal({
        connection,
        registry: registerOctantInstructionsEvents(new EventRegistry()),
        projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
        clock: () => now,
      });
      const store = new OctantInstructionsStore({ journal, clock: () => now, uuid: randomUUID });
      const result = store.change(
        { kind: "change-orchestration-instructions", expectedVersion: 0, orchestration },
        {
          actor: decodeEventActor({ kind: "local-user", actorId: coordinatorId }),
          actsAsHostPerson: true,
        },
      );
      if (result.kind !== "octant-instructions")
        throw new Error("Fixture orchestration instructions were refused.");
      instructions = store.contextBlocks({
        projectId: fixtureProjectId,
        orchestrates: coordinator.isCoordinator(coordinatorId),
      });
    } finally {
      connection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    messages: [
      ...instructions.map(({ text }) => ({ role: "system", content: text })),
      { role: "user", content: roster },
      { role: "user", content: fixture.prompt },
    ],
    tools: definitions.map(({ name, description, inputSchema }) => ({
      type: "function",
      function: { name, description, parameters: inputSchema },
    })),
  };
}

if (import.meta.main) {
  const { cases } = await import("./coordinatorEvaluation");
  const orchestration = process.argv[2] ?? "";
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(cases).map(([name, fixture]) => [
          name,
          assembleCase(fixture, orchestration),
        ]),
      ),
    ),
  );
}
