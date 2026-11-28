import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  decodeBindingRevisionId,
  decodeCodeCheckoutId,
  decodeCodeEvidenceReference,
  decodeCodeOperationId,
  decodeCodeRelativePath,
  decodeCodeRepositoryId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProject,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  decodeWindowId,
  type CodeCheckoutIdentity,
  type CodeGitOperationId,
  type ProjectSummary,
} from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExistingWorktreeCodeCheckoutObservation,
  createExistingWorktreeCodeFileRootAuthority,
} from "../wiring/code";
import { createManagedWorktreeNodePorts } from "./managedWorktreeNodePorts";
import {
  discoverProjectRepositories,
  parseCodeWorkspaceJson,
  parseCommittedGitModules,
} from "./projectRepositoryDiscovery";
import { turnChangedFiles, turnChangedFilesAcrossRepositories } from "./codeTurnChangedFiles";
import { GitService } from "./gitService";
import { GitObservationPort } from "./gitObservationPort";
import { GitMutationPort } from "./gitMutationPort";
import { CodeOperationService, type CodeOperationGitPort } from "./codeOperationService";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { buildDenyDefaultSeatbeltProfile } from "../process/seatbeltProfile";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
};

async function runGit(args: readonly string[]) {
  return execFileAsync("git", args, { encoding: "utf8", env: gitEnv, shell: false });
}

async function initCommitRepo(dir: string, branch = "main", fileName = "README.md") {
  await mkdir(dir, { recursive: true });
  await runGit(["init", "-b", branch, dir]);
  await runGit(["-C", dir, "config", "user.name", "Octant Test"]);
  await runGit(["-C", dir, "config", "user.email", "test@octant.local"]);
  await writeFile(join(dir, fileName), "initial\n", "utf8");
  await runGit(["-C", dir, "add", fileName]);
  await runGit(["-C", dir, "commit", "-m", "initial"]);
  return await realpath(dir);
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return await realpath(dir);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const IDS = {
  project: decodeProjectId("10000000-0000-4000-8000-000000000001"),
  revision: decodeBindingRevisionId("10000000-0000-4000-8000-000000000002"),
  window: decodeWindowId("10000000-0000-4000-8000-000000000003"),
  thread: decodeCodeThreadId("10000000-0000-4000-8000-000000000004"),
  provider: decodeProviderInstanceId("10000000-0000-4000-8000-000000000005"),
  model: decodeProviderModelId("test-model"),
};

function makeCodeProject(canonicalRoot: string, extraFolders: ReadonlyArray<string> = []) {
  return decodeProject({
    id: IDS.project,
    type: "code",
    name: "Multi-repo workspace",
    pinned: false,
    rank: "1/1",
    lifecycle: "active",
    binding: { canonicalRoot },
    bindingHistory: [
      {
        revision: 1,
        revisionId: IDS.revision,
        currentBinding: { canonicalRoot },
        actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" },
        changedAt: "2026-11-28T10:00:00.000Z",
      },
    ],
    codeAccessPersistence: "current-session",
    ...(extraFolders.length === 0
      ? {}
      : {
          extraFolders: extraFolders.map((folder, index) => ({
            canonicalRoot: folder,
            addedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" },
            addedAt: "2026-11-28T10:01:00.000Z",
            addedRevision: index + 2,
          })),
        }),
    version: extraFolders.length + 1,
    createdAt: "2026-11-28T10:00:00.000Z",
    updatedAt: "2026-11-28T10:00:00.000Z",
  });
}

function makeCodeProjectSummary(project: ReturnType<typeof makeCodeProject>): ProjectSummary {
  if (project.type !== "code") throw new Error("expected code project");
  return {
    id: project.id,
    type: "code",
    name: project.name,
    pinned: project.pinned,
    rank: project.rank,
    lifecycle: project.lifecycle,
    binding: project.binding,
    bindingRevisionId: IDS.revision,
    codeAccessPersistence: project.codeAccessPersistence,
    ...(project.extraFolders === undefined ? {} : { extraFolders: project.extraFolders }),
    version: project.version,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function gitOpId(value: string): CodeGitOperationId {
  return value as CodeGitOperationId;
}

describe("project repository discovery", () => {
  it("discovers repositories one to two levels down while skipping hidden, dependency, symlink, linked worktree, and deeper folders", async () => {
    const fakeHome = await makeTempDir("octant-discovery-home-");
    const workspace = join(fakeHome, "workspace");
    const repoA = await initCommitRepo(join(workspace, "repo-a"), "main");
    const repoB = await initCommitRepo(join(workspace, "services", "repo-b"), "develop");
    // Depth 3 must be skipped.
    await initCommitRepo(join(workspace, "a", "b", "too-deep"), "main");
    // Hidden and dependency folders must be skipped.
    await initCommitRepo(join(workspace, ".hidden-repo"), "main");
    await initCommitRepo(join(workspace, "node_modules", "dep-repo"), "main");
    // Symlink to an external repo must never be followed.
    const outsideRepo = await initCommitRepo(join(fakeHome, "outside-repo"), "main");
    await symlink(outsideRepo, join(workspace, "linked-dir"));
    // Nested linked worktree must be skipped.
    await runGit([
      "-C",
      repoA,
      "worktree",
      "add",
      "-b",
      "wt-branch",
      join(workspace, "repo-a-wt"),
      "HEAD",
    ]);

    const ports = createManagedWorktreeNodePorts();
    const result = await discoverProjectRepositories(
      {
        projectId: IDS.project,
        bindingRevisionId: IDS.revision,
        mainRoot: await realpath(workspace),
        extraFolders: [],
        homeDirectory: fakeHome,
        strict: false,
      },
      { repository: ports.repository },
    );

    expect(result.truncated).toBe(false);
    expect(result.repositories.map((repo) => repo.canonicalRoot)).toEqual([repoA, repoB]);
    expect(result.repositories.map((repo) => repo.name)).toEqual(["repo-a", "services/repo-b"]);
    expect(result.repositories.every((repo) => repo.source === "nested")).toBe(true);
  });

  it("reads committed submodules under their parent repository without promoting them as standalone repositories", async () => {
    const fakeHome = await makeTempDir("octant-discovery-sub-");
    const subOrigin = await initCommitRepo(join(fakeHome, "sub-origin"), "main");
    const parent = await initCommitRepo(join(fakeHome, "parent"), "main");
    await runGit([
      "-C",
      parent,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      subOrigin,
      "libs/sub",
    ]);
    await runGit([
      "-C",
      parent,
      "-c",
      "user.name=Octant Test",
      "-c",
      "user.email=test@octant.local",
      "commit",
      "-m",
      "add submodule",
    ]);

    const ports = createManagedWorktreeNodePorts();
    const result = await discoverProjectRepositories(
      {
        projectId: IDS.project,
        bindingRevisionId: IDS.revision,
        mainRoot: parent,
        extraFolders: [],
        homeDirectory: fakeHome,
        strict: false,
      },
      { repository: ports.repository },
    );

    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]?.canonicalRoot).toBe(parent);
    expect(result.repositories[0]?.submodules).toEqual([
      { name: "libs/sub", path: "libs/sub", initialized: true },
    ]);
  });

  it("parses .code-workspace files as data and judges outside paths with extraFolderRefusal", async () => {
    const fakeHome = await makeTempDir("octant-discovery-ws-");
    const mainDir = await initCommitRepo(join(fakeHome, "main-app"), "main");
    const siblingDir = await initCommitRepo(join(fakeHome, "shared-lib"), "main");
    const sshDir = join(fakeHome, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const symlinkTarget = await initCommitRepo(join(fakeHome, "real-target"), "main");
    const symlinkEntry = join(fakeHome, "sym-lib");
    await symlink(symlinkTarget, symlinkEntry);

    await writeFile(
      join(mainDir, "stack.code-workspace"),
      `{
        // workspace folders
        "folders": [
          { "path": ".", "name": "Main" },
          { "path": "../shared-lib", "name": "Shared Lib" },
          { "path": "../.ssh", "name": "Keys" },
          { "path": "../sym-lib", "name": "Symlink Lib" },
          { "path": "../does-not-exist", "name": "Missing" },
        ]
      }`,
      "utf8",
    );

    const ports = createManagedWorktreeNodePorts();
    const result = await discoverProjectRepositories(
      {
        projectId: IDS.project,
        bindingRevisionId: IDS.revision,
        mainRoot: mainDir,
        extraFolders: [],
        homeDirectory: fakeHome,
        strict: false,
      },
      { repository: ports.repository },
    );

    // Discovery never grants authority to outside workspace folders.
    expect(result.repositories.map((repo) => repo.canonicalRoot)).toEqual([mainDir]);
    expect(result.workspaceFolders).toEqual([
      expect.objectContaining({ name: "Main", path: mainDir, status: "already-included" }),
      expect.objectContaining({ name: "Shared Lib", path: siblingDir, status: "available" }),
      expect.objectContaining({
        name: "Keys",
        status: "refused",
        reason: expect.stringMatching(/keys or credentials/i),
      }),
      expect.objectContaining({
        name: "Symlink Lib",
        status: "refused",
        reason: expect.stringMatching(/symbolic link/i),
      }),
      expect.objectContaining({
        name: "Missing",
        status: "refused",
        reason: expect.stringMatching(/does not exist/i),
      }),
    ]);
  });

  it("caps discovery at 16 repositories and marks the result truncated", async () => {
    const fakeHome = await makeTempDir("octant-discovery-cap-");
    const workspace = join(fakeHome, "many");
    await mkdir(workspace, { recursive: true });
    for (let index = 0; index < 17; index += 1) {
      await initCommitRepo(join(workspace, `repo-${String(index).padStart(2, "0")}`), "main");
    }

    const ports = createManagedWorktreeNodePorts();
    const result = await discoverProjectRepositories(
      {
        projectId: IDS.project,
        bindingRevisionId: IDS.revision,
        mainRoot: await realpath(workspace),
        extraFolders: [],
        homeDirectory: fakeHome,
        strict: false,
      },
      { repository: ports.repository },
    );

    expect(result.repositories).toHaveLength(16);
    expect(result.truncated).toBe(true);
  });

  it("parses committed .gitmodules and .code-workspace JSONC safely", () => {
    expect(
      parseCommittedGitModules(`
        [submodule "good"]
          path = libs/good
        [submodule "traversal"]
          path = ../escape
        [submodule "absolute"]
          path = /etc/passwd
      `),
    ).toEqual([{ name: "good", path: "libs/good" }]);

    expect(
      parseCodeWorkspaceJson(`{
        /* block comment */
        "folders": [
          { "path": "../api", "name": "API" }, // trailing comma
        ],
      }`),
    ).toEqual([{ path: "../api", name: "API" }]);
  });
});

describe("plain-folder binding, checkout reachability, and per-repository Git isolation", () => {
  it("allows binding a plain folder holding repositories even while requireGitRepository is on, and keeps single-repo projects unchanged", async () => {
    const fakeHome = await makeTempDir("octant-plain-binding-");
    const workspace = join(fakeHome, "multi");
    const repoA = await initCommitRepo(join(workspace, "repo-a"), "main");
    const repoB = await initCommitRepo(join(workspace, "repo-b"), "main");
    const emptyPlain = join(fakeHome, "empty-plain");
    await mkdir(emptyPlain, { recursive: true });
    const singleRepo = await initCommitRepo(join(fakeHome, "single-repo"), "main");

    const ports = createManagedWorktreeNodePorts();
    const observeProject = async (canonicalRoot: string) => {
      const project = makeCodeProject(await realpath(canonicalRoot));
      const observer = createExistingWorktreeCodeCheckoutObservation({
        projects: {
          bootstrap: async () => ({
            active: [makeCodeProjectSummary(project)],
            archived: [],
            availability: [],
            memory: [],
          }),
        },
        readProject: () => project,
        repository: ports.repository,
        clock: () => "2026-11-28T10:00:00.000Z",
        requireGitRepository: () => true,
        homeDirectory: () => fakeHome,
      });
      return observer.observe(IDS.window, IDS.project);
    };

    const multiObserved = await observeProject(workspace);
    expect(multiObserved.checkout.kind).toBe("plain-folder");
    expect(multiObserved.linkedCheckouts?.map((entry) => entry.label)).toEqual([
      "repo-a",
      "repo-b",
    ]);

    // Empty plain folder is still refused when requireGitRepository is true.
    await expect(observeProject(emptyPlain)).rejects.toThrow(/not a Git repository/i);

    // Single-repo Project emits NO linkedCheckouts field at all.
    const singleObserved = await observeProject(singleRepo);
    expect(singleObserved.checkout.kind).toBe("existing-worktree");
    expect(singleObserved).not.toHaveProperty("linkedCheckouts");
    expect(repoA).toBeTruthy();
    expect(repoB).toBeTruthy();
  });

  it("commits in repo A without staging or altering repo B, and refuses unreachable checkouts and primary-only operations on linked checkouts", async () => {
    const fakeHome = await makeTempDir("octant-multi-git-");
    const workspace = join(fakeHome, "suite");
    const repoA = await initCommitRepo(join(workspace, "repo-a"), "main", "a.txt");
    const repoB = await initCommitRepo(join(workspace, "repo-b"), "main", "b.txt");
    const canonicalWorkspace = await realpath(workspace);

    const project = makeCodeProject(canonicalWorkspace);
    const ports = createManagedWorktreeNodePorts();
    const observer = createExistingWorktreeCodeCheckoutObservation({
      projects: {
        bootstrap: async () => ({
          active: [makeCodeProjectSummary(project)],
          archived: [],
          availability: [],
          memory: [],
        }),
      },
      readProject: () => project,
      repository: ports.repository,
      clock: () => "2026-11-28T10:00:00.000Z",
      requireGitRepository: () => true,
      homeDirectory: () => fakeHome,
    });
    const prepared = await observer.observe(IDS.window, IDS.project);
    const linked = prepared.linkedCheckouts ?? [];
    expect(linked).toHaveLength(2);
    const checkoutA = linked[0]!.checkout;
    const checkoutB = linked[1]!.checkout;

    const thread = decodeCodeThread({
      id: IDS.thread,
      projectId: IDS.project,
      bindingRevisionId: prepared.bindingRevisionId,
      repositoryId: prepared.checkout.repositoryId,
      checkoutId: prepared.checkout.id,
      linkedCheckouts: linked.map((entry) => ({
        checkoutId: entry.checkout.id,
        repositoryId: entry.checkout.repositoryId,
        label: entry.label,
      })),
      title: "Multi-repo task",
      lifecycle: "active",
      providerInstanceId: IDS.provider,
      modelId: IDS.model,
      executionPolicy: "full-access",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "main",
        remoteName: "origin",
        proposedBaseRepository: "local/suite",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: "2026-11-28T10:00:00.000Z",
      },
      version: 1,
      createdAt: "2026-11-28T10:00:00.000Z",
      updatedAt: "2026-11-28T10:00:00.000Z",
    });

    const roots = createExistingWorktreeCodeFileRootAuthority({
      projects: {
        bootstrap: async () => ({
          active: [makeCodeProjectSummary(project)],
          archived: [],
          availability: [],
          memory: [],
        }),
      },
      readProject: () => project,
      repository: ports.repository,
      statIdentity: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        return { device: metadata.dev.toString(10), inode: metadata.ino.toString(10) };
      },
    });

    const checkoutsById = new Map<string, CodeCheckoutIdentity>([
      [String(prepared.checkout.id), prepared.checkout],
      [String(checkoutA.id), checkoutA],
      [String(checkoutB.id), checkoutB],
    ]);

    const evidenceMap = new Map<string, string>();
    let evidenceCounter = 1;
    const evidence = {
      put: vi.fn((content: string) => {
        const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(evidenceCounter++).padStart(12, "0")}`;
        evidenceMap.set(id, content);
        return decodeCodeEvidenceReference({
          contentId: id,
          digest: "a".repeat(64),
          byteLength: Buffer.byteLength(content),
        });
      }),
      read: vi.fn(
        async (ref: { readonly contentId: string }) => evidenceMap.get(ref.contentId) ?? "",
      ),
    };
    const events = {
      replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
      summaryForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
    };
    const fakeConfinement = createFakeSandboxConfinement();
    tempRoots.push(fakeConfinement.root);
    const gitOptions = {
      confinement: fakeConfinement.confinement,
      temporaryDirectory: fakeConfinement.temporaryDirectory,
      gitExecutable: "/usr/bin/git",
    };
    const git = new GitService(
      new GitObservationPort(gitOptions),
      new GitMutationPort(undefined, gitOptions),
    );
    const gitPort: CodeOperationGitPort = {
      observe: async ({ checkoutRoot, maxDiffBytes }) => {
        const observed = await git.observe(checkoutRoot);
        if (observed.status !== "ready") return { status: "unavailable" };
        return {
          status: "ready",
          head: observed.head,
          stateToken: observed.stateToken,
          statusEntries: observed.statusEntries,
          changedPaths: observed.changedPaths,
          diff: observed.diff.text.slice(0, maxDiffBytes),
          diffTruncated: observed.diff.truncated,
          remotes: observed.remotes.map((r) => ({
            name: r.name,
            fetch: { kind: "network" as const, url: r.fetchUrl },
            push: { kind: "network" as const, url: r.pushUrl },
          })),
          upstream: observed.upstream,
          worktrees: [],
        };
      },
      stage: async (input) => (await git.stage(input)) as never,
      unstage: async (input) => (await git.unstage(input)) as never,
      discard: async (input) => (await git.discard(input)) as never,
      commit: async (input) =>
        (await git.commit({
          ...input,
          stagedSummary: input.stagedSummary.map((entry) => ({
            path: entry.path,
            index: entry.index,
            worktree: entry.worktree,
            ...(entry.originalPath === undefined ? {} : { originalPath: entry.originalPath }),
          })),
        })) as never,
      push: async (input) => (await git.push(input)) as never,
    };

    const service = new CodeOperationService({
      authority: {
        canAccessProject: async () => true,
        readThread: (id) => (String(id) === String(thread.id) ? thread : undefined),
        readCheckout: (id) => checkoutsById.get(String(id)),
        resolveCheckoutRoot: async (windowId, currentThread, currentCheckout, signal) => {
          const resolved = await roots.resolve(
            windowId,
            currentThread,
            currentCheckout,
            decodeCodeRelativePath("README.md"),
            signal,
          );
          if (resolved === undefined) return undefined;
          return {
            checkoutRoot: resolved.rootPath,
            rootIdentity: resolved.rootIdentity,
            shell: "/bin/sh",
            credentialReferences: [],
            environment: {},
          };
        },
      },
      events,
      evidence,
      turns: {
        start: async () => ({ state: "running" }),
        cancel: async () => ({ state: "interrupted" }),
        answerApproval: async () => ({ state: "running" }),
        answerInput: async () => ({ state: "running" }),
      },
      terminals: {
        launch: async () => {
          throw new Error("unused");
        },
        attach: () => {
          throw new Error("unused");
        },
        write: () => {},
        resize: () => {},
        terminate: async () => {
          throw new Error("unused");
        },
      },
      repositoryTests: {
        discover: async () => [],
        run: async () => {
          throw new Error("unused");
        },
        cancel: async () => true,
      },
      git: gitPort,
      reviewFindings: { create: vi.fn(), changeState: vi.fn() },
      pullRequests: {
        ensure: async () => ({ status: "unavailable" }),
        observeReview: async () => ({ status: "unavailable" }),
      },
    });

    // Modify files in BOTH repo A and repo B.
    await writeFile(join(repoA, "a.txt"), "edited in repo A\n", "utf8");
    await writeFile(join(repoB, "b.txt"), "edited in repo B\n", "utf8");

    // Observe repo A.
    const observedA = await service.execute(IDS.window, {
      kind: "observe-git",
      operationId: decodeCodeOperationId("20000000-0000-4000-8000-000000000001"),
      gitOperationId: gitOpId("20000000-0000-4000-8000-000000000002"),
      threadId: thread.id,
      checkoutId: checkoutA.id,
      maxDiffBytes: 64 * 1024,
    });
    expect(observedA.kind).toBe("git-observed");
    if (observedA.kind !== "git-observed") throw new Error("expected git-observed");
    expect(observedA.changedPaths).toEqual(["a.txt"]);

    // Stage & commit in repo A.
    const stagedA = await service.execute(IDS.window, {
      kind: "stage-git",
      operationId: decodeCodeOperationId("20000000-0000-4000-8000-000000000003"),
      gitOperationId: gitOpId("20000000-0000-4000-8000-000000000004"),
      threadId: thread.id,
      checkoutId: checkoutA.id,
      paths: [decodeCodeRelativePath("a.txt")],
      expectedStateToken: observedA.stateToken,
    });
    expect(stagedA).toMatchObject({ kind: "git-mutation-state", state: "completed" });

    const observedAAfterStage = await service.execute(IDS.window, {
      kind: "observe-git",
      operationId: decodeCodeOperationId("20000000-0000-4000-8000-000000000005"),
      gitOperationId: gitOpId("20000000-0000-4000-8000-000000000006"),
      threadId: thread.id,
      checkoutId: checkoutA.id,
      maxDiffBytes: 64 * 1024,
    });
    if (observedAAfterStage.kind !== "git-observed") throw new Error("expected git-observed");

    const stagedEntriesA = observedAAfterStage.status.filter((entry) => entry.index !== " ");
    expect(stagedEntriesA.length).toBeGreaterThan(0);
    const committedA = await service.execute(IDS.window, {
      kind: "commit-git",
      operationId: decodeCodeOperationId("20000000-0000-4000-8000-000000000007"),
      gitOperationId: gitOpId("20000000-0000-4000-8000-000000000008"),
      threadId: thread.id,
      checkoutId: checkoutA.id,
      message: "Commit only in repo A",
      expectedStateToken: observedAAfterStage.stateToken,
      stagedSummary: stagedEntriesA as never,
    });
    expect(committedA).toMatchObject({ kind: "git-mutation-state", state: "completed" });

    // Repo B's index and working tree must be completely untouched.
    const observedB = await service.execute(IDS.window, {
      kind: "observe-git",
      operationId: decodeCodeOperationId("20000000-0000-4000-8000-000000000009"),
      gitOperationId: gitOpId("20000000-0000-4000-8000-000000000010"),
      threadId: thread.id,
      checkoutId: checkoutB.id,
      maxDiffBytes: 64 * 1024,
    });
    expect(observedB.kind).toBe("git-observed");
    if (observedB.kind !== "git-observed") throw new Error("expected git-observed");
    expect(observedB.status).toEqual([
      expect.objectContaining({ path: "b.txt", index: " ", worktree: "M" }),
    ]);

    // An unreachable checkout is refused.
    const unreachable = await service.execute(IDS.window, {
      kind: "observe-git",
      operationId: decodeCodeOperationId("20000000-0000-4000-8000-000000000011"),
      gitOperationId: gitOpId("20000000-0000-4000-8000-000000000012"),
      threadId: thread.id,
      checkoutId: decodeCodeCheckoutId("99999999-0000-4000-8000-000000000099"),
      maxDiffBytes: 64 * 1024,
    });
    expect(unreachable).toMatchObject({
      kind: "operation-failed",
      failure: { category: "invalid" },
    });

    // Primary-only operations (like starting a provider turn) refuse linked checkouts.
    const promptEvidence = evidence.put("hello");
    const turnOnLinked = await service.execute(IDS.window, {
      kind: "start-provider-turn",
      operationId: decodeCodeOperationId("20000000-0000-4000-8000-000000000013"),
      threadId: thread.id,
      checkoutId: checkoutA.id,
      sessionId: decodeProviderSessionId("20000000-0000-4000-8000-000000000014"),
      prompt: promptEvidence,
    });
    expect(turnOnLinked).toMatchObject({
      kind: "operation-failed",
      failure: { category: "invalid" },
    });
  });

  it("confines multi-repository turns to the granted main folder and extra folders while denying paths outside them", async () => {
    const fakeHome = await makeTempDir("octant-confinement-");
    const mainWorkspace = join(fakeHome, "suite");
    const extraRepo = await initCommitRepo(join(fakeHome, "extra-repo"), "main");
    await initCommitRepo(join(mainWorkspace, "repo-a"), "main");
    const outsideSibling = join(fakeHome, "unrelated-sibling");
    await mkdir(outsideSibling, { recursive: true });
    const tempDir = await makeTempDir("octant-confinement-tmp-");

    const canonicalMain = await realpath(mainWorkspace);
    const canonicalOutside = await realpath(outsideSibling);
    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: canonicalMain,
      extraBoundRoots: [extraRepo],
      temporaryDirectory: tempDir,
      networkEgress: "none",
    });

    expect(profile).toContain(`(allow file-write* (subpath "${canonicalMain}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${extraRepo}"))`);
    expect(profile).not.toContain(`(allow file-write* (subpath "${canonicalOutside}"))`);
    expect(profile).not.toContain(`(allow file-read* (subpath "${canonicalOutside}"))`);
  });

  it("groups multi-repository changed files while leaving single-repository changed files unchanged", () => {
    const single = turnChangedFiles([
      { path: "src/index.ts", insertions: 3, deletions: 1, binary: false },
    ]);
    expect(single).toEqual({
      files: [{ path: "src/index.ts", insertions: 3, deletions: 1 }],
      total: 1,
      truncated: false,
    });
    expect(single?.files[0]).not.toHaveProperty("repository");
    expect(single?.files[0]).not.toHaveProperty("checkoutId");

    const checkoutA = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001");
    const checkoutB = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000002");
    const multi = turnChangedFilesAcrossRepositories([
      {
        repository: "repo-a",
        checkoutId: checkoutA,
        changes: [{ path: "src/a.ts", insertions: 4, deletions: 0, binary: false }],
      },
      {
        repository: "repo-b",
        checkoutId: checkoutB,
        changes: [{ path: "src/b.ts", insertions: 2, deletions: 1, binary: false }],
      },
    ]);
    expect(multi).toEqual({
      files: [
        {
          path: "src/a.ts",
          insertions: 4,
          deletions: 0,
          repository: "repo-a",
          checkoutId: checkoutA,
        },
        {
          path: "src/b.ts",
          insertions: 2,
          deletions: 1,
          repository: "repo-b",
          checkoutId: checkoutB,
        },
      ],
      total: 2,
      truncated: false,
    });
  });

  it("revokes linked checkout root resolution when its owning extra folder is removed from the Project", async () => {
    const fakeHome = await makeTempDir("octant-extra-revoke-");
    const mainRepo = await initCommitRepo(join(fakeHome, "main-repo"), "main");
    const extraRepo = await initCommitRepo(join(fakeHome, "extra-repo"), "main");

    let currentProject = makeCodeProject(mainRepo, [extraRepo]);
    const ports = createManagedWorktreeNodePorts();
    const observer = createExistingWorktreeCodeCheckoutObservation({
      projects: {
        bootstrap: async () => ({
          active: [makeCodeProjectSummary(currentProject)],
          archived: [],
          availability: [],
          memory: [],
        }),
      },
      readProject: () => currentProject,
      repository: ports.repository,
      clock: () => "2026-11-28T10:00:00.000Z",
      requireGitRepository: () => true,
      homeDirectory: () => fakeHome,
    });
    const prepared = await observer.observe(IDS.window, IDS.project);
    const linkedExtra = prepared.linkedCheckouts?.[0];
    expect(linkedExtra?.label).toBe("extra-repo");
    if (linkedExtra === undefined) throw new Error("expected linked extra checkout");

    const thread = decodeCodeThread({
      id: IDS.thread,
      projectId: IDS.project,
      bindingRevisionId: prepared.bindingRevisionId,
      repositoryId: prepared.checkout.repositoryId,
      checkoutId: prepared.checkout.id,
      linkedCheckouts: [
        {
          checkoutId: linkedExtra.checkout.id,
          repositoryId: linkedExtra.checkout.repositoryId,
          label: linkedExtra.label,
        },
      ],
      title: "Extra repo task",
      lifecycle: "active",
      providerInstanceId: IDS.provider,
      modelId: IDS.model,
      executionPolicy: "full-access",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "main",
        remoteName: "origin",
        proposedBaseRepository: "local/main-repo",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: "2026-11-28T10:00:00.000Z",
      },
      version: 1,
      createdAt: "2026-11-28T10:00:00.000Z",
      updatedAt: "2026-11-28T10:00:00.000Z",
    });

    const roots = createExistingWorktreeCodeFileRootAuthority({
      projects: {
        bootstrap: async () => ({
          active: [makeCodeProjectSummary(currentProject)],
          archived: [],
          availability: [],
          memory: [],
        }),
      },
      readProject: () => currentProject,
      repository: ports.repository,
      currentIdentity: (path) => {
        // Keep proof simple for test; stat identity checked below.
        return { canonicalPath: path, device: "1", inode: "1" };
      },
      statIdentity: async () => ({ device: "1", inode: "1" }),
    });

    const resolvedBefore = await roots.resolve(
      IDS.window,
      thread,
      linkedExtra.checkout,
      decodeCodeRelativePath("README.md"),
    );
    expect(resolvedBefore?.rootPath).toBe(extraRepo);
    expect(resolvedBefore?.current?.()).toBe(true);

    // Removing the extra folder revokes both live proof and fresh resolution.
    currentProject = makeCodeProject(mainRepo, []);
    expect(resolvedBefore?.current?.()).toBe(false);
    const resolvedAfter = await roots.resolve(
      IDS.window,
      thread,
      linkedExtra.checkout,
      decodeCodeRelativePath("README.md"),
    );
    expect(resolvedAfter).toBeUndefined();
    expect(decodeCodeRepositoryId(linkedExtra.checkout.repositoryId)).toBe(
      linkedExtra.checkout.repositoryId,
    );
  });
});
