import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CanvasCreated,
  CanvasVersionAppended,
  decodeCanvasBlock,
  type AgentRun,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { Schema } from "effect";
import {
  agentRunChildWorktreeLookup,
  createAgentRunChildWorktreePort,
  deriveAgentRunChildWorktreeThreadId,
} from "../agentRun/agentRunChildWorktreePort";
import { prepareAdmittedControlWorkspace } from "../agentRun/agentRunControlService";
import { AgentRunWorkspaceReceiptStore } from "../agentRun/agentRunWorkspaceReceiptStore";
import { AgentRunWorkspaceService } from "../agentRun/agentRunWorkspaceService";
import { ManagedRootGrantStore } from "../code/managedRootGrantStore";
import {
  createManagedWorktreeNodePorts,
  observeManagedWorktreeExecutionIdentity,
} from "../code/managedWorktreeNodePorts";
import { ManagedWorktreeReceiptStore } from "../code/managedWorktreeReceiptStore";
import { managedTargetPath, ManagedWorktreeService } from "../code/managedWorktreeService";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { CANVAS_CREATED, CANVAS_VERSION_APPENDED, CanvasEventStore } from "./canvasEventStore";
import { CanvasProjection } from "./canvasProjection";
import { CanvasService } from "./canvasService";
import { CANVAS_TOOL_NAME, createChildCanvasAgentTools } from "./canvasAgentTools";
import { loadChildCanvasWorkspace, type ChildCanvasWorkspaceHost } from "./childCanvasWorkspace";

const execFileAsync = promisify(execFile);
const runId = "12121212-1212-4121-8121-121212121212";
const requestId = "44444444-4444-4444-8444-444444444444";
const parentThreadId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
const windowId = "11111111-1111-4111-8111-111111111111";
const bindingRevisionId = "77777777-7777-4777-8777-777777777777";
const repositoryId = `repo_${"ab".repeat(32)}`;
const checkoutRoot = "/repo";
const childThreadId = deriveAgentRunChildWorktreeThreadId(parentThreadId, requestId);
const worktreeRoot = managedTargetPath(checkoutRoot, repositoryId, childThreadId);
const lookup = agentRunChildWorktreeLookup({
  repositoryId,
  repositoryRoot: checkoutRoot,
  childThreadId,
});

function workRun(): AgentRun {
  return {
    id: runId,
    requestId,
    parentThreadId,
    workspaceReceipt: {
      kind: "work-root",
      mode: "work",
      projectId,
      bindingRevisionId,
      canonicalRoot: "/work",
    },
  } as AgentRun;
}

function codeRun(
  overrides?: Partial<Extract<AgentRun["workspaceReceipt"], { kind: "code-worktree" }>>,
): AgentRun {
  return {
    id: runId,
    requestId,
    parentThreadId,
    workspaceReceipt: {
      kind: "code-worktree",
      mode: "code",
      projectId,
      checkoutRoot,
      worktreeRoot,
      verified: true,
      ...overrides,
    },
  } as AgentRun;
}

const codeProject = {
  id: projectId,
  type: "code",
  lifecycle: "active",
  binding: { canonicalRoot: checkoutRoot },
  bindingHistory: [{ revisionId: bindingRevisionId }],
} as const;
const codeThread = {
  lifecycle: "active",
  projectId,
  repositoryId,
  bindingRevisionId,
} as const;

function readyReceipt(overrides: Record<string, unknown> = {}) {
  return {
    ...lookup,
    version: 1,
    receiptId: "99999999-9999-4999-8999-999999999999",
    state: "ready",
    expectedHead: "a".repeat(40),
    ...overrides,
  } as never;
}

function codeHost(overrides: Partial<ChildCanvasWorkspaceHost> = {}): ChildCanvasWorkspaceHost {
  return {
    readRun: () => codeRun(),
    readProject: () => codeProject,
    readCodeThread: () => codeThread,
    findManagedWorktreeReceipt: async () => readyReceipt(),
    ...overrides,
  };
}

describe("loadChildCanvasWorkspace", () => {
  it("binds a Work child to the live Project binding, not a supplied path", async () => {
    const resolved = await loadChildCanvasWorkspace(
      {
        readRun: () => workRun(),
        readProject: () => ({
          id: projectId,
          type: "work",
          lifecycle: "active",
          binding: { canonicalRoot: "/work" },
          bindingHistory: [{ revisionId: bindingRevisionId }],
        }),
        readCodeThread: () => undefined,
        findManagedWorktreeReceipt: async () => undefined,
      },
      runId,
    );
    expect(resolved.status).toBe("ready");
    if (resolved.status !== "ready") return;
    expect(resolved.binding.workspace).toMatchObject({
      kind: "work-root",
      projectId,
      rootId: bindingRevisionId,
    });
  });

  it("refuses a Work child whose Project is not the run's Project", async () => {
    const resolved = await loadChildCanvasWorkspace(
      {
        readRun: () => workRun(),
        readProject: () => ({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "work",
          lifecycle: "active",
          binding: { canonicalRoot: "/work" },
          bindingHistory: [{ revisionId: bindingRevisionId }],
        }),
        readCodeThread: () => undefined,
        findManagedWorktreeReceipt: async () => undefined,
      },
      runId,
    );
    expect(resolved).toEqual({ status: "refused", reason: "foreign-project" });
  });

  it("binds a Code child to the worktree allocated for its own delegation", async () => {
    const resolved = await loadChildCanvasWorkspace(codeHost(), runId);
    expect(resolved.status).toBe("ready");
    if (resolved.status !== "ready") return;
    expect(resolved.binding.workspace).toMatchObject({
      kind: "code-worktree",
      projectId,
      repositoryId,
      checkoutId: lookup.checkoutId,
      verified: true,
    });
  });

  it("refuses a Code child whose managed receipt the host cannot find", async () => {
    const resolved = await loadChildCanvasWorkspace(
      codeHost({ findManagedWorktreeReceipt: async () => undefined }),
      runId,
    );
    expect(resolved).toEqual({ status: "refused", reason: "unresolved" });
  });

  it("refuses a Code child whose receipt is not ready or names another worktree", async () => {
    for (const receipt of [
      readyReceipt({ state: "cleanup-pending" }),
      readyReceipt({ canonicalWorktreePath: "/elsewhere/worktree" }),
      readyReceipt({ checkoutId: "88888888-8888-4888-8888-888888888888" }),
    ]) {
      const resolved = await loadChildCanvasWorkspace(
        codeHost({ findManagedWorktreeReceipt: async () => receipt }),
        runId,
      );
      expect(resolved).toEqual({ status: "refused", reason: "unresolved" });
    }
  });

  it("refuses a Code child whose receipt lookup conflicts or whose worktree is not its own", async () => {
    expect(
      await loadChildCanvasWorkspace(
        codeHost({
          findManagedWorktreeReceipt: async () => {
            throw new Error("conflicting managed worktree receipt");
          },
        }),
        runId,
      ),
    ).toEqual({ status: "refused", reason: "unresolved" });
    // A worktree that is the parent's checkout, or a sibling delegation's, is
    // never this run's own.
    for (const run of [
      codeRun({ worktreeRoot: checkoutRoot }),
      codeRun({
        worktreeRoot: managedTargetPath(
          checkoutRoot,
          repositoryId,
          deriveAgentRunChildWorktreeThreadId(
            parentThreadId,
            "55555555-5555-4555-8555-555555555555",
          ),
        ),
      }),
      codeRun({ verified: false }),
    ]) {
      expect(await loadChildCanvasWorkspace(codeHost({ readRun: () => run }), runId)).toEqual({
        status: "refused",
        reason: "unresolved",
      });
    }
  });

  it("refuses a Code child under a foreign Project or a moved Project root", async () => {
    expect(
      await loadChildCanvasWorkspace(
        codeHost({
          readCodeThread: () => ({
            ...codeThread,
            projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          }),
        }),
        runId,
      ),
    ).toEqual({ status: "refused", reason: "foreign-project" });
    expect(
      await loadChildCanvasWorkspace(
        codeHost({
          readProject: () => ({ ...codeProject, binding: { canonicalRoot: "/another/repo" } }),
        }),
        runId,
      ),
    ).toEqual({ status: "refused", reason: "unresolved" });
  });
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const now = "2026-08-01T21:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});

function canvasService() {
  const directory = mkdtempSync(join(tmpdir(), "octant-child-canvas-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const projection = new CanvasProjection();
  const journal = new Journal({
    connection,
    registry: new EventRegistry()
      .register(CANVAS_CREATED, 1, CanvasCreated)
      .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended),
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(projection),
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    return `bbbbbbbb-bbbb-4bbb-8bbb-${counter.toString(16).padStart(12, "0")}`;
  };
  return {
    projection,
    uuid,
    service: new CanvasService(
      {
        projection,
        eventStore: new CanvasEventStore({ journal, uuid, actor }),
        uuid,
        clock: () => now as never,
      },
      { authorize: () => true },
    ),
  };
}

async function allocatedChild() {
  const root = await mkdtemp(join(tmpdir(), "octant-child-canvas-worktree-"));
  directories.push(root);
  const repository = join(root, "repository");
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await writeFile(join(repository, "notes.txt"), "committed\n");
  await execFileAsync("git", ["-C", repository, "add", "notes.txt"]);
  await execFileAsync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Octant Test",
    "-c",
    "user.email=test@octant.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  const repositoryRoot = await realpath(repository);
  const ports = createManagedWorktreeNodePorts();
  const signal = new AbortController().signal;
  const observed = await ports.repository.observe(repositoryRoot, signal);
  if (observed.status !== "available") throw new Error("repository fixture unavailable");
  const managedReceipts = new ManagedWorktreeReceiptStore({ dataDirectory: join(root, "data") });
  const childWorktree = createAgentRunChildWorktreePort({
    service: new ManagedWorktreeService({
      grants: new ManagedRootGrantStore(),
      receipts: managedReceipts,
      ...ports,
      authority: { observeCleanupEligibility: async () => ({ status: "unavailable" }) },
    }),
    repository: ports.repository,
    observeExecutionIdentity: observeManagedWorktreeExecutionIdentity,
    loadReceipt: (id) => managedReceipts.load(id),
    findActive: (query) => managedReceipts.findActive(query),
  });
  const workspace = new AgentRunWorkspaceService({
    receipts: new AgentRunWorkspaceReceiptStore({ dataDirectory: join(root, "data") }),
    childWorktree,
  });
  const authority = {
    filesystem: true,
    shell: true,
    git: true,
    network: true,
    tools: true,
    subagents: true,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  } as const;
  const admitted = await prepareAdmittedControlWorkspace({
    requestId,
    windowId,
    role: "implementation",
    workspace,
    parent: {
      parentMode: "code",
      workspaceParent: {
        threadId: parentThreadId,
        mode: "code",
        projectId,
        bindingRevisionId,
        checkoutRoot: repositoryRoot,
      },
      codeWorkspace: {
        projectId,
        bindingRevisionId,
        repositoryId: observed.repositoryId,
        repositoryRoot,
        parentCheckoutRoot: repositoryRoot,
        branchIntent: "octant/agent-run/child",
        startPoint: observed.checkout.head,
        sourceBranch: "main",
        sourceMode: "local",
      },
      parentRoute: { providerInstanceId: "p" as never, modelId: "m" as never },
      parentAuthority: authority,
      liveAuthority: authority,
    },
  });
  if (admitted.status !== "admitted" || admitted.workspace.kind !== "code-worktree") {
    throw new Error("expected an admitted child worktree");
  }
  const run = {
    id: runId,
    requestId,
    parentThreadId,
    workspaceReceipt: admitted.workspace,
  } as AgentRun;
  const host = (): ChildCanvasWorkspaceHost => ({
    readRun: () => run,
    readProject: () => ({
      id: projectId,
      type: "code",
      lifecycle: "active",
      binding: { canonicalRoot: repositoryRoot },
      bindingHistory: [{ revisionId: bindingRevisionId }],
    }),
    // The parent's own checkout is journaled; the child's worktree is not, so
    // nothing here can answer a checkout lookup for it.
    readCodeThread: () => ({
      lifecycle: "active",
      projectId,
      repositoryId: observed.repositoryId,
      bindingRevisionId,
    }),
    findManagedWorktreeReceipt: (query) => managedReceipts.findActive(query),
  });
  return { run, host, managedReceipts, repositoryId: observed.repositoryId };
}

describe("a Code child's Canvas on the real worktree allocation path", () => {
  const block = decodeCanvasBlock({
    blockId: "plan",
    schemaVersion: 1,
    kind: "rich-text",
    text: "Three steps.",
  });

  it("creates and revises a Canvas in the child's own worktree and names the child as author", async () => {
    const child = await allocatedChild();
    const { service, projection, uuid } = canvasService();
    const set = createChildCanvasAgentTools({
      port: {
        activeContext: () => undefined,
        project: async () => undefined,
        canvas: service,
        uuid,
        hostId: "local",
        resolveChildWorkspace: ({ runId: id }: { readonly runId: string }) =>
          loadChildCanvasWorkspace(child.host(), id),
      } as never,
      run: {
        id: runId,
        parentThreadId,
        mode: "code",
        projectId,
        providerInstanceId: "44444444-4444-4444-8444-444444444444" as never,
        modelId: "octant-test-model" as never,
      },
    });

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Plan", blocks: [block] }),
    });
    expect(created.isError).not.toBe(true);
    const canvasId = (created.result as { canvasId: string }).canvasId;
    const entry = projection.getById(canvasId as never);
    expect(entry?.currentVersion.createdBy).toEqual({ kind: "agent", actorId: runId });
    expect(entry?.currentVersion.definition.provenance.threadId).toBe(parentThreadId);

    const revised = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "revise",
        canvasId,
        expectedSequence: 1,
        blocks: [block],
      }),
    });
    expect(revised.isError).not.toBe(true);
    expect(projection.getById(canvasId as never)?.currentVersion.sequence).toBe(2);
    expect(child.repositoryId).toMatch(/^repo_/);
  });

  it("stops binding once the child's worktree receipt is no longer ready or its worktree is replaced", async () => {
    const child = await allocatedChild();
    expect((await loadChildCanvasWorkspace(child.host(), runId)).status).toBe("ready");

    const replaced = {
      ...child.run,
      workspaceReceipt: {
        ...child.run.workspaceReceipt,
        worktreeRoot: `${(child.run.workspaceReceipt as { worktreeRoot: string }).worktreeRoot}-moved`,
      },
    } as AgentRun;
    expect(
      await loadChildCanvasWorkspace({ ...child.host(), readRun: () => replaced }, runId),
    ).toEqual({ status: "refused", reason: "unresolved" });

    const receipts = child.managedReceipts;
    const receipt = await receipts.findActive(
      agentRunChildWorktreeLookup({
        repositoryId: child.repositoryId,
        repositoryRoot: (child.run.workspaceReceipt as { checkoutRoot: string }).checkoutRoot,
        childThreadId,
      }),
    );
    if (receipt === undefined) throw new Error("expected the child's receipt");
    await receipts.transition(receipt.receiptId, "cleanup-pending");
    expect(await loadChildCanvasWorkspace(child.host(), runId)).toEqual({
      status: "refused",
      reason: "unresolved",
    });
  });
});
