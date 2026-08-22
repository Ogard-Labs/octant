import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorId,
  CodeOperationEventFrame,
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeOperationId,
  decodeCodeThread,
  decodeCodeThreadId,
  type WindowId,
} from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { CODE_OPERATION_EVENT_RECORDED } from "./codeOperationEventStore";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { GitMutationPort } from "./gitMutationPort";
import { GitObservationPort } from "./gitObservationPort";
import { RepositoryTestProcessPort } from "./repositoryTestProcessPort";
import { createCodeOperationRuntime } from "./codeOperationRuntime";
import { RepositoryTestDiscoveryService } from "./repositoryTestDiscoveryService";

const directories: string[] = [];
const now = "2026-07-21T14:00:00.000Z";
const windowId = "91000000-0000-4000-8000-000000000001" as WindowId;
const threadId = decodeCodeThreadId("91000000-0000-4000-8000-000000000002");
const checkoutId = decodeCodeCheckoutId("91000000-0000-4000-8000-000000000003");

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Code execution lifecycle", () => {
  it("runs terminal, tests, explicit Git delivery, idempotent PR creation, and restart replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-code-lifecycle-"));
    directories.push(directory);
    const requestedCheckoutRoot = join(directory, "checkout");
    const bareRemote = join(directory, "remote.git");
    execFileSync("git", ["init", "--bare", bareRemote]);
    execFileSync("git", ["init", "--initial-branch=feature/lifecycle", requestedCheckoutRoot]);
    const checkoutRoot = realpathSync(requestedCheckoutRoot);
    execFileSync("git", ["-C", checkoutRoot, "config", "user.name", "Octant Test"]);
    execFileSync("git", ["-C", checkoutRoot, "config", "user.email", "test@octant.local"]);
    writeFileSync(join(checkoutRoot, "README.md"), "initial\n");
    // A run is authorized against the definitions the server discovers, so the
    // checkout declares them the way a real repository does.
    mkdirSync(join(checkoutRoot, ".octant"));
    writeFileSync(
      join(checkoutRoot, ".octant", "tests.json"),
      JSON.stringify({
        version: 1,
        tests: [
          {
            id: "life",
            name: "Lifecycle",
            argv: [process.execPath, "-e", "console.log('passed')"],
            cwd: ".",
            environmentRefs: [],
            timeoutMs: 10_000,
            artifactPaths: [],
          },
          {
            id: "cancel",
            name: "Cancellable lifecycle",
            argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
            cwd: ".",
            environmentRefs: [],
            timeoutMs: 12_000,
            artifactPaths: [],
          },
          {
            id: "shutdown",
            name: "Shutdown cleanup",
            argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
            cwd: ".",
            environmentRefs: [],
            timeoutMs: 12_000,
            artifactPaths: [],
          },
        ],
      }),
    );
    execFileSync("git", ["-C", checkoutRoot, "add", "README.md", ".octant/tests.json"]);
    execFileSync("git", ["-C", checkoutRoot, "commit", "-m", "initial"]);
    execFileSync("git", ["-C", checkoutRoot, "remote", "add", "origin", bareRemote]);
    const initialOid = execFileSync("git", ["-C", checkoutRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const discovered = await new RepositoryTestDiscoveryService().discover({
      checkoutId: String(checkoutId),
      rootPath: checkoutRoot,
    });
    const lifecycleTest = discovered.find((definition) => definition.name === "Lifecycle")!;
    const cancellableTest = discovered.find(
      (definition) => definition.name === "Cancellable lifecycle",
    )!;
    const shutdownTest = discovered.find((definition) => definition.name === "Shutdown cleanup")!;

    const database = join(directory, "events.sqlite3");
    const first = openJournal(database);
    const fixture = makeRuntime(first.journal, checkoutRoot, initialOid);
    const terminal = await fixture.runtime.execute(windowId, {
      kind: "start-terminal",
      operationId: operationId(10),
      threadId,
      checkoutId,
      terminalId: "91000000-0000-4000-8000-000000000010",
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    expect(terminal).toMatchObject({ kind: "terminal-state", state: "running" });

    const test = await fixture.runtime.execute(windowId, {
      kind: "run-repository-test",
      operationId: operationId(11),
      threadId,
      checkoutId,
      testRunId: "91000000-0000-4000-8000-000000000011",
      definition: lifecycleTest,
    });
    expect(test).toMatchObject({ kind: "repository-test-state", verdict: "passed" });

    const cancellableRunId = "91000000-0000-4000-8000-000000000019";
    const cancellable = fixture.runtime.execute(windowId, {
      kind: "run-repository-test",
      operationId: operationId(19),
      threadId,
      checkoutId,
      testRunId: cancellableRunId,
      definition: cancellableTest,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await fixture.runtime.execute(windowId, {
        kind: "cancel-repository-test",
        operationId: operationId(20),
        threadId,
        checkoutId,
        testRunId: cancellableRunId,
      }),
    ).toMatchObject({ kind: "repository-test-state", state: "interrupted" });
    expect(await cancellable).toMatchObject({
      kind: "repository-test-state",
      state: "interrupted",
    });

    writeFileSync(join(checkoutRoot, "README.md"), "delivered\n");
    const observed = await fixture.runtime.execute(windowId, observeCommand(12));
    expect(observed).toMatchObject({ kind: "git-observed", changedPaths: ["README.md"] });
    if (observed.kind !== "git-observed") throw new Error("Git observation failed");
    expect(
      await fixture.runtime.execute(windowId, {
        kind: "stage-git",
        operationId: operationId(13),
        threadId,
        checkoutId,
        gitOperationId: operationId(113),
        paths: ["README.md"],
        expectedStateToken: observed.stateToken,
      }),
    ).toMatchObject({ kind: "git-mutation-state", state: "completed" });
    const staged = await fixture.runtime.execute(windowId, observeCommand(14));
    if (staged.kind !== "git-observed") throw new Error("Staged observation failed");
    expect(
      await fixture.runtime.execute(windowId, {
        kind: "commit-git",
        operationId: operationId(15),
        threadId,
        checkoutId,
        gitOperationId: operationId(115),
        message: "deliver lifecycle",
        stagedSummary: staged.status.filter((entry) => entry.index !== " "),
        expectedStateToken: staged.stateToken,
      }),
    ).toMatchObject({ kind: "git-mutation-state", state: "completed" });
    const committed = await fixture.runtime.execute(windowId, observeCommand(16));
    if (committed.kind !== "git-observed" || committed.head.kind !== "branch") {
      throw new Error("Committed observation failed");
    }
    expect(
      await fixture.runtime.execute(windowId, {
        kind: "push-git",
        operationId: operationId(17),
        threadId,
        checkoutId,
        gitOperationId: operationId(117),
        remote: "origin",
        localRef: "refs/heads/feature/lifecycle",
        remoteRef: "refs/heads/feature/lifecycle",
        expectedHeadOid: committed.head.oid,
        expectedStateToken: committed.stateToken,
        confirmation: {
          remote: "origin",
          refspec: "refs/heads/feature/lifecycle:refs/heads/feature/lifecycle",
        },
        authorization: { kind: "full-access" },
      }),
    ).toMatchObject({ kind: "git-mutation-state", state: "completed" });

    const prCommand = {
      kind: "create-pull-request" as const,
      operationId: operationId(18),
      threadId,
      checkoutId,
      title: "Lifecycle delivery",
      body: "Verified locally.",
      idempotencyKey: "lifecycle-pr",
      authorization: { kind: "full-access" as const },
    };
    expect(await fixture.runtime.execute(windowId, prCommand)).toMatchObject({
      kind: "pull-request-state",
      state: "created",
      number: 42,
    });
    expect(await fixture.runtime.execute(windowId, prCommand)).toMatchObject({ number: 42 });
    expect(fixture.ensurePullRequest).toHaveBeenCalledOnce();

    const shutdownRun = fixture.runtime.execute(windowId, {
      kind: "run-repository-test",
      operationId: operationId(21),
      threadId,
      checkoutId,
      testRunId: "91000000-0000-4000-8000-000000000021",
      definition: shutdownTest,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fixture.runtime.close();
    expect(await shutdownRun).toMatchObject({
      kind: "repository-test-state",
      state: "interrupted",
    });
    first.connection.close();
    const second = openJournal(database);
    const restarted = makeRuntime(second.journal, checkoutRoot, committed.head.oid);
    const replay = await restarted.runtime.subscribe(
      windowId,
      threadId,
      prCommand.operationId,
      0,
      10,
    );
    expect(replay.at(-1)?.event).toMatchObject({
      kind: "operation-result",
      result: { kind: "pull-request-state", number: 42 },
    });
    await restarted.runtime.close();
    second.connection.close();

    expect(
      execFileSync("git", ["--git-dir", bareRemote, "rev-parse", "refs/heads/feature/lifecycle"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(committed.head.oid);
  });
});

function openJournal(path: string) {
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  const journal = new Journal({
    connection,
    registry: new EventRegistry().register(
      CODE_OPERATION_EVENT_RECORDED,
      1,
      CodeOperationEventFrame,
    ),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  return { connection, journal };
}

function makeRuntime(journal: Journal, checkoutRoot: string, headOid: string) {
  const thread = decodeCodeThread({
    id: threadId,
    projectId: "91000000-0000-4000-8000-000000000020",
    bindingRevisionId: "91000000-0000-4000-8000-000000000021",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId,
    title: "Lifecycle",
    lifecycle: "active",
    providerInstanceId: "91000000-0000-4000-8000-000000000022",
    modelId: "model",
    executionPolicy: "full-access",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/lifecycle",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const checkout = decodeCodeCheckoutIdentity({
    id: checkoutId,
    repositoryId: thread.repositoryId,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "feature/lifecycle", oid: headOid },
    observedAt: now,
  });
  let evidenceId = 30;
  const evidence = new Map<string, string>();
  const ensurePullRequest = vi.fn(async () => ({
    status: "created" as const,
    pullRequest: {
      number: 42,
      url: "https://github.com/octant/octant/pull/42",
      baseRepository: "octant/octant",
      baseBranch: "development",
      headOwner: "octant",
      headBranch: "feature/lifecycle",
    },
  }));
  const runtime = createCodeOperationRuntime({
    persistence: {
      journal,
      readCodeThread: (id) => (id === threadId ? thread : undefined),
      readCodeCheckout: (id) => (id === checkoutId ? checkout : undefined),
      readReviewFinding: () => undefined,
      readReviewFindings: () => [],
    },
    windowAccess: { canAccessProject: async () => true },
    resolveCheckoutRoot: async () => ({
      checkoutRoot,
      shell: "/bin/zsh",
      credentialReferences: [],
      environment: {},
    }),
    resolveProviderDriver: async () => undefined,
    credentialResolver: { resolve: async () => undefined },
    resolvePullRequestTarget: async () => undefined,
    pullRequestPort: {
      ensure: ensurePullRequest,
      observeReview: async () => ({ status: "unavailable" as const }),
    },
    reviewFiles: { resolve: () => undefined },
    evidence: {
      put: (content) => {
        const id = ++evidenceId;
        const reference = decodeCodeEvidenceReference({
          contentId: `91000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
          digest: id.toString(16).padStart(64, "0"),
          byteLength: Buffer.byteLength(content),
        });
        evidence.set(reference.contentId, content);
        return reference;
      },
      read: async (reference) => evidence.get(reference.contentId),
    },
    actor: {
      kind: "system",
      actorId: "91000000-0000-4000-8000-000000000023" as typeof ActorId.Type,
    },
    clock: () => now,
    uuid: vi.fn(() => `91000000-0000-4000-8000-${(++evidenceId).toString().padStart(12, "0")}`),
    terminalProcessPort: {
      start: () => ({
        write: vi.fn(),
        resize: vi.fn(),
        onData: () => () => undefined,
        onExit: () => () => undefined,
        pause: vi.fn(),
        resume: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
    },
    ...(() => {
      const fake = createFakeSandboxConfinement("octant-code-lifecycle-seatbelt-");
      directories.push(fake.root);
      const seatbelt = {
        platform: "darwin" as const,
        sandboxPath: fake.sandboxPath,
        temporaryDirectory: fake.temporaryDirectory,
        seatbeltHomeDirectory: fake.root,
        seatbeltUsersDirectory: fake.root,
        confinement: fake.confinement,
      };
      return {
        repositoryTestProcessPort: new RepositoryTestProcessPort({
          ...seatbelt,
          networkEgress: "none",
        }),
        gitObservationPort: new GitObservationPort({
          ...seatbelt,
          networkEgress: "allow",
        }),
        gitMutationPort: new GitMutationPort(undefined, {
          ...seatbelt,
          networkEgress: "allow",
        }),
      };
    })(),
  });
  return { runtime, ensurePullRequest };
}

function observeCommand(id: number) {
  return {
    kind: "observe-git" as const,
    operationId: operationId(id),
    threadId,
    checkoutId,
    gitOperationId: operationId(100 + id),
    maxDiffBytes: 1024 * 1024,
  };
}

function operationId(id: number) {
  return decodeCodeOperationId(`91000000-0000-4000-8000-${id.toString().padStart(12, "0")}`);
}
