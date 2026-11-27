import {
  decodeCodeThread,
  decodeEventActor,
  decodeProject,
  decodeWindowId,
} from "@octant/contracts";
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
const bindingRevisionId = "70000000-0000-4000-8000-000000000001";
const now = "2026-11-10T12:00:00.000Z";

export async function assembleCase(fixture: EvaluationCase, orchestration: string) {
  const threads = [
    { id: coordinatorId, title: "Coordinator", coordinator: true },
    ...fixture.workers.map(({ id, title }) => ({ id, title, coordinatorThreadId: coordinatorId })),
  ].map((thread) =>
    decodeCodeThread({
      projectId: fixtureProjectId,
      bindingRevisionId,
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
  const actor = decodeEventActor({ kind: "local-user", actorId: coordinatorId });
  const binding = { canonicalRoot: "/fixture" };
  const project =
    fixture.projectConversation === true
      ? decodeProject({
          id: fixtureProjectId,
          name: "Fixture",
          type: "code",
          lifecycle: "active",
          pinned: false,
          rank: "0/1",
          version: 1,
          createdAt: now,
          updatedAt: now,
          binding,
          bindingHistory: [
            {
              revisionId: bindingRevisionId,
              revision: 1,
              currentBinding: binding,
              actor,
              changedAt: now,
            },
          ],
          codeAccessPersistence: "current-session",
        })
      : undefined;
  let projectConversationChecked = false;
  // A spread lets old port types accept the fixture without changing that checkout's service.
  const conversationIdentity = {
    isProjectConversation: (thread: (typeof threads)[number]) => {
      const matches =
        project !== undefined &&
        thread.projectId === project.id &&
        String(thread.id) === coordinatorId;
      if (matches) projectConversationChecked = true;
      return matches;
    },
  };
  const coordinator = new CoordinatorService({
    ...conversationIdentity,
    readThread: (id) => threads.find((thread) => String(thread.id) === id),
    readThreads: () => threads,
    readProject: (id) => (id === project?.id ? project : undefined),
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
  if (fixture.projectConversation === true && !projectConversationChecked) {
    return {
      status: "unsupported",
      reason: "This revision does not supply Project conversation context.",
    } as const;
  }
  const { definitions, execute } = createThreadsTools({
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
          actor,
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
  const tool = definitions[0]?.name;
  if (tool === undefined) throw new Error("Coordinator fixture lost its threads tool.");
  const help = await execute({ name: tool, inputJson: '{"operation":"help"}' });
  return {
    help: help.result,
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
        await Promise.all(
          Object.entries(cases).map(async ([name, fixture]) => [
            name,
            await assembleCase(fixture, orchestration),
          ]),
        ),
      ),
    ),
  );
}
