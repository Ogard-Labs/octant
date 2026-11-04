import {
  cpSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeEvidenceContentId,
  decodeCodeOperationEventFrame,
  decodeCodeOperationId,
  decodeCodeRelativePath,
  decodeCodeThread,
  decodeWindowId,
  type CodeOperationEventFrame,
} from "@octant/contracts";
import { createExistingWorktreeCodeFileRootAuthority } from "../wiring/code";
import { CodeProjectAccess } from "../codeProjectAccess";
import { createCodeRouteHandler } from "../codeRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { CodeOperationService, type CodeOperationServiceOptions } from "./codeOperationService";
import type { GitObservation } from "./gitObservationPort";
import { GitMutationPort } from "./gitMutationPort";
import { GitService } from "./gitService";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-08-18T09:00:00.000Z";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId(id(1));
const nativeRepositoryId: `repo_${string}` = `repo_${"a".repeat(64)}`;
const source = decodeCodeThread({
  id: id(2),
  projectId: id(3),
  bindingRevisionId: id(4),
  repositoryId: nativeRepositoryId,
  checkoutId: id(5),
  title: "Hunk owner",
  lifecycle: "active",
  providerInstanceId: id(6),
  modelId: "model",
  executionPolicy: "full-access",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/hunks",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "main",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const checkout = decodeCodeCheckoutIdentity({
  id: source.checkoutId,
  repositoryId: source.repositoryId,
  kind: "managed-worktree",
  availability: "available",
  head: { kind: "branch", name: "feature/hunks", oid: "a".repeat(40) },
  ownershipReceiptId: id(7),
  observedAt: now,
});
const patch =
  "diff --git a/file.txt b/file.txt\nindex " +
  "a".repeat(40) +
  ".." +
  "b".repeat(40) +
  " 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";

function harness() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-hunk-admission-")));
  directories.push(directory);
  const repositoryRoot = join(directory, "repository");
  const worktreeRoot = join(directory, "worktree");
  mkdirSync(repositoryRoot);
  mkdirSync(worktreeRoot);
  writeFileSync(join(worktreeRoot, "file.txt"), "new\n");
  let afterEffect: (() => void) | undefined;
  let effectOutcome = "completed";
  let bindingRevision: string = source.bindingRevisionId;
  let activeThread = source;
  let windowLive = true;
  let otherWriter = false;
  const roots = createExistingWorktreeCodeFileRootAuthority({
    projects: {
      bootstrap: async () =>
        ({
          active: [
            { id: source.projectId, type: "code", binding: { canonicalRoot: repositoryRoot } },
          ],
          archived: [],
          availability: [],
          memory: [],
        }) as never,
    },
    readProject: () =>
      ({
        id: source.projectId,
        type: "code",
        lifecycle: "active",
        binding: { canonicalRoot: repositoryRoot },
        bindingHistory: [
          { revisionId: bindingRevision, currentBinding: { canonicalRoot: repositoryRoot } },
        ],
      }) as never,
    managedReceipts: {
      load: async () =>
        ({
          receiptId: id(7),
          state: "ready",
          threadId: source.id,
          checkoutId: source.checkoutId,
          repositoryId: source.repositoryId,
          canonicalRepositoryPath: repositoryRoot,
          canonicalWorktreePath: worktreeRoot,
        }) as never,
    },
    repository: {
      observe: async () => ({
        status: "available",
        repositoryId: nativeRepositoryId,
        repositoryRoot,
        commonDirectory: join(repositoryRoot, ".git"),
        objectDirectory: join(repositoryRoot, ".git/objects"),
        checkout: {
          status: "present",
          canonicalPath: repositoryRoot,
          reportedPath: repositoryRoot,
          head: "a".repeat(40),
          detached: false,
          branch: "refs/heads/main",
        },
        worktrees: [
          {
            status: "present",
            canonicalPath: worktreeRoot,
            reportedPath: worktreeRoot,
            head: "a".repeat(40),
            detached: false,
            branch: "refs/heads/feature/hunks",
          },
        ],
      }),
    },
    currentIdentity: (path) => {
      const stat = lstatSync(path);
      return {
        canonicalPath: realpathSync(path),
        device: String(stat.dev),
        inode: String(stat.ino),
      };
    },
    statIdentity: async (path) => {
      const stat = lstatSync(path);
      return { device: String(stat.dev), inode: String(stat.ino) };
    },
  });
  const access = new CodeProjectAccess({
    readWorkspace: () => ({ contextByMode: { code: { projectId: source.projectId } } }) as never,
    hasActiveCodeProject: () => true,
    isWindowLive: () => windowLive,
  });
  const checked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holdCheck = false;
  const effects = vi.fn();
  const native = new GitMutationPort(
    {
      pathExists: async () => false,
      execFile: async (_file, args) => {
        if (args.includes("rev-parse"))
          return { exitCode: 0, stdout: join(worktreeRoot, ".git/index.lock"), stderr: "" };
        if (args.includes("--check")) {
          if (holdCheck) {
            checked.resolve();
            await release.promise;
          }
        } else if (args.includes("apply")) {
          effects();
          afterEffect?.();
          if (effectOutcome === "throw") throw Error("private file contents");
          if (effectOutcome === "failed")
            return { exitCode: 1, stdout: "", stderr: "private file contents" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    { onServer: true },
  );
  const observation: GitObservation = {
    status: "ready",
    checkoutRoot: worktreeRoot,
    head: { kind: "branch", name: "feature/hunks", oid: "a".repeat(40) },
    statusEntries: [{ path: "file.txt", index: " ", worktree: "M" }],
    changedPaths: ["file.txt"],
    stagedSummary: [],
    diff: { text: patch, byteLength: Buffer.byteLength(patch), truncated: false },
    remotes: [],
    upstream: null,
    worktrees: [],
    stateToken: "c".repeat(64),
    insertions: 1,
    deletions: 1,
  };
  const observe = vi.fn(async () => observation);
  const serviceGit = new GitService(
    {
      observe,
      readDiff: async () => ({ status: "ready", paths: ["file.txt"], diff: observation.diff }),
    },
    native,
  );
  const frames: CodeOperationEventFrame[] = [];
  const append = vi.fn((input: Parameters<CodeOperationServiceOptions["events"]["append"]>[0]) => {
    frames.push(
      decodeCodeOperationEventFrame({
        threadId: input.threadId,
        operationId: input.operationId,
        event: input.event,
        cursor: input.expectedCursor + 1,
        occurredAt: now,
      }),
    );
  });
  const evidence = {
    put: vi.fn((text: string) =>
      decodeCodeEvidenceReference({
        contentId: id(8),
        digest: "d".repeat(64),
        byteLength: Buffer.byteLength(text),
      }),
    ),
    read: vi.fn(async () => patch),
  };
  const unused = vi.fn(() => {
    throw new Error("Unexpected unused hunk fixture port.");
  });
  const serviceOptions: CodeOperationServiceOptions = {
    authority: {
      readThread: () => activeThread,
      readCheckout: () => checkout,
      canAccessProject: () => access.canAccessProject(windowId, source.projectId),
      currentProjectAccess: () =>
        access.standingAuthority(() => access.canAccessProject(windowId, source.projectId)),
      resolveCheckoutRoot: async () => {
        const root = await roots.resolve(
          windowId,
          activeThread,
          checkout,
          decodeCodeRelativePath("file.txt"),
        );
        return root === undefined
          ? undefined
          : {
              checkoutRoot: root.rootPath,
              ...(root.current === undefined ? {} : { rootCurrent: root.current }),
              rootIdentity: root.rootIdentity,
              shell: "/bin/sh",
              credentialReferences: [],
              environment: {},
            };
      },
    },
    git: {
      observe: unused,
      stage: unused,
      unstage: unused,
      discard: unused,
      commit: unused,
      push: unused,
      prepareHunks: (input) => serviceGit.prepareHunks(input),
      applyHunks: (input) => serviceGit.applyHunks(input),
    },
    approvals: { validate: async () => true },
    evidence,
    events: {
      historyForThread: (threadId) => ({
        status: "ok",
        frames: frames.filter((frame) => frame.threadId === threadId),
      }),
      append,
      replay: (input) => {
        const result = frames.filter(
          (frame) =>
            frame.threadId === input.threadId &&
            frame.operationId === input.operationId &&
            frame.cursor > input.afterCursor,
        );
        return { status: "ok", frames: result, nextCursor: result.at(-1)?.cursor ?? 0 };
      },
    },
    turns: {
      start: unused,
      answerInput: unused,
      answerApproval: unused,
      cancel: unused,
      holdsTurn: () => false,
      threadsWritingIn: () =>
        otherWriter ? [decodeCodeThread({ ...source, id: id(12), title: "Other writer" })] : [],
    },
    terminals: { launch: unused, attach: unused, write: unused, resize: unused, terminate: unused },
    repositoryTests: { discover: unused, run: unused, cancel: unused },
    pullRequests: { ensure: unused, observeReview: unused },
    reviewFindings: { create: unused, changeState: unused },
  };
  const service = new CodeOperationService(serviceOptions);
  const prepare = (operation = 9) =>
    service.execute(
      windowId,
      {
        kind: "prepare-git-hunks",
        operationId: id(operation),
        threadId: source.id,
        checkoutId: checkout.id,
        gitOperationId: id(10),
        scope: "unstaged",
      },
      { initiator: "user", admissionCurrent: () => windowLive },
    );
  return {
    service,
    restart: () => new CodeOperationService(serviceOptions),
    prepare,
    frames,
    append,
    evidence,
    observe,
    effects,
    checked,
    release,
    hold: () => {
      holdCheck = true;
    },
    rebind: () => {
      bindingRevision = id(11);
    },
    replaceRoot: () => {
      renameSync(worktreeRoot, join(directory, "retired"));
      cpSync(join(directory, "retired"), worktreeRoot, { recursive: true });
      expect(readFileSync(join(worktreeRoot, "file.txt"))).toEqual(
        readFileSync(join(directory, "retired/file.txt")),
      );
    },
    retireAfterEffect: (outcome = "completed") => {
      effectOutcome = outcome;
      afterEffect = () => {
        windowLive = false;
      };
    },
    restoreWindow: () => {
      windowLive = true;
    },
    revoke: () => {
      windowLive = false;
    },
    startWriter: () => {
      otherWriter = true;
    },
    changeModel: () => {
      activeThread = decodeCodeThread({ ...activeThread, modelId: "changed", version: 2 });
    },
  };
}

it.each(["binding", "physical root", "window", "model", "writer"])(
  "refuses queued reversal after %s changes during native preflight",
  async (change) => {
    const h = harness();
    const comparison = await h.prepare();
    expect(comparison.kind).toBe("git-hunks");
    if (comparison.kind !== "git-hunks") throw Error("No comparison");
    h.hold();
    const applying = h.service.execute(
      windowId,
      {
        kind: "reverse-git-hunks",
        operationId: id(20),
        threadId: source.id,
        checkoutId: checkout.id,
        gitOperationId: id(21),
        comparisonOperationId: comparison.operationId,
        selected: [comparison.hunks[0]!.id],
      },
      { initiator: "user", admissionCurrent: () => true },
    );
    await h.checked.promise;
    if (change === "binding") h.rebind();
    else if (change === "physical root") h.replaceRoot();
    else if (change === "window") h.revoke();
    else if (change === "model") h.changeModel();
    else h.startWriter();
    h.release.resolve();
    const result = await applying;
    expect(h.effects).not.toHaveBeenCalled();
    expect(
      result.kind === "operation-failed" ||
        (result.kind === "git-mutation-state" && result.state === "rejected"),
    ).toBe(true);
    expect(
      h.frames.filter(
        (frame) =>
          frame.operationId === id(20) &&
          frame.event.kind === "operation-result" &&
          frame.event.result.kind === "git-mutation-state" &&
          frame.event.result.state === "completed",
      ),
    ).toEqual([]);
  },
);

it("reaches the ordinary host journal with a bounded comparison and applies only its recorded IDs", async () => {
  const h = harness();
  const comparison = await h.prepare();
  expect(comparison.kind).toBe("git-hunks");
  if (comparison.kind !== "git-hunks") throw Error("No comparison");
  const result = await h.service.execute(
    windowId,
    {
      kind: "stage-git-hunks",
      operationId: id(20),
      threadId: source.id,
      checkoutId: checkout.id,
      gitOperationId: id(21),
      comparisonOperationId: comparison.operationId,
      selected: [comparison.hunks[0]!.id],
    },
    { initiator: "user", admissionCurrent: () => true },
  );
  expect(result).toMatchObject({
    kind: "git-mutation-state",
    mutation: "stage-hunks",
    state: "completed",
  });
  expect(h.effects).toHaveBeenCalledTimes(1);
  expect(h.frames).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "operation-result",
          result: expect.objectContaining({
            kind: "git-hunks",
            threadId: source.id,
            checkoutId: checkout.id,
          }),
        }),
      }),
    ]),
  );
});

it("rejects a revoked original local capability after the actual command body wait, before diff/evidence/journal", async () => {
  const h = harness();
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const route = createCodeRouteHandler({
    windowAuthorityStore: store,
    now: () => 1,
    service: { executeOperation: h.service.execute.bind(h.service) } as never,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<ArrayBuffer>();
  const request = new Request("http://127.0.0.1/api/code/commands", {
    method: "POST",
    headers: { "x-octant-window-capability": capability, "content-type": "application/json" },
    body: "{}",
  });
  vi.spyOn(request, "arrayBuffer").mockImplementation(() => {
    entered.resolve();
    return release.promise;
  });
  const pending = route(request);
  await entered.promise;
  store.revoke(windowId);
  release.resolve(
    new TextEncoder().encode(
      JSON.stringify({
        kind: "prepare-git-hunks",
        operationId: id(9),
        threadId: source.id,
        checkoutId: checkout.id,
        gitOperationId: id(10),
        scope: "unstaged",
      }),
    ).buffer,
  );
  const response = await pending;
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    kind: "operation-failed",
    failure: { category: "unauthorized" },
  });
  expect(h.observe).not.toHaveBeenCalled();
  expect(h.evidence.put).not.toHaveBeenCalled();
  expect(h.append).not.toHaveBeenCalled();
});

it.each(["completed", "failed", "throw"])(
  "keeps private %s receipt after native apply retires authority and authorized replay never applies again",
  async (outcome) => {
    const h = harness();
    const comparison = await h.prepare();
    if (comparison.kind !== "git-hunks") throw Error("Missing comparison");
    const command = {
      kind: "stage-git-hunks",
      operationId: id(20),
      threadId: source.id,
      checkoutId: checkout.id,
      gitOperationId: id(21),
      comparisonOperationId: comparison.operationId,
      selected: [comparison.hunks[0]!.id],
    };
    h.retireAfterEffect(outcome);
    const retired = await h.service.execute(windowId, command, {
      initiator: "user",
      admissionCurrent: () => true,
    });
    expect(h.effects).toHaveBeenCalledTimes(1);
    const receipt = h.frames.find(
      (frame) => frame.operationId === id(20) && frame.event.kind === "operation-result",
    );
    expect(receipt?.event).toEqual({
      kind: "operation-result",
      result: {
        kind: "git-mutation-state",
        operationId: id(20),
        gitOperationId: id(21),
        mutation: "stage-hunks",
        state: outcome === "completed" ? "completed" : "failed",
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("private file contents");
    expect(retired).toMatchObject({
      kind: "operation-failed",
      failure: {
        category: "unauthorized",
        message: expect.stringMatching(/may have changed.*Refresh/i),
      },
    });
    h.restoreWindow();
    const replayed = await h.service.execute(windowId, command, {
      initiator: "user",
      admissionCurrent: () => true,
    });
    expect(replayed).toMatchObject({
      kind: "git-mutation-state",
      state: outcome === "completed" ? "completed" : "failed",
    });
    expect(h.effects).toHaveBeenCalledTimes(1);
  },
);

it.each(["single", "batch"])(
  "fences actual %s retained-evidence reads when the original local capability retires during storage read",
  async (kind) => {
    const h = harness();
    const comparison = await h.prepare();
    if (comparison.kind !== "git-hunks") throw Error("Missing comparison");
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    h.evidence.read.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const route = createCodeRouteHandler({
      windowAuthorityStore: store,
      now: () => 1,
      service: {
        readOperationContent: async (scope, threadId, operationId, contentId, current) => {
          const value = await h.service.readEvidence(
            scope,
            threadId,
            operationId,
            decodeCodeEvidenceContentId(contentId),
            current,
          );
          return {
            bytes: new TextEncoder().encode(value.text),
            digest: value.reference.digest,
            byteLength: value.reference.byteLength,
          };
        },
        readOperationContents: async (scope, input, current) => ({
          threadId: input.threadId,
          items: await h.service.readEvidenceBatch(scope, input.threadId, input.items, current),
        }),
      } as Parameters<typeof createCodeRouteHandler>[0]["service"],
    });
    const request =
      kind === "single"
        ? new Request(
            `http://127.0.0.1/api/code/threads/${source.id}/operations/${comparison.operationId}/evidence/${comparison.diff.contentId}`,
            { headers: { "x-octant-window-capability": capability } },
          )
        : new Request("http://127.0.0.1/api/code/evidence/batch", {
            method: "POST",
            headers: {
              "x-octant-window-capability": capability,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              threadId: source.id,
              items: [
                { operationId: comparison.operationId, contentId: comparison.diff.contentId },
              ],
            }),
          });
    const pending = route(request);
    await entered.promise;
    store.revoke(windowId);
    release.resolve(patch);
    const response = await pending;
    expect(response!.status).toBeGreaterThanOrEqual(400);
    expect(await response!.text()).not.toContain("+new");
    expect(h.effects).not.toHaveBeenCalled();
  },
);

it("reads only the exact recorded evidence owner and refuses missing host admission or a foreign operation", async () => {
  const h = harness();
  const comparison = await h.prepare();
  if (comparison.kind !== "git-hunks") throw Error("Missing comparison");
  await expect(
    h.service.readEvidence(
      windowId,
      source.id,
      comparison.operationId,
      comparison.diff.contentId,
      () => true,
    ),
  ).resolves.toMatchObject({ text: patch });
  h.evidence.read.mockClear();
  await expect(
    h.service.readEvidence(windowId, source.id, comparison.operationId, comparison.diff.contentId),
  ).rejects.toMatchObject({ category: "unauthorized" });
  await expect(
    h.service.readEvidence(
      windowId,
      source.id,
      decodeCodeOperationId(id(99)),
      comparison.diff.contentId,
      () => true,
    ),
  ).rejects.toMatchObject({ category: "unauthorized" });
  expect(h.evidence.read).not.toHaveBeenCalled();
});

it("refuses an identical-byte physical replacement between prepared comparison and apply", async () => {
  const h = harness();
  const comparison = await h.prepare();
  if (comparison.kind !== "git-hunks") throw Error("Missing comparison");
  h.replaceRoot();
  const result = await h.service.execute(
    windowId,
    {
      kind: "stage-git-hunks",
      operationId: id(20),
      threadId: source.id,
      checkoutId: checkout.id,
      gitOperationId: id(21),
      comparisonOperationId: comparison.operationId,
      selected: [comparison.hunks[0]!.id],
    },
    { initiator: "user", admissionCurrent: () => true },
  );
  expect(h.effects).not.toHaveBeenCalled();
  expect(result).toMatchObject({ kind: "operation-failed", failure: { category: "invalid" } });
});

it("keeps a same-root retained comparison valid across service reconstruction without adopting a missing witness", async () => {
  const h = harness();
  const comparison = await h.prepare();
  if (comparison.kind !== "git-hunks") throw Error("Missing comparison");
  const command = {
    kind: "stage-git-hunks",
    operationId: id(20),
    threadId: source.id,
    checkoutId: checkout.id,
    gitOperationId: id(21),
    comparisonOperationId: comparison.operationId,
    selected: [comparison.hunks[0]!.id],
  };
  const restarted = h.restart();
  const result = await restarted.execute(windowId, command, {
    initiator: "user",
    admissionCurrent: () => true,
  });
  expect(result).toMatchObject({ kind: "git-mutation-state", state: "completed" });
  expect(h.effects).toHaveBeenCalledTimes(1);
  const index = h.frames.findIndex((frame) => frame.operationId === comparison.operationId);
  const old = JSON.parse(JSON.stringify(h.frames[index]));
  delete old.event.result.rootDigest;
  h.frames[index] = old;
  const refused = await restarted.execute(
    windowId,
    { ...command, operationId: id(22) },
    { initiator: "user", admissionCurrent: () => true },
  );
  expect(refused).toMatchObject({ kind: "operation-failed", failure: { category: "invalid" } });
  expect(h.effects).toHaveBeenCalledTimes(1);
});
