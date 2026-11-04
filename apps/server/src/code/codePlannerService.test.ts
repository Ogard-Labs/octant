import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeThreadId,
  decodeCodeThread,
  decodeCodePlannerProposalOutcome,
  decodeProjectId,
  type CodePlannerThreadCreation,
  type CodeThread,
  type CodeThreadId,
  type Project,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { PersistenceService } from "../persistence/persistenceService";
import { CodePlannerService, type CodePlannerServiceOptions } from "./codePlannerService";
import { CodeProjection } from "../persistence/codeProjection";
import { rebuildProjection } from "../persistence/projection";
import { createCodeRouteHandler } from "../codeRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createPlannerProposalTask } from "../../../web/src/code/plannerProposalCreation";

const directories: Array<string> = [];
const now = "2026-08-29T12:00:00.000Z";
const ids = {
  project: "10000000-0000-4000-8000-000000000001",
  otherProject: "10000000-0000-4000-8000-000000000002",
  thread: "20000000-0000-4000-8000-000000000001",
  otherThread: "20000000-0000-4000-8000-000000000002",
  provider: "50000000-0000-4000-8000-000000000001",
  window: "60000000-0000-4000-8000-000000000001",
  binding: "70000000-0000-4000-8000-000000000001",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-code-planner-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

interface FixtureOptions {
  readonly projectType?: "chat" | "work" | "code";
  readonly projectLifecycle?: "active" | "archived";
  readonly threadLifecycle?: CodeThread["lifecycle"];
  readonly threadProjectId?: string;
  readonly createThread?: CodePlannerServiceOptions["createThread"];
  readonly canAccessProject?: (windowId: WindowId, projectId: ProjectId) => boolean;
  readonly isMarkedWithOutsideContent?: (threadId: string) => boolean;
}

function fixture(options?: FixtureOptions): {
  service: CodePlannerService;
  created: Array<CodePlannerThreadCreation>;
  contexts: Array<unknown>;
  persistence: PersistenceService;
  createdThreads: Map<string, CodeThread>;
} {
  const connection = openConnection();
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const project = {
    id: decodeProjectId(ids.project),
    type: options?.projectType ?? "code",
    lifecycle: options?.projectLifecycle ?? "active",
  } as unknown as Project;
  const thread = {
    id: decodeCodeThreadId(ids.thread),
    projectId: decodeProjectId(options?.threadProjectId ?? ids.project),
    lifecycle: options?.threadLifecycle ?? "active",
    providerInstanceId: ids.provider,
    title: "Planner thread",
  } as unknown as CodeThread;
  const createdThreads = new Map([[String(thread.id), thread]]);
  const persistence = {
    connection,
    journal,
    readProject: (projectId: ProjectId) =>
      String(projectId) === ids.project ? project : undefined,
    readCodeThread: (threadId: CodeThreadId) => createdThreads.get(String(threadId)),
  } as unknown as PersistenceService;
  const created: Array<CodePlannerThreadCreation> = [];
  const contexts: Array<unknown> = [];
  const service = new CodePlannerService({
    persistence,
    uuid: () => crypto.randomUUID(),
    clock: () => now,
    canAccessProject: options?.canAccessProject ?? (() => true),
    createThread:
      options?.createThread ??
      (async (_windowId, creation, _signal, executionContext) => {
        created.push(creation);
        contexts.push(executionContext);
        const createdThread =
          creation.kind === "create-code-thread"
            ? creation.thread
            : ({
                id: creation.threadId,
                projectId: creation.projectId,
                title: creation.title,
              } as CodeThread);
        createdThreads.set(String(createdThread.id), createdThread);
        return { kind: "thread-created", thread: createdThread };
      }),
    isMarkedWithOutsideContent: options?.isMarkedWithOutsideContent ?? (() => false),
  });
  return { service, created, contexts, persistence, createdThreads };
}

const projectId = decodeProjectId(ids.project);
const threadId = decodeCodeThreadId(ids.thread);
const windowId = ids.window as WindowId;

function designate(service: CodePlannerService) {
  return service.execute(windowId, {
    kind: "designate-code-planner-thread",
    projectId: ids.project,
    threadId: ids.thread,
    expectedVersion: 0,
  });
}

const draft = {
  title: "Stabilize the flaky replay test",
  intent: "Reproduce the replay flake and fix its root cause.",
  rationale: "Two board cards are stuck waiting on it.",
} as const;

function managedCreation(overrides?: { readonly projectId?: string }): Record<string, unknown> {
  return {
    kind: "create-managed-code-thread",
    threadId: ids.otherThread,
    projectId: overrides?.projectId ?? ids.project,
    bindingRevisionId: ids.binding,
    title: draft.title,
    providerInstanceId: ids.provider,
    modelId: "model-1",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "fix/replay-flake",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    sourceBranch: "main",
    startFromOrigin: false,
  };
}

describe("planner designation", () => {
  it("designates one thread of the Project and reads it back durably", async () => {
    const { service } = fixture();
    const outcome = await designate(service);
    expect(outcome.status).toBe("designated");
    const view = service.readView(windowId, ids.project);
    expect(view.designation).toMatchObject({ kind: "designated", plannerThreadId: ids.thread });
    expect(view.designationVersion).toBe(1);
  });

  it("refuses to designate a thread that does not exist", async () => {
    const { service } = fixture();
    const outcome = await service.execute(windowId, {
      kind: "designate-code-planner-thread",
      projectId: ids.project,
      threadId: ids.otherThread,
      expectedVersion: 0,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "thread-not-found" });
  });

  it("refuses to designate a thread that belongs to another Project", async () => {
    const { service } = fixture({ threadProjectId: ids.otherProject });
    const outcome = await designate(service);
    expect(outcome).toMatchObject({ status: "refused", reason: "thread-in-another-project" });
  });

  it("refuses a second planner while one is designated", async () => {
    const { service } = fixture();
    await designate(service);
    const outcome = await service.execute(windowId, {
      kind: "designate-code-planner-thread",
      projectId: ids.project,
      threadId: ids.thread,
      expectedVersion: 1,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "planner-already-designated" });
  });

  it("refuses a stale designation command instead of overwriting a newer one", async () => {
    const { service } = fixture();
    await designate(service);
    const outcome = await service.execute(windowId, {
      kind: "undesignate-code-planner-thread",
      projectId: ids.project,
      expectedVersion: 0,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "designation-changed" });
  });

  it("refuses a planner command from a window that cannot act on the Project", async () => {
    const { service } = fixture({ canAccessProject: () => false });
    await expect(designate(service)).rejects.toMatchObject({
      failure: { category: "unauthorized" },
    });
    expect(() => service.readView(windowId, ids.project)).toThrowError(
      expect.objectContaining({ failure: expect.objectContaining({ category: "unauthorized" }) }),
    );
  });

  it("undesignates the planner and the board access ends with it", async () => {
    const { service } = fixture();
    await designate(service);
    const outcome = await service.execute(windowId, {
      kind: "undesignate-code-planner-thread",
      projectId: ids.project,
      expectedVersion: 1,
    });
    expect(outcome.status).toBe("undesignated");
    expect(service.boardScope(threadId)).toMatchObject({
      status: "refused",
      reason: "no-planner-designated",
    });
  });
});

describe("planner board access", () => {
  it("allows the designated planner thread and scopes it to its own Project", async () => {
    const { service } = fixture();
    await designate(service);
    const scope = service.boardScope(threadId);
    expect(scope).toEqual({ status: "allowed", projectId });
  });

  it("refuses the board to a thread that is not the designated planner", async () => {
    const { service } = fixture();
    await designate(service);
    const scope = service.boardScope(decodeCodeThreadId(ids.otherThread));
    expect(scope).toMatchObject({ status: "refused" });
  });
});

describe("planner work proposals", () => {
  it("retains an unresolved admission across replay and another service instance after an unknown failure", async () => {
    const createThread = vi.fn<CodePlannerServiceOptions["createThread"]>(async () => {
      throw new Error("Unknown creation failure");
    });
    const world = fixture({ createThread });
    await designate(world.service);
    const proposed = world.service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("Expected proposal");
    const command = {
      kind: "confirm-planner-work-proposal",
      proposalId: proposed.proposal.id,
      expectedVersion: 1,
      creation: managedCreation(),
    };
    await expect(world.service.resolveProposal(windowId, command)).rejects.toThrow();
    rebuildProjection({
      connection: world.persistence.connection,
      journal: world.persistence.journal,
      projection: new CodeProjection(),
      clock: () => now,
    });
    const restarted = new CodePlannerService({
      persistence: world.persistence,
      uuid: () => crypto.randomUUID(),
      clock: () => now,
      canAccessProject: () => true,
      createThread,
      isMarkedWithOutsideContent: () => false,
    });
    const current = restarted.readView(windowId, ids.project).proposals[0];
    expect(current).toMatchObject({
      proposalVersion: 2,
      proposal: {
        status: "pending",
        creationAttempt: { status: "creating", threadId: ids.otherThread },
      },
    });
    expect(
      await restarted.resolveProposal(windowId, {
        ...command,
        expectedVersion: current?.proposalVersion,
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await restarted.resolveProposal(windowId, {
        kind: "decline-planner-work-proposal",
        proposalId: proposed.proposal.id,
        expectedVersion: current?.proposalVersion,
      }),
    ).toMatchObject({ status: "refused" });
    expect(createThread).toHaveBeenCalledTimes(1);
  });

  it("permits explicit repair retry only after the host records definitive noncreation at a newer version", async () => {
    let calls = 0;
    const createThread = vi.fn<CodePlannerServiceOptions["createThread"]>(
      async (_window, creation) => {
        calls += 1;
        if (calls === 1)
          return {
            kind: "creation-not-started",
            failure: {
              category: "unavailable",
              message: "Provider validation failed before creation.",
            },
          };
        return {
          kind: "thread-created",
          thread:
            creation.kind === "create-code-thread"
              ? creation.thread
              : ({ id: creation.threadId, projectId: creation.projectId } as CodeThread),
        };
      },
    );
    const { service } = fixture({ createThread });
    await designate(service);
    const proposed = service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("Expected proposal");
    const command = {
      kind: "confirm-planner-work-proposal",
      proposalId: proposed.proposal.id,
      expectedVersion: 1,
      creation: managedCreation(),
    };
    expect(await service.resolveProposal(windowId, command)).toMatchObject({
      status: "refused",
      reason: "creation-not-started",
    });
    const refreshed = service.readView(windowId, ids.project).proposals[0];
    expect(refreshed).toMatchObject({
      proposalVersion: 3,
      proposal: { status: "pending", creationAttempt: { status: "failed" } },
    });
    expect(await service.resolveProposal(windowId, command)).toMatchObject({ status: "refused" });
    expect(calls).toBe(1);
    expect(
      await service.resolveProposal(windowId, {
        ...command,
        expectedVersion: refreshed?.proposalVersion,
      }),
    ).toMatchObject({ status: "confirmed" });
    expect(calls).toBe(2);
  });

  it("keeps final-append failure reserved and links an observed stored task without another creation", async () => {
    const world = fixture();
    await designate(world.service);
    const proposed = world.service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("Expected proposal");
    const original = world.persistence.journal.append.bind(world.persistence.journal);
    const append = vi.spyOn(world.persistence.journal, "append").mockImplementation((input) => {
      const events =
        typeof input === "object" && input !== null && "events" in input ? input.events : undefined;
      if (
        Array.isArray(events) &&
        events.some(
          (event: unknown) =>
            typeof event === "object" &&
            event !== null &&
            "eventName" in event &&
            "payload" in event &&
            event.eventName === "code.planner-proposal-updated@1" &&
            JSON.stringify(event.payload).includes('"status":"confirmed"'),
        )
      )
        throw new Error("Final proposal journal unavailable");
      return original(input);
    });
    const command = {
      kind: "confirm-planner-work-proposal",
      proposalId: proposed.proposal.id,
      expectedVersion: 1,
      creation: managedCreation(),
    };
    await expect(world.service.resolveProposal(windowId, command)).rejects.toThrow();
    const current = world.service.readView(windowId, ids.project).proposals[0];
    expect(current).toMatchObject({
      proposalVersion: 2,
      proposal: { status: "pending", creationAttempt: { status: "creating" } },
    });
    expect(
      await world.service.resolveProposal(windowId, {
        ...command,
        expectedVersion: current?.proposalVersion,
      }),
    ).toMatchObject({ status: "refused" });
    expect(world.created).toHaveLength(1);
    append.mockRestore();
    expect(world.service.readView(windowId, ids.project).proposals[0]?.proposal).toMatchObject({
      status: "confirmed",
      createdThreadId: ids.otherThread,
    });
    expect(world.created).toHaveLength(1);
  });

  it("never submits a replacement after timeout and task404 while the real authenticated creation remains pending", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const task = decodeCodeThread({
      id: ids.otherThread,
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId: "80000000-0000-4000-8000-000000000001",
      title: draft.title,
      lifecycle: "active",
      providerInstanceId: ids.provider,
      modelId: "model-1",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: managedCreation().deliveryTarget,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    let calls = 0;
    const world = fixture({
      createThread: async () => {
        calls += 1;
        await gate.promise;
        world.createdThreads.set(String(task.id), task);
        return { kind: "thread-created", thread: task };
      },
    });
    await designate(world.service);
    const proposed = world.service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("Expected proposal");
    const review = world.service.readView(windowId, ids.project).proposals[0];
    if (review === undefined) throw new Error("Expected proposal view");
    const store = new WindowAuthorityStore();
    const capability = "A".repeat(43);
    store.register({ windowId, capability, now: 0 });
    const route = createCodeRouteHandler({
      service: {
        executePlannerProposal: (window: WindowId, command: unknown, signal: AbortSignal) =>
          world.service.resolveProposal(window, command, signal),
      } as never,
      windowAuthorityStore: store,
      now: () => 1,
    });
    let commandCalls = 0;
    let pending: Promise<unknown> | undefined;
    const readIds: string[] = [];
    const client = {
      executePlannerProposal: (
        command: Parameters<
          NonNullable<Parameters<typeof createPlannerProposalTask>[0]["executePlannerProposal"]>
        >[0],
      ) => {
        commandCalls += 1;
        const response = (async () => {
          const answer = await route(
            new Request("http://127.0.0.1/api/code/planner/proposals/commands", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-octant-window-capability": capability,
              },
              body: JSON.stringify(command),
            }),
          );
          if (answer === undefined || !answer.ok) throw new Error("Approval transport failed");
          return decodeCodePlannerProposalOutcome(await answer.json());
        })();
        pending = response;
        return response;
      },
      thread: async (id: CodeThreadId) => {
        readIds.push(String(id));
        const found = world.persistence.readCodeThread(id);
        if (found === undefined) throw new Error("HTTP404: submitted task is not present yet");
        return { thread: found };
      },
    };
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const creation = { kind: "create-code-thread" as const, thread: task };
    const firstSend = vi.fn();
    try {
      const first = createPlannerProposalTask(client, review, creation, storage).then((result) => {
        if (result.status === "confirmed") firstSend();
        return result;
      });
      await vi.waitFor(() => expect(calls).toBe(1));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await first).toMatchObject({ status: "unconfirmed" });
      const replacement = {
        ...creation,
        thread: decodeCodeThread({ ...task, id: "20000000-0000-4000-8000-000000000003" }),
      };
      // A new invocation/storage adapter models review remount/reload; pending/404 is not completion.
      expect(
        await createPlannerProposalTask({ ...client }, review, replacement, { ...storage }),
      ).toMatchObject({ status: "unconfirmed" });
      expect(commandCalls).toBe(1);
      expect(calls).toBe(1);
      expect(readIds).toEqual([String(task.id), String(task.id)]);
      expect(firstSend).not.toHaveBeenCalled();
      gate.resolve();
      await pending;
      expect(world.service.readView(windowId, ids.project).proposals[0]?.proposal).toMatchObject({
        status: "confirmed",
        createdThreadId: task.id,
      });
      expect(calls).toBe(1);
      expect(firstSend).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      try {
        await pending;
      } catch {
        /* The assertion reports the original failure. */
      }
      vi.useRealTimers();
    }
  });

  it("admits one creation across windows before awaiting the ordinary creation result", async () => {
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const { service } = fixture({
      createThread: async (_window, creation) => {
        calls += 1;
        await gate.promise;
        return {
          kind: "thread-created",
          thread:
            creation.kind === "create-code-thread"
              ? creation.thread
              : ({ id: creation.threadId, projectId: creation.projectId } as CodeThread),
        };
      },
    });
    await designate(service);
    const proposed = service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("Expected proposal");
    const first = service.resolveProposal(windowId, {
      kind: "confirm-planner-work-proposal",
      proposalId: proposed.proposal.id,
      expectedVersion: 1,
      creation: managedCreation(),
    });
    const second = service.resolveProposal("60000000-0000-4000-8000-000000000002" as WindowId, {
      kind: "confirm-planner-work-proposal",
      proposalId: proposed.proposal.id,
      expectedVersion: 1,
      creation: { ...managedCreation(), threadId: "20000000-0000-4000-8000-000000000003" },
    });
    const pending = service.readView(windowId, ids.project).proposals[0];
    const currentVersionAttempt = service.resolveProposal(windowId, {
      kind: "confirm-planner-work-proposal",
      proposalId: proposed.proposal.id,
      expectedVersion: pending?.proposalVersion,
      creation: { ...managedCreation(), threadId: "20000000-0000-4000-8000-000000000004" },
    });
    gate.resolve();
    const results = await Promise.all([first, second, currentVersionAttempt]);
    expect(calls).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual([
      "confirmed",
      "refused",
      "refused",
    ]);
  });

  it("journals a pending proposal from the planner thread", async () => {
    const { service } = fixture();
    await designate(service);
    const outcome = service.propose(threadId, draft);
    expect(outcome.status).toBe("proposed");
    const view = service.readView(windowId, ids.project);
    expect(view.proposals).toHaveLength(1);
    expect(view.proposals[0]?.proposal).toMatchObject({ status: "pending", title: draft.title });
  });

  it("refuses a proposal from a thread that is not the planner", () => {
    const { service } = fixture();
    const outcome = service.propose(threadId, draft);
    expect(outcome).toMatchObject({ status: "refused", reason: "no-planner-designated" });
  });

  it("creates the confirmed thread through the ordinary creation command path", async () => {
    const { service, created } = fixture();
    await designate(service);
    const proposed = service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("expected a proposal");
    const outcome = await service.resolveProposal(windowId, {
      kind: "confirm-planner-work-proposal",
      proposalId: String(proposed.proposal.id),
      expectedVersion: 1,
      creation: managedCreation(),
    });
    expect(outcome.status).toBe("confirmed");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "create-managed-code-thread" });
    const view = service.readView(windowId, ids.project);
    expect(view.proposals[0]?.proposal).toMatchObject({
      status: "confirmed",
      createdThreadId: ids.otherThread,
    });
  });

  it("asks for the confirmed thread to start marked when the planner thread is marked", async () => {
    for (const marked of [true, false]) {
      const { service, contexts } = fixture({
        isMarkedWithOutsideContent: (id) => marked && id === ids.thread,
      });
      await designate(service);
      const proposed = service.propose(threadId, draft);
      if (proposed.status !== "proposed") throw new Error("expected a proposal");
      await service.resolveProposal(windowId, {
        kind: "confirm-planner-work-proposal",
        proposalId: String(proposed.proposal.id),
        expectedVersion: 1,
        creation: managedCreation(),
      });
      expect(contexts).toEqual([
        marked
          ? {
              inheritedMark: {
                sourceLabel: "planner-proposal",
                contentReference: `planner-proposal-${ids.thread}-${String(proposed.proposal.id)}`,
              },
            }
          : {},
      ]);
    }
  });

  it("creates nothing when the user declines", async () => {
    const { service, created } = fixture();
    await designate(service);
    const proposed = service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("expected a proposal");
    const outcome = await service.resolveProposal(windowId, {
      kind: "decline-planner-work-proposal",
      proposalId: String(proposed.proposal.id),
      expectedVersion: 1,
    });
    expect(outcome.status).toBe("declined");
    expect(created).toHaveLength(0);
  });

  it("refuses to confirm a proposal into a different Project than it was proposed for", async () => {
    const { service, created } = fixture();
    await designate(service);
    const proposed = service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("expected a proposal");
    const outcome = await service.resolveProposal(windowId, {
      kind: "confirm-planner-work-proposal",
      proposalId: String(proposed.proposal.id),
      expectedVersion: 1,
      creation: managedCreation({ projectId: ids.otherProject }),
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "creation-project-mismatch" });
    expect(created).toHaveLength(0);
  });

  it("refuses to resolve a proposal twice", async () => {
    const { service } = fixture();
    await designate(service);
    const proposed = service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("expected a proposal");
    await service.resolveProposal(windowId, {
      kind: "decline-planner-work-proposal",
      proposalId: String(proposed.proposal.id),
      expectedVersion: 1,
    });
    const outcome = await service.resolveProposal(windowId, {
      kind: "decline-planner-work-proposal",
      proposalId: String(proposed.proposal.id),
      expectedVersion: 2,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "proposal-not-pending" });
  });

  it("leaves the proposal pending when the creation path itself fails", async () => {
    const { service } = fixture({
      createThread: async () => {
        throw new Error("worktree creation failed");
      },
    });
    await designate(service);
    const proposed = service.propose(threadId, draft);
    if (proposed.status !== "proposed") throw new Error("expected a proposal");
    await expect(
      service.resolveProposal(windowId, {
        kind: "confirm-planner-work-proposal",
        proposalId: String(proposed.proposal.id),
        expectedVersion: 1,
        creation: managedCreation(),
      }),
    ).rejects.toThrow();
    const view = service.readView(windowId, ids.project);
    expect(view.proposals[0]?.proposal.status).toBe("pending");
  });
});
