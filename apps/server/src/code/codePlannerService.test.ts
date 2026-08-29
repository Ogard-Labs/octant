import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeThreadId,
  decodeProjectId,
  type CodeCommandResult,
  type CodePlannerThreadCreation,
  type CodeThread,
  type CodeThreadId,
  type Project,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { PersistenceService } from "../persistence/persistenceService";
import { CodePlannerService } from "./codePlannerService";

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
  readonly createThread?: (
    windowId: WindowId,
    creation: CodePlannerThreadCreation,
  ) => Promise<CodeCommandResult>;
  readonly canAccessProject?: (windowId: WindowId, projectId: ProjectId) => boolean;
}

function fixture(options?: FixtureOptions): {
  service: CodePlannerService;
  created: Array<CodePlannerThreadCreation>;
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
  const persistence = {
    connection,
    journal,
    readProject: (projectId: ProjectId) =>
      String(projectId) === ids.project ? project : undefined,
    readCodeThread: (threadId: CodeThreadId) =>
      String(threadId) === ids.thread ? thread : undefined,
  } as unknown as PersistenceService;
  const created: Array<CodePlannerThreadCreation> = [];
  const service = new CodePlannerService({
    persistence,
    uuid: () => crypto.randomUUID(),
    clock: () => now,
    canAccessProject: options?.canAccessProject ?? (() => true),
    createThread:
      options?.createThread ??
      (async (_windowId, creation) => {
        created.push(creation);
        return { kind: "thread-created", thread: creation as never } as never;
      }),
  });
  return { service, created };
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
