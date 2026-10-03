import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  decodeCodeCheckoutIdentity,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AgentRunAuthority,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedRootGrantStore } from "../code/managedRootGrantStore";
import {
  createManagedWorktreeNodePorts,
  observeManagedWorktreeExecutionIdentity,
} from "../code/managedWorktreeNodePorts";
import { ManagedWorktreeReceiptStore } from "../code/managedWorktreeReceiptStore";
import { ManagedWorktreeService } from "../code/managedWorktreeService";
import {
  createAgentRunChildWorktreePort,
  deriveAgentRunChildWorktreeThreadId,
  resolveAgentRunChildWorktreeThreadId,
  resolveAgentRunCodeWorkspaceContext,
} from "./agentRunChildWorktreePort";
import { createAgentRunControlWorkspace } from "../server";
import { prepareAdmittedControlWorkspace } from "./agentRunControlService";
import { AgentRunWorkspaceReceiptStore } from "./agentRunWorkspaceReceiptStore";
import { AgentRunWorkspaceService } from "./agentRunWorkspaceService";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const parentThreadId = "33333333-3333-4333-8333-333333333333";
const requestId = "22222222-2222-4222-8222-222222222222";
const siblingRequestId = "22222222-2222-4222-8222-222222222223";
const windowId = "11111111-1111-4111-8111-111111111111";
const projectId = "77777777-7777-4777-8777-777777777777";
const bindingRevisionId = "88888888-8888-4888-8888-888888888888";
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "octant-child-workspaces-"));
  directories.push(root);
  const repository = join(root, "repository");
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await writeFile(join(repository, "shared.txt"), "committed\n");
  await execFileAsync("git", ["-C", repository, "add", "shared.txt"]);
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
  const observed = await ports.repository.observe(repositoryRoot, signal);
  if (observed.status !== "available") throw new Error("repository fixture unavailable");
  const managedReceipts = new ManagedWorktreeReceiptStore({ dataDirectory: join(root, "data") });
  const service = new ManagedWorktreeService({
    grants: new ManagedRootGrantStore(),
    receipts: managedReceipts,
    ...ports,
    authority: { observeCleanupEligibility: async () => ({ status: "unavailable" }) },
  });
  const port = createAgentRunChildWorktreePort({
    service,
    repository: ports.repository,
    observeExecutionIdentity: observeManagedWorktreeExecutionIdentity,
    loadReceipt: (id) => managedReceipts.load(id),
    findActive: (lookup) => managedReceipts.findActive(lookup),
  });
  const workspaceReceipts = new AgentRunWorkspaceReceiptStore({
    dataDirectory: join(root, "data"),
  });
  const workspace = new AgentRunWorkspaceService({
    receipts: workspaceReceipts,
    childWorktree: port,
  });
  const parent = {
    threadId: parentThreadId,
    mode: "code" as const,
    projectId,
    bindingRevisionId,
    checkoutRoot: repositoryRoot,
  };
  const code = {
    projectId,
    bindingRevisionId,
    repositoryId: observed.repositoryId,
    repositoryRoot,
    parentCheckoutRoot: repositoryRoot,
    branchIntent: "octant/agent-run/child",
    startPoint: observed.checkout.head,
    sourceBranch: "main",
    sourceMode: "local" as const,
  };
  return { root, port, workspace, workspaceReceipts, managedReceipts, parent, code };
}

describe("Code child workspace ownership", () => {
  it("verifies live child ownership after commits while preserving strict preparation", async () => {
    const f = await fixture();
    const prepared = await f.workspace.prepare({
      requestId,
      windowId,
      parent: f.parent,
      code: f.code,
    });
    if (prepared.status !== "prepared" || prepared.workspace.kind !== "code-worktree")
      throw new Error("expected child");
    const receipt = await f.managedReceipts.load(String(prepared.workspace.worktreeReceiptId));
    if (receipt === undefined) throw new Error("expected receipt");
    const input = {
      requestId,
      parentThreadId,
      repositoryId: f.code.repositoryId,
      repositoryRoot: f.code.repositoryRoot,
      parentCheckoutRoot: f.code.parentCheckoutRoot,
      worktreeRoot: receipt.canonicalWorktreePath,
      signal,
    };
    const before = await f.port.verifyExecution(input);
    expect(before.status).toBe("verified");
    await writeFile(join(receipt.canonicalWorktreePath, "shared.txt"), "child commit\n");
    await execFileAsync("git", ["-C", receipt.canonicalWorktreePath, "add", "shared.txt"]);
    await execFileAsync("git", [
      "-C",
      receipt.canonicalWorktreePath,
      "-c",
      "user.name=Octant Test",
      "-c",
      "user.email=test@octant.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "child",
    ]);
    await writeFile(join(receipt.canonicalWorktreePath, "shared.txt"), "child pending edit\n");
    expect(await f.port.verifyExecution(input)).toEqual(before);
    expect(
      await f.workspace.confirm({
        requestId,
        windowId,
        parent: f.parent,
        worktreeReceiptId: receipt.receiptId,
      }),
    ).toMatchObject({ status: "refused" });
    expect(await f.port.verifyExecution({ ...input, requestId: siblingRequestId })).toMatchObject({
      status: "refused",
    });
    await execFileAsync("git", [
      "-C",
      receipt.canonicalWorktreePath,
      "checkout",
      "-b",
      "foreign-branch",
    ]);
    expect(await f.port.verifyExecution(input)).toMatchObject({ status: "refused" });
  });

  it("detects replaced child identity and refuses a deleted or symlinked child", async () => {
    const f = await fixture();
    const prepared = await f.workspace.prepare({
      requestId,
      windowId,
      parent: f.parent,
      code: f.code,
    });
    if (prepared.status !== "prepared" || prepared.workspace.kind !== "code-worktree")
      throw new Error("expected child");
    const receipt = await f.managedReceipts.load(String(prepared.workspace.worktreeReceiptId));
    if (receipt === undefined) throw new Error("expected receipt");
    const input = {
      requestId,
      parentThreadId,
      repositoryId: f.code.repositoryId,
      repositoryRoot: f.code.repositoryRoot,
      parentCheckoutRoot: f.code.parentCheckoutRoot,
      worktreeRoot: receipt.canonicalWorktreePath,
      signal,
    };
    const original = await f.port.verifyExecution(input);
    expect(original.status).toBe("verified");
    const moved = `${receipt.canonicalWorktreePath}-moved`;
    await rename(receipt.canonicalWorktreePath, moved);
    expect(await f.port.verifyExecution(input)).toMatchObject({ status: "refused" });
    await symlink(moved, receipt.canonicalWorktreePath);
    expect(await f.port.verifyExecution(input)).toMatchObject({ status: "refused" });
    await rm(receipt.canonicalWorktreePath);
    await cp(moved, receipt.canonicalWorktreePath, { recursive: true });
    const replacement = await f.port.verifyExecution(input);
    expect(replacement.status).toBe("verified");
    expect(replacement).not.toEqual(original);
    await f.managedReceipts.transition(receipt.receiptId, "cleanup-pending");
    expect(await f.port.verifyExecution(input)).toMatchObject({ status: "refused" });
  });

  it("links each child to its recorded workspace and preserves legacy child links", async () => {
    const f = await fixture();
    const input = { requestId, windowId, parent: f.parent, code: f.code };
    const workspace = await prepareAdmittedControlWorkspace({
      ...input,
      role: "implementation",
      workspace: f.workspace,
      parent: {
        parentMode: "code",
        workspaceParent: f.parent,
        codeWorkspace: f.code,
        parentRoute: {
          providerInstanceId: decodeProviderInstanceId("44444444-4444-4444-8444-444444444444"),
          modelId: decodeProviderModelId("fixture"),
        },
        parentAuthority: {
          filesystem: true,
          shell: true,
          git: true,
          network: true,
          tools: true,
          subagents: true,
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
        },
        liveAuthority: {
          filesystem: true,
          shell: true,
          git: true,
          network: true,
          tools: true,
          subagents: true,
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
        },
      },
    });
    if (workspace.status !== "admitted" || workspace.workspace.kind !== "code-worktree")
      throw new Error("expected admitted Code workspace");
    const context = {
      parentThreadId,
      requestId,
      repositoryId: f.code.repositoryId,
      workspace: workspace.workspace,
    };
    const childId = deriveAgentRunChildWorktreeThreadId(parentThreadId, requestId);
    expect(resolveAgentRunChildWorktreeThreadId(context)).toBe(childId);
    expect(
      resolveAgentRunChildWorktreeThreadId({ ...context, requestId: siblingRequestId }),
    ).toBeUndefined();
    const legacyId = deriveAgentRunChildWorktreeThreadId(parentThreadId);
    expect(
      resolveAgentRunChildWorktreeThreadId({
        ...context,
        workspace: {
          ...context.workspace,
          worktreeRoot: context.workspace.worktreeRoot.replace(childId, legacyId),
        },
      }),
    ).toBe(legacyId);
    expect(
      resolveAgentRunChildWorktreeThreadId({
        ...context,
        workspace: { ...context.workspace, worktreeRoot: context.workspace.checkoutRoot },
      }),
    ).toBeUndefined();
  });

  it("replays a prepared request after receipt expiry without allocating another checkout", async () => {
    const f = await fixture();
    const input = { requestId, windowId, parent: f.parent, code: f.code };
    const first = await f.workspace.prepare(input);
    await f.workspaceReceipts.forgetExpired(Number.MAX_SAFE_INTEGER);
    const restarted = new AgentRunWorkspaceService({
      receipts: new AgentRunWorkspaceReceiptStore({ dataDirectory: join(f.root, "data") }),
      childWorktree: f.port,
    });
    expect(await restarted.prepare(input)).toEqual(first);
  });

  it("admits a child from a managed parent checkout through the server workspace composition", async () => {
    const f = await fixture();
    const preparedParent = await f.workspace.prepare({
      requestId,
      windowId,
      parent: f.parent,
      code: f.code,
    });
    if (preparedParent.status !== "prepared" || preparedParent.workspace.kind !== "code-worktree")
      throw new Error("expected managed parent");
    const receipt = await f.managedReceipts.load(
      String(preparedParent.workspace.worktreeReceiptId),
    );
    if (receipt === undefined) throw new Error("expected parent receipt");
    const checkout = decodeCodeCheckoutIdentity({
      id: receipt.checkoutId,
      repositoryId: receipt.repositoryId,
      kind: "managed-worktree",
      availability: "available",
      ownershipReceiptId: receipt.receiptId,
      head: { kind: "branch", name: receipt.branchIntent, oid: receipt.expectedHead },
      observedAt: receipt.updatedAt,
    });
    const resolveContext = () =>
      resolveAgentRunCodeWorkspaceContext({
        thread: {
          projectId,
          bindingRevisionId,
          repositoryId: receipt.repositoryId,
          checkoutId: receipt.checkoutId,
        },
        repositoryRoot: f.code.repositoryRoot,
        checkout,
        loadManagedReceipt: (id) => f.managedReceipts.load(id),
      });
    const workspace = createAgentRunControlWorkspace(
      f.workspace,
      async (threadId) => {
        expect(threadId).toBe(receipt.threadId);
        const context = await resolveContext();
        return context === undefined ? {} : { checkoutRoot: context.parentCheckoutRoot };
      },
      async () => {
        const code = await resolveContext();
        return code === undefined ? {} : { code };
      },
    );
    const authority: AgentRunAuthority = {
      filesystem: true,
      shell: true,
      git: true,
      network: true,
      tools: true,
      subagents: true,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    };
    const result = await prepareAdmittedControlWorkspace({
      requestId: siblingRequestId,
      windowId,
      workspace,
      role: "implementation",
      parent: {
        parentMode: "code",
        parentAuthority: authority,
        liveAuthority: authority,
        // authorizeCreation supplies identity and binding, not a checkout path.
        workspaceParent: { threadId: receipt.threadId, mode: "code", projectId, bindingRevisionId },
        parentRoute: {
          providerInstanceId: decodeProviderInstanceId("44444444-4444-4444-8444-444444444444"),
          modelId: decodeProviderModelId("fixture"),
        },
      },
    });
    expect(result.status).toBe("admitted");
    if (result.status !== "admitted" || result.workspace.kind !== "code-worktree")
      throw new Error("expected admitted child");
    expect(result.workspace.verified).toBe(true);
    expect(result.workspace.worktreeRoot).not.toBe(receipt.canonicalWorktreePath);
    expect(result.workspace.worktreeRoot).not.toBe(f.code.repositoryRoot);
    expect(await readFile(join(result.workspace.worktreeRoot, "shared.txt"), "utf8")).toBe(
      "committed\n",
    );
  });

  it("admits concurrent siblings separately and replays only the same authorized child", async () => {
    const f = await fixture();
    const authority: AgentRunAuthority = {
      filesystem: true,
      shell: true,
      git: true,
      network: true,
      tools: true,
      subagents: true,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    };
    const input = {
      requestId,
      windowId,
      workspace: f.workspace,
      role: "implementation" as const,
      parent: {
        parentMode: "code" as const,
        parentAuthority: authority,
        liveAuthority: authority,
        workspaceParent: f.parent,
        codeWorkspace: f.code,
        parentRoute: {
          providerInstanceId: decodeProviderInstanceId("44444444-4444-4444-8444-444444444444"),
          modelId: decodeProviderModelId("fixture"),
        },
      },
    };
    const [first, replay, sibling] = await Promise.all([
      prepareAdmittedControlWorkspace(input),
      prepareAdmittedControlWorkspace(input),
      prepareAdmittedControlWorkspace({ ...input, requestId: siblingRequestId }),
    ]);
    expect(first.status).toBe("admitted");
    expect(replay).toEqual(first);
    expect(sibling.status).toBe("admitted");
    expect(sibling).not.toEqual(first);
  });

  it("refuses sibling, stale, parent-checkout and unavailable receipts before admission", async () => {
    const f = await fixture();
    const prepared = await f.workspace.prepare({
      requestId,
      windowId,
      parent: f.parent,
      code: f.code,
    });
    if (prepared.status !== "prepared" || prepared.workspace.kind !== "code-worktree")
      throw new Error("expected workspace");
    const worktreeReceiptId = String(prepared.workspace.worktreeReceiptId);
    const confirm = { requestId, windowId, parent: f.parent, worktreeReceiptId };
    expect((await f.workspace.confirm(confirm)).status).toBe("confirmed");
    expect(
      await f.workspace.confirm({
        ...confirm,
        parent: { ...f.parent, projectId: "99999999-9999-4999-8999-999999999999" },
      }),
    ).toEqual({ status: "refused", reason: "foreign-project" });
    expect(await f.workspace.confirm({ ...confirm, requestId: siblingRequestId })).toEqual({
      status: "refused",
      reason: "foreign-thread",
    });
    expect(
      await f.workspace.admit({
        ...confirm,
        requestId: siblingRequestId,
        requested: {
          kind: "code-worktree",
          mode: "code",
          worktreeReceiptId: prepared.workspace.worktreeReceiptId,
        },
        role: "implementation",
      }),
    ).toEqual({ status: "refused", reason: "foreign-thread" });
    expect(
      await f.workspace.confirm({
        ...confirm,
        parent: { ...f.parent, bindingRevisionId: "99999999-9999-4999-8999-999999999999" },
      }),
    ).toEqual({ status: "refused", reason: "stale" });
    expect(
      await f.port.confirm({
        requestId: siblingRequestId,
        parentThreadId,
        parentCheckoutRoot: f.code.parentCheckoutRoot,
        repositoryId: f.code.repositoryId,
        repositoryRoot: f.code.repositoryRoot,
        startingRevision: f.code.startPoint,
        worktreeReceiptId,
      }),
    ).toEqual({ status: "refused", reason: "foreign-thread" });
    const receipt = await f.managedReceipts.load(worktreeReceiptId);
    if (receipt === undefined) throw new Error("expected managed receipt");
    expect(
      await f.workspace.confirm({
        ...confirm,
        parent: { ...f.parent, checkoutRoot: receipt.canonicalWorktreePath },
      }),
    ).toEqual({ status: "refused", reason: "parent-checkout" });
    await rm(receipt.canonicalWorktreePath, { recursive: true });
    expect(await f.workspace.confirm(confirm)).toEqual({
      status: "refused",
      reason: "unavailable",
    });
    const grant = await f.workspaceReceipts.load(worktreeReceiptId);
    if (grant === undefined) throw new Error("expected preparation receipt");
    await f.workspaceReceipts.save({ ...grant, expiresAt: 0 });
    expect(await f.workspace.confirm(confirm)).toEqual({ status: "refused", reason: "expired" });
  });

  it("allocates different sibling checkouts and reuses only the same admitted request", async () => {
    const f = await fixture();
    await writeFile(join(f.code.repositoryRoot, "shared.txt"), "parent uncommitted\n");
    const prepare = (id: string) =>
      f.workspace.prepare({ requestId: id, windowId, parent: f.parent, code: f.code });
    const first = await prepare(requestId);
    const sibling = await prepare(siblingRequestId);
    expect(first.status).toBe("prepared");
    expect(sibling.status).toBe("prepared");
    if (
      first.status !== "prepared" ||
      first.workspace.kind !== "code-worktree" ||
      sibling.status !== "prepared" ||
      sibling.workspace.kind !== "code-worktree"
    )
      throw new Error("expected child workspaces");
    expect(sibling.workspace.worktreeReceiptId).not.toBe(first.workspace.worktreeReceiptId);
    expect(await prepare(requestId)).toEqual(first);
    const [one, two] = await Promise.all([
      f.managedReceipts.load(String(first.workspace.worktreeReceiptId)),
      f.managedReceipts.load(String(sibling.workspace.worktreeReceiptId)),
    ]);
    if (one === undefined || two === undefined) throw new Error("expected managed receipts");
    expect(one.canonicalWorktreePath).not.toBe(two.canonicalWorktreePath);
    expect(one.branchIntent).not.toBe(two.branchIntent);
    expect(one.expectedHead).toBe(f.code.startPoint);
    expect(two.source?.resolvedHead).toBe(f.code.startPoint);
    expect(await readFile(join(one.canonicalWorktreePath, "shared.txt"), "utf8")).toBe(
      "committed\n",
    );
    await writeFile(join(one.canonicalWorktreePath, "shared.txt"), "first child only\n");
    expect(await readFile(join(two.canonicalWorktreePath, "shared.txt"), "utf8")).toBe(
      "committed\n",
    );
    expect(await readFile(join(f.code.repositoryRoot, "shared.txt"), "utf8")).toBe(
      "parent uncommitted\n",
    );
  });
});
