import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorId, type EventActor } from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { GitMutationPort } from "./gitMutationPort";
import { GitObservationPort } from "./gitObservationPort";
import { ChildWorktreeSourceService } from "./childWorktreeSourceService";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";
import { applyProtectedFilesChoice, currentProtectedFilesChoice } from "../process/secretGuard";
const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
const clock = () => new Date().toISOString();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-child-snapshot-")));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  git("add", "tracked.txt", ".gitignore");
  git("commit", "-m", "Fixture");
  const fake = createFakeSandboxConfinement();
  directories.push(fake.root);
  const options = {
    confinement: fake.confinement,
    temporaryDirectory: fake.temporaryDirectory,
    gitExecutable: "/usr/bin/git",
  };
  const mutation = new GitMutationPort(undefined, options),
    observation = new GitObservationPort(options);
  const connection = openSqlite(join(fake.root, "journal.sqlite"));
  applyMigrations(connection, MIGRATIONS, clock);
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock,
  });
  const actor: EventActor = {
    kind: "local-user",
    actorId: Schema.decodeUnknownSync(ActorId)(randomUUID()),
  };
  const service = new ChildWorktreeSourceService({
    journal,
    mutation,
    observation,
    actor,
    clock,
    uuid: randomUUID,
  });
  const context = {
    threadId: randomUUID(),
    checkoutId: randomUUID(),
    bindingRevisionId: randomUUID(),
    root,
    head: git("rev-parse", "HEAD"),
    executionPolicy: "approval-gated" as const,
    current: () => true,
  };
  const receipt = (
    path: string,
    seed: import("@octant/contracts").ChildWorktreeSnapshotData,
  ): ManagedWorktreeReceipt => ({
    version: 1,
    receiptId: randomUUID(),
    repositoryId: `repo_${"a".repeat(64)}`,
    threadId: randomUUID(),
    checkoutId: randomUUID(),
    canonicalRepositoryPath: root,
    canonicalWorktreePath: path,
    branchIntent: "child",
    refIntent: "refs/heads/child",
    expectedHead: context.head,
    state: "ready",
    createdAt: clock(),
    updatedAt: clock(),
    seed,
  });
  return {
    root,
    git,
    service,
    context,
    connection,
    mutation,
    observation,
    journal,
    actor,
    receipt,
  };
}
it("reviews a stable staged, unstaged and untracked snapshot, leaving the parent unchanged and seeding independent children", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "tracked.txt"), "staged\n");
  f.git("add", "tracked.txt");
  writeFileSync(join(f.root, "tracked.txt"), "unstaged\n");
  writeFileSync(join(f.root, "new.txt"), "new\n");
  writeFileSync(join(f.root, "ignored.txt"), "private\n");
  mkdirSync(join(f.root, "dir"));
  writeFileSync(join(f.root, "dir/nested.txt"), "nested\n");
  const branch = f.git("symbolic-ref", "HEAD"),
    index = f.git("write-tree"),
    head = f.git("rev-parse", "HEAD"),
    status = f.git("status", "--porcelain");
  expect(f.service.inspect(f.context).selection).toBe("committed");
  const capture = await f.service.command(f.context, "capture");
  if (capture.status !== "ready") throw new Error(capture.message);
  const captured = capture.review;
  expect(captured.preview?.files.map((file) => file.path)).toEqual([
    "dir/nested.txt",
    "new.txt",
    "tracked.txt",
  ]);
  expect(f.service.inspect(f.context).selection).toBe("committed");
  await f.service.command(f.context, "use-snapshot", captured.preview?.id);
  const selected = await f.service.selected(f.context);
  if (selected.status !== "selected" || selected.snapshot === undefined)
    throw new Error("Missing selected fixture snapshot");
  const seed = selected.snapshot;
  const first = join(f.root, "..", `${randomUUID()}-first`),
    second = join(f.root, "..", `${randomUUID()}-second`);
  directories.push(first, second);
  f.git("worktree", "add", "-b", "first", first, head);
  f.git("worktree", "add", "-b", "second", second, head);
  const receipt = f.receipt(first, seed),
    sibling = f.receipt(second, seed);
  expect(await Promise.all([f.service.apply(receipt), f.service.apply(sibling)])).toEqual([
    true,
    true,
  ]);
  expect(f.git("status", "--porcelain")).toBe(status);
  expect(f.git("symbolic-ref", "HEAD")).toBe(branch);
  expect(existsSync(join(first, "ignored.txt"))).toBe(false);
  expect(readFileSync(join(first, "tracked.txt"), "utf8")).toBe("unstaged\n");
  expect(
    execFileSync("/usr/bin/git", ["-C", first, "show", ":tracked.txt"], { encoding: "utf8" }),
  ).toBe("staged\n");
  expect(readFileSync(join(second, "new.txt"), "utf8")).toBe("new\n");
  writeFileSync(join(f.root, "tracked.txt"), "later parent\n");
  writeFileSync(join(first, "new.txt"), "first only\n");
  expect(readFileSync(join(second, "new.txt"), "utf8")).toBe("new\n");
  expect(readFileSync(join(first, "tracked.txt"), "utf8")).toBe("unstaged\n");
  expect(f.git("write-tree")).toBe(index);
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(status).toContain("MM tracked.txt");
  expect(f.service.applied(receipt)).toBe(true);
  expect(await f.service.apply(receipt)).toBe(false);
  f.connection.close();
});
it("refuses a stale source before creating or modifying a child", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "new.txt"), "new");
  const capture = await f.service.command(f.context, "capture");
  if (capture.status !== "ready") throw new Error(capture.message);
  const captured = capture.review;
  await f.service.command(f.context, "use-snapshot", captured.preview?.id);
  expect(await f.service.selected({ ...f.context, head: "b".repeat(40) })).toMatchObject({
    status: "refused",
    message: expect.stringContaining("revision"),
  });
  f.connection.close();
});

it("refuses protected source files before recording a snapshot for children", async () => {
  const f = fixture();
  const previous = currentProtectedFilesChoice();
  const path = join(f.root, "protected.txt");
  writeFileSync(path, "disposable fixture content");
  try {
    applyProtectedFilesChoice({ ...previous, added: [...previous.added, path] });
    expect(await f.service.command(f.context, "capture")).toMatchObject({
      status: "refused",
      message: expect.stringContaining("protected"),
    });
    expect(f.service.inspect(f.context)).toEqual({ selection: "committed" });
  } finally {
    applyProtectedFilesChoice(previous);
    f.connection.close();
  }
});

it("refuses a capture when the parent changes during preparation", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "new.txt"), "first");
  let reads = 0;
  const service = new ChildWorktreeSourceService({
    journal: f.journal,
    mutation: f.mutation,
    observation: {
      observe: async (root, signal, options) => {
        reads++;
        if (reads === 2) writeFileSync(join(f.root, "new.txt"), "changed during capture");
        return f.observation.observe(root, signal, options);
      },
    },
    actor: f.actor,
    clock,
    uuid: randomUUID,
  });
  expect(await service.command(f.context, "capture")).toMatchObject({
    status: "refused",
    message: expect.stringContaining("changed during capture"),
  });
  expect(service.inspect(f.context).selection).toBe("committed");
  f.connection.close();
});
