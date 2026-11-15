import { describe, expect, it } from "vitest";
import { Effect, Exit, Scope, Stream } from "effect";
import {
  decodeProviderModelId,
  decodeProviderSessionId,
  decodeWorkThread,
  type Project,
  type WorkThread,
} from "@octant/contracts";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import { OutlivingSessions } from "../providers/outlivingSessions";
import { stopKeptSessionsOfChangedWorkThreads } from "./workKeptSessions";
import { workSessionKey, workSessionTerms } from "./workTurnRuntime";

const sessionId = decodeProviderSessionId("97000000-0000-4000-8000-000000000001");
const now = "2026-11-15T12:00:00.000Z";
const projectId = "97000000-0000-4000-8000-000000000003";
const bindingRevisionId = "97000000-0000-4000-8000-000000000005";
const idle: WorkThread = decodeWorkThread({
  id: "97000000-0000-4000-8000-000000000002",
  projectId,
  title: "Preview the site",
  lifecycle: "active",
  providerInstanceId: "97000000-0000-4000-8000-000000000004",
  modelId: "model-a",
  bindingRevisionId,
  workingDirectory: ".",
  access: "full-access",
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const key = workSessionKey(idle.id);
const actor = { kind: "local-user", actorId: "97000000-0000-4000-8000-000000000006" };

function workProject(overrides: Record<string, unknown> = {}): Project {
  return {
    id: projectId,
    type: "work",
    name: "Site",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: "/private/tmp/site" },
    bindingHistory: [
      {
        revisionId: bindingRevisionId,
        revision: 1,
        currentBinding: { canonicalRoot: "/private/tmp/site" },
        actor,
        changedAt: now,
      },
    ],
    extraFolders: [{ canonicalRoot: "/private/tmp/assets", addedBy: actor, addedAt: now }],
    ...overrides,
  } as never;
}

/**
 * Keeps one session with a running background task for the idle thread. The
 * keeper's own read of the thread answers what the Work projection held
 * before the change: the journal tells its listeners of an append before the
 * Work thread service applies it to that projection.
 */
async function keptSession() {
  const stopped: Array<string> = [];
  const work = {
    tasks: [{ taskId: "dev", description: "npm run dev" }],
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
  const stale = workSessionTerms(idle, workProject());
  expect(stale).toBeDefined();
  const keeper = new OutlivingSessions({
    idleLimitMs: () => null,
    startRuntimeTurn: async () => ({ status: "busy" }),
    currentTerms: () => stale,
  });
  const scope = Effect.runSync(Scope.make());
  const held = await Effect.runPromise(
    Scope.extend(keeper.acquire(key, "same-folder", Effect.succeed(connection), stale), scope),
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

/** The reads the listener makes: the Project as committed, the thread as projected. */
const reads = (keeper: OutlivingSessions, project: Project = workProject()) => ({
  keeper,
  readThread: () => idle,
  readProject: () => project,
});

const updated = (thread: Partial<WorkThread>) => ({
  events: [
    {
      aggregateType: "work-thread",
      aggregateId: String(idle.id),
      eventName: "work.thread-updated@1",
      payload: { kind: "thread-updated", thread: { ...idle, ...thread, version: 2 } },
    },
  ],
});

const projectChanged = (eventName: string) => ({
  events: [{ aggregateType: "project", aggregateId: projectId, eventName, payload: {} }],
});

describe("a kept Work session when its thread changes", () => {
  it.each([
    ["the person lowers its level", { access: "ask-first" }],
    ["its provider changes", { providerInstanceId: "97000000-0000-4000-8000-000000000009" }],
    ["its folder changes", { workingDirectory: "site" }],
    ["it is archived", { lifecycle: "archived" }],
  ] as const)(
    "stops on an idle thread when %s, read from the committed change",
    async (_name, change) => {
      const { keeper, stopped } = await keptSession();
      await stopKeptSessionsOfChangedWorkThreads(
        updated(change as Partial<WorkThread>),
        reads(keeper),
      );
      expect(stopped).toEqual([String(sessionId)]);
      expect(keeper.liveTasks(key)).toBeUndefined();
    },
  );

  it("stops on an idle thread the person marks Done", async () => {
    const { keeper, stopped } = await keptSession();
    await stopKeptSessionsOfChangedWorkThreads(
      {
        events: [
          {
            aggregateType: "work-thread",
            aggregateId: String(idle.id),
            eventName: "work.thread-completion-confirmed@1",
            payload: {
              kind: "thread-completion-confirmed",
              thread: { ...idle, completionConfirmed: true, version: 2 },
            },
          },
        ],
      },
      reads(keeper),
    );
    expect(stopped).toEqual([String(sessionId)]);
  });

  it("stops when the thread is purged, and keeps the session through a rename", async () => {
    const renamed = await keptSession();
    await stopKeptSessionsOfChangedWorkThreads(
      updated({ title: "Renamed" }),
      reads(renamed.keeper),
    );
    expect(renamed.stopped).toEqual([]);
    expect(renamed.keeper.liveTasks(key)?.tasks).toHaveLength(1);

    const purged = await keptSession();
    await stopKeptSessionsOfChangedWorkThreads(
      {
        events: [
          {
            aggregateType: "thread-retention",
            aggregateId: "retention",
            eventName: "thread-retention.thread-purged@1",
            payload: { mode: "work", threadId: String(idle.id) },
          },
        ],
      },
      reads(purged.keeper),
    );
    expect(purged.stopped).toEqual([String(sessionId)]);
  });
});

describe("a kept Work session when its Project's folders change", () => {
  it.each([
    [
      "an extra folder is removed",
      "project.extra-folder-removed@1",
      workProject({ extraFolders: [], version: 2 }),
    ],
    [
      "the Project is relinked to another folder",
      "project.binding-relinked@1",
      workProject({
        binding: { canonicalRoot: "/private/tmp/elsewhere" },
        bindingHistory: [
          ...(workProject() as { readonly bindingHistory: ReadonlyArray<unknown> }).bindingHistory,
          {
            revisionId: "97000000-0000-4000-8000-000000000007",
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
      workProject({ lifecycle: "archived", version: 2 }),
    ],
  ] as const)("stops on an idle thread when %s", async (_name, eventName, committed) => {
    const { keeper, stopped } = await keptSession();
    await stopKeptSessionsOfChangedWorkThreads(projectChanged(eventName), reads(keeper, committed));
    expect(stopped).toEqual([String(sessionId)]);
    expect(keeper.liveTasks(key)).toBeUndefined();
  });

  it("keeps the session through a Project change that leaves its folders as they were", async () => {
    const { keeper, stopped } = await keptSession();
    await stopKeptSessionsOfChangedWorkThreads(
      projectChanged("project.renamed@1"),
      reads(keeper, workProject({ name: "Site, renamed", version: 2 })),
    );
    expect(stopped).toEqual([]);
  });

  it("leaves a session in another Project alone", async () => {
    const { keeper, stopped } = await keptSession();
    await stopKeptSessionsOfChangedWorkThreads(
      {
        events: [
          {
            aggregateType: "project",
            aggregateId: "97000000-0000-4000-8000-000000000099",
            eventName: "project.lifecycle-changed@1",
            payload: {},
          },
        ],
      },
      reads(keeper, workProject({ lifecycle: "archived" })),
    );
    expect(stopped).toEqual([]);
  });
});
