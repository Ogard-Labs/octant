import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GithubCloneRequested,
  GithubCloneTransitioned,
  ReplayCursor,
  decodeWindowId,
  type GithubCloneCommand,
  type GithubCloneState,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { BindingReceiptStore } from "../bindingReceiptStore";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import {
  GITHUB_CLONE_AGGREGATE_TYPE,
  GITHUB_CLONE_REQUESTED,
  GITHUB_CLONE_TRANSITIONED,
  GithubCloneProjection,
} from "../persistence/githubCloneProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import type { ManagedCloneResult, ManagedGitResult } from "./managedCloneProcessPort";
import { ManagedRepositoryInventory } from "./managedRepositoryInventory";
import { ManagedCloneService, type ManagedCloneRepositoryObservation } from "./managedCloneService";

const NOW_ISO = "2026-08-11T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const OID = "1234567890abcdef1234567890abcdef12345678";
const NODE_ID = "R_kgDOAbc123";
const requestId = "11111111-2222-4333-8444-555555555555";
const windowId = decodeWindowId("99999999-8888-4777-8666-555555555555");
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

interface GitScriptOptions {
  originUrl?: string;
  headBranch?: string;
  remoteRefs?: boolean;
  bare?: boolean;
  failCheckout?: boolean;
}

function scriptedGit(options: GitScriptOptions, record: string[][]) {
  const ok = (stdout: string): ManagedGitResult => ({ status: "completed", exitCode: 0, stdout });
  return (args: readonly string[]): ManagedGitResult => {
    record.push([...args]);
    const path = args[0] === "-C" ? (args[1] ?? "") : "";
    if (args.includes("checkout")) {
      return options.failCheckout === true
        ? { status: "completed", exitCode: 1, stdout: "" }
        : ok("");
    }
    if (args.includes("--is-bare-repository"))
      return ok(options.bare === true ? "true\n" : "false\n");
    if (args.includes("--git-common-dir")) return ok(`${join(path, ".git")}\n`);
    if (args.includes("--show-superproject-working-tree")) return ok("");
    if (args.includes("worktree")) return ok(`worktree ${path}\nHEAD ${OID}\n\n`);
    if (args.includes("remote")) {
      return ok(`${options.originUrl ?? "https://github.com/octant/octant.git"}\n`);
    }
    if (args.includes("symbolic-ref")) {
      return ok(`refs/remotes/origin/${options.headBranch ?? "development"}\n`);
    }
    if (args.includes("for-each-ref")) {
      return options.remoteRefs === false
        ? ok("")
        : ok(`${OID} commit\trefs/remotes/origin/${options.headBranch ?? "development"}\n`);
    }
    if ((args[args.length - 1] ?? "").startsWith("refs/remotes/origin/")) return ok(`${OID}\n`);
    return ok("");
  };
}

interface HarnessOptions {
  git?: GitScriptOptions;
  clone?: (
    input: { owner: string; name: string; stagingPath: string },
    onProgress: (message: string) => void,
    signal: AbortSignal,
  ) => Promise<ManagedCloneResult>;
  observe?: () => Promise<ManagedCloneRepositoryObservation>;
  snapshotState?: "ready" | "unauthorized";
  gitProtocol?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-managed-clone-")));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW_ISO);
  const projection = new GithubCloneProjection();
  const registry = new EventRegistry()
    .register(GITHUB_CLONE_REQUESTED, 1, GithubCloneRequested)
    .register(GITHUB_CLONE_TRANSITIONED, 1, GithubCloneTransitioned);
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(projection);
  const journal = new Journal({ connection, registry, projections, clock: () => NOW_ISO });
  const inventoryPath = join(directory, "inventory");
  mkdirSync(inventoryPath, { recursive: true });
  const inventory = new ManagedRepositoryInventory({ inventoryPath });
  const receipts = new BindingReceiptStore();
  const gitCalls: string[][] = [];
  const cloneCalls: Array<{ owner: string; name: string; stagingPath: string }> = [];
  const git = scriptedGit(options.git ?? {}, gitCalls);
  const clone =
    options.clone ??
    (async (
      input: { owner: string; name: string; stagingPath: string },
      onProgress: (message: string) => void,
    ): Promise<ManagedCloneResult> => {
      onProgress("Receiving objects: 50%");
      return { kind: "completed" };
    });
  let uuidCounter = 0;
  const service = new ManagedCloneService({
    journal,
    projection,
    inventory,
    process: {
      clone: (input, onProgress, signal) => {
        cloneCalls.push(input);
        return clone(input, onProgress, signal);
      },
      runGit: async (args, _signal) => git(args),
      hooksDirectory: () => join(directory, "owned-hooks"),
    },
    observation: {
      observeRepository:
        options.observe ??
        (async () => ({
          kind: "observed",
          repository: {
            nodeId: NODE_ID,
            owner: "octant",
            name: "octant",
            visibility: "private",
            defaultBranch: "development",
          },
        })),
    },
    snapshot: async () =>
      ({
        state: options.snapshotState ?? "ready",
        account: {
          login: "octo",
          scopes: ["repo"],
          gitProtocol: options.gitProtocol ?? "https",
        },
      }) as never,
    projectRootPort: { validate: async (_type, candidate) => ({ canonicalRoot: candidate }) },
    bindingReceiptStore: receipts,
    actor,
    uuid: () => {
      uuidCounter += 1;
      return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
    },
    clock: () => NOW_ISO,
    now: () => NOW_MS,
  });
  const destinationPath = join(inventoryPath, "github.com", "octant", "octant");
  const stagingPath = join(inventoryPath, ".octant-incoming", requestId);
  const quarantinePath = join(inventoryPath, ".octant-quarantine", requestId);
  return {
    service,
    journal,
    projection,
    inventoryPath,
    destinationPath,
    stagingPath,
    quarantinePath,
    receipts,
    gitCalls,
    cloneCalls,
  };
}

const requestCommand: GithubCloneCommand = {
  kind: "request-clone",
  requestId,
  nodeId: NODE_ID,
  expectedOwner: "octant",
  expectedName: "octant",
} as GithubCloneCommand;

/**
 * A promise a fake resolves when it has actually been reached.
 *
 * The cancellation tests used to wait a fixed 25ms before cancelling, hoping
 * the confirm path had got as far as calling `clone` and registering its abort
 * listener. Confirming does real filesystem work first, so on a loaded machine
 * it has not, the cancel lands before anything is listening, and the pending
 * confirm never settles. Waiting for the event itself is the same test without
 * the guess.
 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function confirmCommand(digest: string): GithubCloneCommand {
  return {
    kind: "confirm-clone",
    requestId,
    nodeId: NODE_ID,
    confirmation: "confirm-github-managed-clone",
    destinationDigest: digest,
  } as GithubCloneCommand;
}

const context = { windowId };
const signal = new AbortController().signal;
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

/** Seeds an interrupted lifecycle exactly as a pre-crash server journaled it. */
function appendTransition(
  harness: ReturnType<typeof createHarness>,
  fromState: GithubCloneState,
  toState: GithubCloneState,
  version: number,
): void {
  harness.journal.append({
    aggregate: { aggregateType: GITHUB_CLONE_AGGREGATE_TYPE, aggregateId: requestId },
    expectedVersion: version - 1,
    events: [
      {
        eventId: `00000000-0000-4000-8000-9${String(version).padStart(11, "0")}`,
        eventName: GITHUB_CLONE_TRANSITIONED,
        eventVersion: 1,
        correlationId: "00000000-0000-4000-8000-00000000cccc",
        actor,
        occurredAt: NOW_ISO,
        payload: { requestId, fromState, toState, version },
      },
    ],
  } as never);
}

async function requestOperation(harness: ReturnType<typeof createHarness>) {
  const response = await harness.service.execute(requestCommand, context, signal);
  if (response.kind !== "operation")
    throw new Error(`request refused: ${JSON.stringify(response)}`);
  return response.operation;
}

describe("managed clone request", () => {
  it("creates one awaiting-confirmation operation with the derived destination", async () => {
    const harness = createHarness();
    const operation = await requestOperation(harness);
    expect(operation.state).toBe("awaiting-confirmation");
    expect(operation.mode).toBe("clone");
    expect(operation.destination.destinationPath).toBe(harness.destinationPath);
    expect(operation.destination.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(operation.repository).toEqual({
      nodeId: NODE_ID,
      owner: "octant",
      name: "octant",
      visibility: "private",
      defaultBranch: "development",
    });
    // No filesystem side effect before confirmation.
    expect(existsSync(harness.stagingPath)).toBe(false);
    expect(existsSync(harness.destinationPath)).toBe(false);
  });

  it("is idempotent for a duplicate request id and refuses identity swaps", async () => {
    const harness = createHarness();
    const first = await requestOperation(harness);
    const second = await harness.service.execute(requestCommand, context, signal);
    expect(second).toEqual({ kind: "operation", operation: first });
    const swapped = await harness.service.execute(
      { ...requestCommand, nodeId: "R_other" } as GithubCloneCommand,
      context,
      signal,
    );
    expect(swapped).toEqual({ kind: "refused", reason: "conflict" });
  });

  it("refuses without journaling when unauthorized, non-https, stale, or renamed", async () => {
    const unauthorized = createHarness({ snapshotState: "unauthorized" });
    expect(await unauthorized.service.execute(requestCommand, context, signal)).toEqual({
      kind: "refused",
      reason: "unauthorized",
    });
    const ssh = createHarness({ gitProtocol: "ssh" });
    expect(await ssh.service.execute(requestCommand, context, signal)).toEqual({
      kind: "refused",
      reason: "non-https-git-protocol",
    });
    const stale = createHarness({ observe: async () => ({ kind: "unavailable" }) });
    expect(await stale.service.execute(requestCommand, context, signal)).toEqual({
      kind: "refused",
      reason: "stale-read",
    });
    const missing = createHarness({ observe: async () => ({ kind: "not-found" }) });
    expect(await missing.service.execute(requestCommand, context, signal)).toEqual({
      kind: "refused",
      reason: "not-found",
    });
    const renamed = createHarness({
      observe: async () => ({
        kind: "observed",
        repository: {
          nodeId: "R_substituted",
          owner: "octant",
          name: "octant",
          visibility: "private",
          defaultBranch: "development",
        },
      }),
    });
    const renamedResponse = await renamed.service.execute(requestCommand, context, signal);
    expect(renamedResponse).toEqual({ kind: "refused", reason: "conflict" });
    expect(renamed.projection.list()).toEqual([]);
  });

  it("refuses a destination collision without adopting or overwriting", async () => {
    const harness = createHarness();
    mkdirSync(join(harness.inventoryPath, "github.com", "octant"), { recursive: true });
    writeFileSync(harness.destinationPath, "not a directory");
    const response = await harness.service.execute(requestCommand, context, signal);
    expect(response).toEqual({
      kind: "refused",
      reason: "collision",
      remediation: "path-confinement",
    });
    expect(harness.projection.list()).toEqual([]);
  });

  it("classifies a verified matching checkout as an explicit attach flow", async () => {
    const harness = createHarness();
    mkdirSync(join(harness.destinationPath, ".git"), { recursive: true });
    const operation = await requestOperation(harness);
    expect(operation.mode).toBe("attach-existing");
    expect(operation.state).toBe("awaiting-confirmation");
  });

  it("refuses a wrong-origin checkout instead of offering attachment", async () => {
    const harness = createHarness({
      git: { originUrl: "https://github.com/intruder/octant.git" },
    });
    mkdirSync(join(harness.destinationPath, ".git"), { recursive: true });
    const response = await harness.service.execute(requestCommand, context, signal);
    expect(response).toEqual({
      kind: "refused",
      reason: "collision",
      remediation: "wrong-origin",
    });
  });

  it("refuses a concurrent request for the same repository or destination", async () => {
    const harness = createHarness();
    await requestOperation(harness);
    const concurrent = await harness.service.execute(
      {
        ...requestCommand,
        requestId: "22222222-2222-4222-8222-222222222222",
      } as GithubCloneCommand,
      context,
      signal,
    );
    expect(concurrent).toEqual({ kind: "refused", reason: "conflict" });
  });
});

describe("managed clone confirmation and pipeline", () => {
  it("binds confirmation to the exact node identity and destination digest", async () => {
    const harness = createHarness();
    const operation = await requestOperation(harness);
    expect(
      await harness.service.execute(
        {
          ...confirmCommand(operation.destination.digest),
          nodeId: "R_other",
        } as GithubCloneCommand,
        context,
        signal,
      ),
    ).toEqual({ kind: "refused", reason: "invalid" });
    expect(await harness.service.execute(confirmCommand("f".repeat(64)), context, signal)).toEqual({
      kind: "refused",
      reason: "invalid",
    });
    expect(
      await harness.service.execute(
        {
          kind: "confirm-clone",
          requestId: "22222222-2222-4222-8222-222222222222",
          nodeId: NODE_ID,
          confirmation: "confirm-github-managed-clone",
          destinationDigest: operation.destination.digest,
        } as GithubCloneCommand,
        context,
        signal,
      ),
    ).toEqual({ kind: "refused", reason: "not-found" });
  });

  it("clones, verifies, promotes atomically, and issues one ordinary binding receipt", async () => {
    const harness = createHarness();
    const operation = await requestOperation(harness);
    const response = await harness.service.execute(
      confirmCommand(operation.destination.digest),
      context,
      signal,
    );
    expect(response.kind).toBe("operation");
    if (response.kind !== "operation") return;
    expect(response.operation.state).toBe("completed");
    expect(response.operation.bindingIssued).toBe(true);
    expect(response.operation.repository.defaultBranch).toBe("development");
    expect(response.operation.repository.empty).toBe(false);
    expect(response.binding?.projectType).toBe("code");
    expect(response.binding?.receiptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The receipt is an ordinary one-time Code Project binding receipt.
    const binding = harness.receipts.consume({
      receiptId: response.binding!.receiptId,
      authenticatedWindowId: windowId,
      projectType: "code",
      now: NOW_MS,
    });
    expect(binding.canonicalRoot).toBe(harness.destinationPath);
    // Promotion is atomic: staging is gone and the destination exists.
    expect(existsSync(harness.destinationPath)).toBe(true);
    expect(existsSync(harness.stagingPath)).toBe(false);
    // Clone ran token-free against the reserved staging path.
    expect(harness.cloneCalls).toEqual([
      { owner: "octant", name: "octant", stagingPath: harness.stagingPath },
    ]);
    // The hardened checkout pinned the verified object id with owned hooks.
    const checkout = harness.gitCalls.find((args) => args.includes("checkout"));
    expect(checkout).toBeDefined();
    expect(checkout?.join(" ")).toContain(OID);
    expect(checkout?.join(" ")).toContain("core.hooksPath=");
    // The journal recorded the full strict lifecycle.
    const states = harness.projection.getByRequestId(requestId);
    expect(states?.state).toBe("completed");
    expect(states?.version).toBe(6);
  });

  it("keeps journaled payloads and responses free of credential material", async () => {
    const harness = createHarness({
      clone: async (_input, onProgress) => {
        onProgress("Receiving objects: 10% token=[redacted]");
        return { kind: "completed" };
      },
    });
    const operation = await requestOperation(harness);
    const response = await harness.service.execute(
      confirmCommand(operation.destination.digest),
      context,
      signal,
    );
    const journalDump = JSON.stringify(
      harness.journal.replay(decodeReplayCursor({ afterSequence: 0, limit: 100 })),
    );
    expect(journalDump).not.toMatch(/ghp_[A-Za-z0-9_]{12,}|Authorization|x-access-token/i);
    // Binding receipts are never journaled; only the issuance fact is.
    expect(journalDump).not.toContain(
      response.kind === "operation" ? response.binding!.receiptId : "unexpected",
    );
    expect(journalDump).toContain('"bindingIssued":true');
  });

  it("quarantines staging and fails when the clone process fails", async () => {
    const harness = createHarness({
      clone: async () => ({ kind: "failed", classification: "unauthorized" }),
    });
    const operation = await requestOperation(harness);
    const response = await harness.service.execute(
      confirmCommand(operation.destination.digest),
      context,
      signal,
    );
    expect(response.kind).toBe("operation");
    if (response.kind !== "operation") return;
    expect(response.operation.state).toBe("failed");
    expect(response.operation.failure).toEqual({
      code: "clone-failed",
      remediation: "unauthorized",
    });
    expect(existsSync(harness.stagingPath)).toBe(false);
    expect(existsSync(harness.quarantinePath)).toBe(true);
    expect(existsSync(harness.destinationPath)).toBe(false);
    expect(response.binding).toBeUndefined();
  });

  it("fails closed on wrong origin, node substitution, and default-branch mismatch", async () => {
    const wrongOrigin = createHarness({
      git: { originUrl: "https://github.com/intruder/octant.git" },
    });
    const first = await requestOperation(wrongOrigin);
    const firstResponse = await wrongOrigin.service.execute(
      confirmCommand(first.destination.digest),
      context,
      signal,
    );
    expect(firstResponse.kind === "operation" && firstResponse.operation.failure?.code).toBe(
      "wrong-origin",
    );
    expect(existsSync(wrongOrigin.destinationPath)).toBe(false);
    expect(existsSync(wrongOrigin.quarantinePath)).toBe(true);

    const branchMismatch = createHarness({ git: { headBranch: "trunk" } });
    const second = await requestOperation(branchMismatch);
    const secondResponse = await branchMismatch.service.execute(
      confirmCommand(second.destination.digest),
      context,
      signal,
    );
    expect(secondResponse.kind === "operation" && secondResponse.operation.failure?.code).toBe(
      "default-branch-mismatch",
    );

    const bare = createHarness({ git: { bare: true } });
    const third = await requestOperation(bare);
    const thirdResponse = await bare.service.execute(
      confirmCommand(third.destination.digest),
      context,
      signal,
    );
    expect(thirdResponse.kind === "operation" && thirdResponse.operation.failure?.code).toBe(
      "bare-repository",
    );
  });

  it("verifies an explicitly empty repository without any checkout", async () => {
    const harness = createHarness({ git: { remoteRefs: false } });
    const operation = await requestOperation(harness);
    const response = await harness.service.execute(
      confirmCommand(operation.destination.digest),
      context,
      signal,
    );
    expect(response.kind).toBe("operation");
    if (response.kind !== "operation") return;
    expect(response.operation.state).toBe("completed");
    expect(response.operation.repository.empty).toBe(true);
    expect(harness.gitCalls.some((args) => args.includes("checkout"))).toBe(false);
    expect(existsSync(harness.destinationPath)).toBe(true);
  });

  it("quarantines on checkout failure instead of falling through to attachment", async () => {
    const harness = createHarness({ git: { failCheckout: true } });
    const operation = await requestOperation(harness);
    const response = await harness.service.execute(
      confirmCommand(operation.destination.digest),
      context,
      signal,
    );
    expect(response.kind === "operation" && response.operation.failure?.code).toBe(
      "checkout-failed",
    );
    expect(existsSync(harness.destinationPath)).toBe(false);
    expect(existsSync(harness.quarantinePath)).toBe(true);
  });

  it("cancellation terminates the owned process and quarantines deterministically", async () => {
    let sawAbort = false;
    const cloneStarted = deferred();
    const harness = createHarness({
      clone: (_input, _onProgress, cloneSignal) =>
        new Promise((resolve) => {
          cloneSignal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve({ kind: "cancelled" });
            },
            { once: true },
          );
          cloneStarted.resolve();
        }),
    });
    const operation = await requestOperation(harness);
    const pendingConfirm = harness.service.execute(
      confirmCommand(operation.destination.digest),
      context,
      signal,
    );
    await cloneStarted.promise;
    const cancelResponse = await harness.service.execute(
      { kind: "cancel-clone", requestId } as GithubCloneCommand,
      context,
      signal,
    );
    const confirmResponse = await pendingConfirm;
    expect(sawAbort).toBe(true);
    expect(cancelResponse.kind === "operation" && cancelResponse.operation.state).toBe("cancelled");
    expect(confirmResponse.kind === "operation" && confirmResponse.operation.state).toBe(
      "cancelled",
    );
    expect(existsSync(harness.stagingPath)).toBe(false);
    expect(existsSync(harness.destinationPath)).toBe(false);
    // Cancelling a terminal operation is idempotent.
    const again = await harness.service.execute(
      { kind: "cancel-clone", requestId } as GithubCloneCommand,
      context,
      signal,
    );
    expect(again.kind === "operation" && again.operation.state).toBe("cancelled");
  });

  it("a second confirmation cannot re-run a confirmed operation", async () => {
    const harness = createHarness();
    const operation = await requestOperation(harness);
    await harness.service.execute(confirmCommand(operation.destination.digest), context, signal);
    const replay = await harness.service.execute(
      confirmCommand(operation.destination.digest),
      context,
      signal,
    );
    expect(replay).toEqual({ kind: "refused", reason: "conflict" });
    expect(harness.cloneCalls).toHaveLength(1);
  });
});

describe("managed clone attach-existing", () => {
  it("attaches a verified existing checkout only through the explicit attach command", async () => {
    const harness = createHarness();
    mkdirSync(join(harness.destinationPath, ".git"), { recursive: true });
    const operation = await requestOperation(harness);
    expect(operation.mode).toBe("attach-existing");
    // The ordinary clone confirmation cannot adopt an existing checkout.
    expect(
      await harness.service.execute(confirmCommand(operation.destination.digest), context, signal),
    ).toEqual({ kind: "refused", reason: "conflict", remediation: "attach-existing-required" });
    const response = await harness.service.execute(
      {
        kind: "attach-existing",
        requestId,
        nodeId: NODE_ID,
        confirmation: "confirm-github-attach-existing",
        destinationDigest: operation.destination.digest,
      } as GithubCloneCommand,
      context,
      signal,
    );
    expect(response.kind).toBe("operation");
    if (response.kind !== "operation") return;
    expect(response.operation.state).toBe("completed");
    expect(response.operation.bindingIssued).toBe(true);
    expect(response.binding?.receiptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(harness.cloneCalls).toHaveLength(0);
  });

  it("fails attachment when the repository node identity no longer matches", async () => {
    let observedNodeId = NODE_ID;
    const harness = createHarness({
      observe: async () => ({
        kind: "observed",
        repository: {
          nodeId: observedNodeId,
          owner: "octant",
          name: "octant",
          visibility: "private",
          defaultBranch: "development",
        },
      }),
    });
    mkdirSync(join(harness.destinationPath, ".git"), { recursive: true });
    const operation = await requestOperation(harness);
    observedNodeId = "R_substituted";
    const response = await harness.service.execute(
      {
        kind: "attach-existing",
        requestId,
        nodeId: NODE_ID,
        confirmation: "confirm-github-attach-existing",
        destinationDigest: operation.destination.digest,
      } as GithubCloneCommand,
      context,
      signal,
    );
    expect(response.kind === "operation" && response.operation.failure?.code).toBe(
      "node-identity-mismatch",
    );
    expect(response.kind === "operation" && response.operation.bindingIssued).toBeUndefined();
  });
});

describe("managed clone restart recovery", () => {
  it("reconciles every interrupted state deterministically and non-destructively", async () => {
    const harness = createHarness({
      clone: () => new Promise(() => {}),
    });
    // awaiting-confirmation survives restart untouched.
    const awaiting = await requestOperation(harness);
    await harness.service.recover();
    expect(harness.projection.getByRequestId(requestId)?.state).toBe("awaiting-confirmation");
    expect(awaiting.version).toBe(1);

    // A cloning operation with leftover staging is quarantined and failed.
    mkdirSync(harness.stagingPath, { recursive: true });
    appendTransition(harness, "awaiting-confirmation", "reserved", 2);
    appendTransition(harness, "reserved", "cloning", 3);
    await harness.service.recover();
    const recovered = harness.projection.getByRequestId(requestId);
    expect(recovered?.state).toBe("failed");
    expect(recovered?.failure).toEqual({ code: "restart-interrupted" });
    expect(existsSync(harness.stagingPath)).toBe(false);
    expect(existsSync(harness.quarantinePath)).toBe(true);
  });

  it("marks a possibly promoted operation as recovery-required and allows cancel", async () => {
    const harness = createHarness();
    await requestOperation(harness);
    mkdirSync(harness.destinationPath, { recursive: true });
    appendTransition(harness, "awaiting-confirmation", "reserved", 2);
    appendTransition(harness, "reserved", "cloning", 3);
    appendTransition(harness, "cloning", "verifying", 4);
    await harness.service.recover();
    expect(harness.projection.getByRequestId(requestId)?.state).toBe("recovery-required");
    // recovery-required never silently resumes; only explicit cancel applies.
    const cancelled = await harness.service.execute(
      { kind: "cancel-clone", requestId } as GithubCloneCommand,
      context,
      signal,
    );
    expect(cancelled.kind === "operation" && cancelled.operation.state).toBe("cancelled");
    // Recovery never deleted the possibly promoted destination.
    expect(existsSync(harness.destinationPath)).toBe(true);
  });
});

describe("managed clone list", () => {
  it("lists operations with bounded redacted progress", async () => {
    const cloneStarted = deferred();
    const harness = createHarness({
      clone: (_input, onProgress, cloneSignal) =>
        new Promise((resolve) => {
          onProgress("Receiving objects: 42%");
          cloneSignal.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
            once: true,
          });
          cloneStarted.resolve();
        }),
    });
    const operation = await requestOperation(harness);
    const pendingConfirm = harness.service.execute(
      confirmCommand(operation.destination.digest),
      context,
      signal,
    );
    await cloneStarted.promise;
    const listed = harness.service.list();
    expect(listed.operations).toHaveLength(1);
    expect(listed.operations[0]?.operation.state).toBe("cloning");
    expect(listed.operations[0]?.progress).toEqual({
      phase: "cloning",
      message: "Receiving objects: 42%",
    });
    await harness.service.execute(
      { kind: "cancel-clone", requestId } as GithubCloneCommand,
      context,
      signal,
    );
    await pendingConfirm;
    expect(harness.service.list().operations[0]?.progress).toBeUndefined();
  });
});
