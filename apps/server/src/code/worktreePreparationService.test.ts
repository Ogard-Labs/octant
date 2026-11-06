import { spawnSync } from "node:child_process";
import { RepositoryTestProcessPort } from "./repositoryTestProcessPort";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeOperationId,
  decodeProjectAction,
  ActorId,
  WORKTREE_PREPARATION_UPDATED,
  type EventActor,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  type WorktreePreparationContext,
  WorktreePreparationService,
} from "./worktreePreparationService";
import type { RepositoryTestProcessResult } from "./repositoryTestRunner";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const now = () => new Date().toISOString();
const result = (exitCode = 0): RepositoryTestProcessResult => ({
  termination: "exited",
  exitCode,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
  parserFailed: false,
  cleanupUncertain: false,
});
async function view(service: WorktreePreparationService, context: WorktreePreparationContext) {
  const read = await service.inspect(context);
  if (read.status !== "available") throw new Error(read.message);
  return read.view;
}
function fixture(command = "printf ready") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-prepare-")));
  roots.push(root);
  const connection = openSqlite(join(root, "journal.sqlite"));
  applyMigrations(connection, MIGRATIONS, now);
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: now,
  });
  const recipe = decodeProjectAction({
    id: randomUUID(),
    name: "Prepare",
    command,
    directory: ".",
    preparesWorktrees: true,
  });
  const receipt: ManagedWorktreeReceipt = {
    version: 1,
    receiptId: randomUUID(),
    repositoryId: `repo_${"a".repeat(64)}`,
    threadId: randomUUID(),
    checkoutId: randomUUID(),
    canonicalRepositoryPath: root,
    canonicalWorktreePath: root,
    branchIntent: "child",
    refIntent: "refs/heads/child",
    expectedHead: "a".repeat(40),
    state: "ready",
    createdAt: now(),
    updatedAt: now(),
    setupRecipe: recipe,
  };
  const actor: EventActor = {
    kind: "system",
    actorId: Schema.decodeUnknownSync(ActorId)(randomUUID()),
  };
  const execute = vi.fn<RepositoryTestProcessPort["executeReviewedAction"]>(async () => result());
  const options = {
    processRecovery: "ready" as const,
    journal,
    loadReceipt: async () => receipt,
    execute,
    actor,
    clock: now,
    uuid: randomUUID,
  };
  const service = new WorktreePreparationService(options);
  const context = {
    receiptId: receipt.receiptId,
    root,
    executionPolicy: "approval-gated" as const,
    current: () => true,
    recipeCurrent: () => true,
  };
  return { service, options, context, execute, connection, receipt, root };
}
it("prepares once before admitting the first task and preserves the decision across restart", async () => {
  const f = fixture();
  expect((await view(f.service, f.context)).preparation?.state).toBe("pending");
  expect(await f.service.ensure(f.context)).toBeUndefined();
  expect((await view(f.service, f.context)).preparation?.state).toBe("succeeded");
  await new WorktreePreparationService(f.options).ensure(f.context);
  expect(f.execute).toHaveBeenCalledTimes(1);
  f.connection.close();
});
it("requires an explicit retry after failure and allows a visible deliberate skip", async () => {
  const f = fixture();
  f.execute.mockResolvedValueOnce(result(7));
  expect(await f.service.ensure(f.context)).toContain("failed");
  expect(await f.service.ensure(f.context)).toContain("failed");
  expect(f.execute).toHaveBeenCalledTimes(1);
  await f.service.command(f.context, "skip");
  expect((await view(f.service, f.context)).preparation?.state).toBe("skipped");
  expect(await f.service.ensure(f.context)).toBeUndefined();
  f.connection.close();
});

it("exposes interruption after process reconciliation and waits for an explicit retry", async () => {
  const f = fixture();
  f.options.journal.append({
    aggregate: { aggregateType: "worktree-preparation", aggregateId: f.receipt.receiptId },
    expectedVersion: 0,
    events: [
      {
        eventId: randomUUID(),
        eventName: WORKTREE_PREPARATION_UPDATED,
        eventVersion: 1,
        correlationId: randomUUID(),
        actor: f.options.actor,
        occurredAt: now(),
        payload: {
          kind: "worktree-preparation-updated",
          receiptId: f.receipt.receiptId,
          threadId: f.receipt.threadId,
          checkoutId: f.receipt.checkoutId,
          updatedAt: now(),
          preparation: {
            recipe: f.receipt.setupRecipe,
            state: "running",
            attemptId: randomUUID(),
            startedAt: now(),
          },
        },
      },
    ],
  });
  f.service.reconciled();
  expect(await f.service.ensure(f.context)).toContain("interrupted");
  expect(f.execute).not.toHaveBeenCalled();
  await f.service.command(f.context, "retry", decodeCodeOperationId(randomUUID()));
  await vi.waitFor(async () =>
    expect((await view(f.service, f.context)).preparation?.state).toBe("succeeded"),
  );
  expect(f.execute).toHaveBeenCalledOnce();
  f.connection.close();
});
it("refuses setup in Plan and after its reviewed recipe changes", async () => {
  const f = fixture();
  expect(await f.service.ensure({ ...f.context, executionPolicy: "plan" })).toContain("Plan");
  expect(await f.service.ensure({ ...f.context, recipeCurrent: () => false })).toContain("changed");
  expect(f.execute).not.toHaveBeenCalled();
  f.connection.close();
});

it("joins a concurrent first task to the same setup and cancels its owned process", async () => {
  const f = fixture();
  f.execute.mockImplementation(
    async (input, signal) =>
      new Promise((resolve) => {
        input.onOutput?.(new TextEncoder().encode("preparing"));
        signal?.addEventListener(
          "abort",
          () => resolve({ ...result(), termination: "cancelled", exitCode: null }),
          { once: true },
        );
      }),
  );
  const first = f.service.ensure(f.context);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  const second = f.service.ensure(f.context);
  expect((await view(f.service, f.context)).output).toBe("preparing");
  await f.service.command(f.context, "cancel");
  expect(await first).toContain("cancelled");
  expect(await second).toContain("cancelled");
  expect(f.execute).toHaveBeenCalledTimes(1);
  await f.service.command(f.context, "skip");
  f.connection.close();
});
it("does not retry a setup whose descendant cleanup is uncertain", async () => {
  const f = fixture();
  f.execute.mockResolvedValueOnce({ ...result(7), cleanupUncertain: true });
  expect(await f.service.ensure(f.context)).toContain("cleanup-uncertain");
  expect(
    await f.service.command(f.context, "retry", decodeCodeOperationId(randomUUID())),
  ).toMatchObject({ status: "refused", message: expect.stringContaining("cleanup") });
  expect(await f.service.command(f.context, "skip")).toMatchObject({
    status: "refused",
    message: expect.stringContaining("cleanup"),
  });
  expect(f.execute).toHaveBeenCalledTimes(1);
  f.connection.close();
});
it.runIf(process.platform === "darwin")(
  "prepares a real Git checkout through native confinement without changing its branch or index",
  async () => {
    const f = fixture("printf ready > readiness-marker");
    const git = (args: ReadonlyArray<string>) => {
      const process = spawnSync("/usr/bin/git", ["-C", f.root, ...args], { encoding: "utf8" });
      if (process.status !== 0) throw new Error("Git fixture failed");
      return process.stdout.trim();
    };
    git(["init"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ]);
    const branch = git(["symbolic-ref", "HEAD"]);
    const index = git(["write-tree"]);
    const port = new RepositoryTestProcessPort();
    f.execute.mockImplementation((input, signal) => port.executeReviewedAction(input, signal));
    expect(await f.service.ensure(f.context)).toBeUndefined();
    expect(readFileSync(join(f.root, "readiness-marker"), "utf8")).toBe("ready");
    expect(git(["symbolic-ref", "HEAD"])).toBe(branch);
    expect(git(["write-tree"])).toBe(index);
    f.connection.close();
  },
);

it("does not repeat a replayed retry after another attempt has already finished", async () => {
  const f = fixture();
  f.execute.mockResolvedValue(result(7));
  const first = decodeCodeOperationId(randomUUID()),
    second = decodeCodeOperationId(randomUUID());
  await f.service.command(f.context, "retry", first);
  await f.service.ensure(f.context);
  await f.service.command(f.context, "retry", second);
  await f.service.ensure(f.context);
  await f.service.command(f.context, "retry", first);
  await f.service.ensure(f.context);
  expect(f.execute).toHaveBeenCalledTimes(2);
  f.connection.close();
});

it("does not let a completed startup reconciliation clear a later lost completion record", async () => {
  const f = fixture();
  f.service.reconciled();
  let writes = 0;
  const append = f.options.journal.append.bind(f.options.journal);
  vi.spyOn(f.options.journal, "append").mockImplementation((...args) => {
    writes++;
    if (writes > 1) throw new Error("Fixture journal unavailable");
    return append(...args);
  });
  await f.service.command(f.context, "retry", decodeCodeOperationId(randomUUID()));
  await vi.waitFor(async () =>
    expect((await view(f.service, f.context)).preparation?.state).toBe("cleanup-uncertain"),
  );
  expect(
    await f.service.command(f.context, "retry", decodeCodeOperationId(randomUUID())),
  ).toMatchObject({ status: "refused" });
  expect(f.execute).toHaveBeenCalledOnce();
  f.connection.close();
});
it("keeps setup inside a child's command and network authority", async () => {
  const refused = fixture();
  expect(await refused.service.ensure({ ...refused.context, commandAccess: false })).toContain(
    "does not authorize",
  );
  expect(refused.execute).not.toHaveBeenCalled();
  refused.connection.close();
  const limited = fixture();
  expect(
    await limited.service.ensure({ ...limited.context, networkAllowed: false }),
  ).toBeUndefined();
  expect(limited.execute).toHaveBeenCalledWith(
    expect.objectContaining({ networkAccess: "none", environment: {} }),
    expect.any(AbortSignal),
  );
  limited.connection.close();
});
it("refuses setup launches and skip while owned process recovery is uncertain", async () => {
  const f = fixture();
  const service = new WorktreePreparationService({ ...f.options, processRecovery: "uncertain" });
  expect((await view(service, f.context)).preparation?.state).toBe("pending");
  expect(await service.ensure(f.context)).toContain("recovery is uncertain");
  for (const action of ["retry", "skip"] as const)
    expect(
      await service.command(f.context, action, decodeCodeOperationId(randomUUID())),
    ).toMatchObject({
      status: "refused",
      message: expect.stringContaining("recovery is uncertain"),
    });
  expect(f.execute).not.toHaveBeenCalled();
  f.connection.close();
});
