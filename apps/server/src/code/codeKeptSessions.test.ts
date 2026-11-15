import { describe, expect, it } from "vitest";
import { Effect, Exit, Scope, Stream } from "effect";
import {
  decodeCodeThread,
  decodeProviderModelId,
  decodeProviderSessionId,
  type CodeThread,
  type Project,
} from "@octant/contracts";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import { OutlivingSessions } from "../providers/outlivingSessions";
import { stopKeptSessionsOfChangedCodeThreads } from "./codeKeptSessions";
import { codeSessionKey, codeSessionTerms } from "./codeOperationRuntime";

const sessionId = decodeProviderSessionId("98000000-0000-4000-8000-000000000001");
const now = "2026-11-15T12:00:00.000Z";
const projectId = "98000000-0000-4000-8000-000000000003";
const bindingRevisionId = "98000000-0000-4000-8000-000000000005";
const actor = { kind: "local-user", actorId: "98000000-0000-4000-8000-000000000006" };
const idle: CodeThread = decodeCodeThread({
  id: "98000000-0000-4000-8000-000000000002",
  projectId,
  bindingRevisionId,
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: "98000000-0000-4000-8000-000000000008",
  title: "Run the dev server",
  lifecycle: "active",
  providerInstanceId: "98000000-0000-4000-8000-000000000004",
  modelId: "model-a",
  executionPolicy: "full-access",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/dev",
    remoteName: "origin",
    proposedBaseRepository: "owner/repository",
    proposedBaseBranch: "main",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const key = codeSessionKey(idle.id);

function codeProject(overrides: Record<string, unknown> = {}): Project {
  return {
    id: projectId,
    type: "code",
    name: "App",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: "/private/tmp/app" },
    bindingHistory: [
      {
        revisionId: bindingRevisionId,
        revision: 1,
        currentBinding: { canonicalRoot: "/private/tmp/app" },
        actor,
        changedAt: now,
      },
    ],
    extraFolders: [{ canonicalRoot: "/private/tmp/shared", addedBy: actor, addedAt: now }],
    ...overrides,
  } as never;
}

/** Keeps one session with a running background task for the idle Code thread. */
async function keptSession() {
  const stopped: Array<string> = [];
  const work = {
    tasks: [{ taskId: "dev", description: "bun run dev" }],
    turnRunning: false,
    runtimeTurnWaiting: false,
    ended: false,
  };
  const connection: ProviderConnection = {
    subscribe: Effect.succeed(Stream.empty),
    start: (input) => Effect.succeed({ sessionId: input.sessionId }),
    resume: (input) => Effect.succeed({ sessionId: input.sessionId }),
    send: () => Effect.void,
    interrupt: () => Effect.void,
    stop: (id) => Effect.sync(() => void stopped.push(String(id))),
    answerApproval: () => Effect.void,
    answerUserInput: () => Effect.void,
    answerTool: () => Effect.void,
    backgroundWork: () => ({ current: () => work, watch: () => () => undefined }),
  };
  const terms = codeSessionTerms(idle, codeProject());
  expect(terms).toBeDefined();
  const keeper = new OutlivingSessions({
    idleLimitMs: () => null,
    startRuntimeTurn: async () => ({ status: "busy" }),
  });
  const scope = Effect.runSync(Scope.make());
  const held = await Effect.runPromise(
    Scope.extend(keeper.acquire(key, "same-folder", Effect.succeed(connection), terms), scope),
  );
  await Effect.runPromise(
    held.start({
      sessionId,
      modelId: decodeProviderModelId("model-a"),
      executionPolicy: "full-access",
      tools: [],
    }),
  );
  await Effect.runPromise(held.stop(sessionId));
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(keeper.liveTasks(key)?.tasks).toHaveLength(1);
  return { keeper, stopped };
}

/** The listener's reads: Code threads and Projects are both applied inside the append. */
const reads = (
  keeper: OutlivingSessions,
  project: Project = codeProject(),
  thread: CodeThread = idle,
) => ({ keeper, readThread: () => thread, readProject: () => project });

const projectChanged = (eventName: string, aggregateId = projectId) => ({
  events: [{ aggregateType: "project", aggregateId, eventName, payload: {} }],
});

describe("a kept Code session when its Project's folders change", () => {
  it.each([
    [
      "an extra folder is removed",
      "project.extra-folder-removed@1",
      codeProject({ extraFolders: [], version: 2 }),
    ],
    [
      "the Project is relinked to another folder",
      "project.binding-relinked@1",
      codeProject({
        binding: { canonicalRoot: "/private/tmp/elsewhere" },
        bindingHistory: [
          ...(codeProject() as { readonly bindingHistory: ReadonlyArray<unknown> }).bindingHistory,
          {
            revisionId: "98000000-0000-4000-8000-000000000007",
            revision: 2,
            currentBinding: { canonicalRoot: "/private/tmp/elsewhere" },
            actor,
            changedAt: now,
          },
        ],
        version: 2,
      }),
    ],
    [
      "the Project is archived",
      "project.lifecycle-changed@1",
      codeProject({ lifecycle: "archived", version: 2 }),
    ],
  ] as const)("stops on an idle thread when %s", async (_name, eventName, committed) => {
    const { keeper, stopped } = await keptSession();
    await stopKeptSessionsOfChangedCodeThreads(projectChanged(eventName), reads(keeper, committed));
    expect(stopped).toEqual([String(sessionId)]);
    expect(keeper.liveTasks(key)).toBeUndefined();
  });

  it("keeps the session through a Project change that leaves its folders as they were, and one to another Project", async () => {
    const renamed = await keptSession();
    await stopKeptSessionsOfChangedCodeThreads(
      projectChanged("project.renamed@1"),
      reads(renamed.keeper, codeProject({ name: "App, renamed", version: 2 })),
    );
    expect(renamed.stopped).toEqual([]);

    const elsewhere = await keptSession();
    await stopKeptSessionsOfChangedCodeThreads(
      projectChanged("project.lifecycle-changed@1", "98000000-0000-4000-8000-000000000099"),
      reads(elsewhere.keeper, codeProject({ lifecycle: "archived" })),
    );
    expect(elsewhere.stopped).toEqual([]);
  });

  it("still stops on an idle thread whose own level the person lowered", async () => {
    const { keeper, stopped } = await keptSession();
    await stopKeptSessionsOfChangedCodeThreads(
      {
        events: [
          {
            aggregateType: "code-thread",
            aggregateId: String(idle.id),
            eventName: "code.thread-updated@1",
            payload: {},
          },
        ],
      },
      reads(keeper, codeProject(), {
        ...idle,
        executionPolicy: "approval-gated",
        version: 2,
      } as never),
    );
    expect(stopped).toEqual([String(sessionId)]);
  });
});
