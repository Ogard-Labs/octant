import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeCodeThreadView, decodeProject, decodeWindowId } from "@octant/contracts";
import { createManagedWorktreeNodePorts } from "../code/managedWorktreeNodePorts";
import {
  createExistingWorktreeCodeFileRootAuthority,
  deriveExistingWorktreeCheckoutId,
} from "../wiring/code";
import { saveGeneratedCodeImage, saveGeneratedImageUnder } from "./generatedImageSave";

const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-11-20T09:00:00.000Z";
const windowId = decodeWindowId(id(7));

async function codeCheckout(root: string, kind: "existing-worktree" | "managed-worktree") {
  const projectRoot = join(root, "project");
  const worktreeRoot = join(root, "worktree");
  mkdirSync(projectRoot);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Initial commit",
  );
  if (kind === "managed-worktree") git("worktree", "add", "-q", "-b", "draw", worktreeRoot);

  const { repository } = createManagedWorktreeNodePorts();
  const observed = await repository.observe(projectRoot, new AbortController().signal);
  if (observed.status !== "available") throw new Error("Test repository is unavailable.");
  const { repositoryId } = observed;
  const binding = { canonicalRoot: projectRoot };
  const projectId = id(2);
  const bindingRevisionId = id(3);
  const checkoutId =
    kind === "managed-worktree"
      ? id(4)
      : deriveExistingWorktreeCheckoutId({
          projectId,
          bindingRevisionId,
          repositoryId,
          canonicalRoot: projectRoot,
        });
  const head = git("rev-parse", "HEAD");
  const view = decodeCodeThreadView({
    thread: {
      id: id(1),
      projectId,
      bindingRevisionId,
      checkoutId,
      repositoryId,
      title: "Draw an image",
      lifecycle: "active",
      providerInstanceId: id(5),
      modelId: "model",
      executionPolicy: "full-access",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "draw",
        remoteName: "origin",
        proposedBaseRepository: "test/project",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    checkout: {
      id: checkoutId,
      repositoryId,
      kind,
      availability: "available",
      head: { kind: "branch", name: kind === "managed-worktree" ? "draw" : "main", oid: head },
      ...(kind === "managed-worktree" ? { ownershipReceiptId: id(6) } : {}),
      observedAt: now,
    },
    lastSequence: 1,
  });
  const project = decodeProject({
    id: projectId,
    name: "Test project",
    type: "code",
    lifecycle: "active",
    codeAccessPersistence: "current-session",
    binding,
    bindingHistory: [
      {
        revisionId: bindingRevisionId,
        revision: 1,
        currentBinding: binding,
        actor: { kind: "local-user", actorId: id(7) },
        changedAt: now,
      },
    ],
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (project.type !== "code") throw new Error("Expected a Code Project.");
  const identity = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino) };
  };
  const roots = createExistingWorktreeCodeFileRootAuthority({
    projects: {
      bootstrap: async () => ({
        active: [{ ...project, bindingRevisionId: view.thread.bindingRevisionId }],
        archived: [],
        availability: [],
        memory: [],
      }),
    },
    readProject: () => project,
    repository,
    managedReceipts: {
      load: async () => ({
        version: 1,
        receiptId: id(6),
        state: "ready",
        threadId: view.thread.id,
        checkoutId,
        repositoryId,
        canonicalRepositoryPath: projectRoot,
        canonicalWorktreePath: worktreeRoot,
        branchIntent: "draw",
        refIntent: "refs/heads/draw",
        expectedHead: head,
        createdAt: now,
        updatedAt: now,
      }),
    },
    statIdentity: async (path) => identity(path),
    currentIdentity: (path) => ({ canonicalPath: realpathSync(path), ...identity(path) }),
  });
  return { view, roots, projectRoot, worktreeRoot };
}

describe("saving a generated image under a folder", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "octant-image-save-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the file, and the folders on its path, inside the folder", async () => {
    const saved = await saveGeneratedImageUnder({ root, relativePath: "art/cube.png", bytes });
    expect(saved).toEqual({ status: "saved", relativePath: "art/cube.png" });
    expect(Uint8Array.from(readFileSync(join(root, "art", "cube.png")))).toEqual(bytes);
  });

  it("refuses a path that leaves the folder", async () => {
    const saved = await saveGeneratedImageUnder({ root, relativePath: "../escape.png", bytes });
    expect(saved.status).not.toBe("saved");
  });

  it("never overwrites a file that is already there", async () => {
    writeFileSync(join(root, "cube.png"), "keep");
    const saved = await saveGeneratedImageUnder({ root, relativePath: "cube.png", bytes });
    expect(saved.status).not.toBe("saved");
    expect(readFileSync(join(root, "cube.png"), "utf8")).toBe("keep");
  });

  it.each(["managed-worktree", "existing-worktree"] as const)(
    "saves a Code thread's image in its %s checkout",
    async (kind) => {
      const { view, roots, projectRoot, worktreeRoot } = await codeCheckout(root, kind);
      const relativePath = "art/cube.png";
      const saved = await saveGeneratedCodeImage({ view, windowId, relativePath, bytes }, roots);
      expect(saved).toEqual({ status: "saved", relativePath });
      const [checkout, other] =
        kind === "managed-worktree" ? [worktreeRoot, projectRoot] : [projectRoot, worktreeRoot];
      expect(existsSync(join(other, relativePath))).toBe(false);
      expect(Uint8Array.from(readFileSync(join(checkout, relativePath)))).toEqual(bytes);
    },
  );

  it("refuses to leave the worktree, overwrite a file, or save in Plan", async () => {
    const { view, roots, worktreeRoot } = await codeCheckout(root, "managed-worktree");
    const input = { view, windowId, bytes };
    const existing = join(worktreeRoot, "existing.png");
    writeFileSync(existing, "keep");
    await expect(
      saveGeneratedCodeImage({ ...input, relativePath: "../escape.png" }, roots),
    ).resolves.toMatchObject({ status: "refused" });
    await expect(
      saveGeneratedCodeImage({ ...input, relativePath: "existing.png" }, roots),
    ).resolves.not.toMatchObject({ status: "saved" });
    const plan = { ...view, thread: { ...view.thread, executionPolicy: "plan" as const } };
    await expect(
      saveGeneratedCodeImage({ ...input, view: plan, relativePath: "plan.png" }, roots),
    ).resolves.toMatchObject({ status: "refused" });
    expect(existsSync(join(root, "escape.png"))).toBe(false);
    expect(existsSync(join(worktreeRoot, "plan.png"))).toBe(false);
    expect(readFileSync(existing, "utf8")).toBe("keep");
  });
});
