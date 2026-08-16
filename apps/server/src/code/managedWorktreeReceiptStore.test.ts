import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ManagedWorktreeReceiptStore,
  type CreateManagedWorktreeReceiptInput,
} from "./managedWorktreeReceiptStore";

const directories: string[] = [];
const receiptId = "50000000-0000-4000-8000-000000000001";
const createdAt = "2026-07-20T12:00:00.000Z";
const repositoryId = `repo_${"a".repeat(64)}`;
const input: CreateManagedWorktreeReceiptInput = {
  repositoryId,
  threadId: "50000000-0000-4000-8000-000000000002",
  checkoutId: "50000000-0000-4000-8000-000000000003",
  canonicalRepositoryPath: "/Users/octant/repository",
  canonicalWorktreePath: "/Users/octant/.octant-worktrees/repository/thread",
  branchIntent: "octant/thread",
  refIntent: "refs/heads/development",
  expectedHead: "a".repeat(40),
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "octant-worktree-receipts-"));
  directories.push(directory);
  return directory;
}

function store(directory: string, uuid = () => receiptId) {
  return new ManagedWorktreeReceiptStore({
    dataDirectory: directory,
    clock: () => createdAt,
    uuid,
  });
}

function receiptPath(directory: string, id = receiptId): string {
  return join(directory, "managed-worktree-receipts", `${id}.json`);
}

describe("ManagedWorktreeReceiptStore", () => {
  it("writes a creating receipt atomically outside the worktree with private modes", async () => {
    const directory = await dataDirectory();
    const created = await store(directory).create(input);

    expect(created).toEqual({
      version: 1,
      receiptId,
      ...input,
      state: "creating",
      createdAt,
      updatedAt: createdAt,
    });
    expect(JSON.parse(await readFile(receiptPath(directory), "utf8"))).toEqual(created);
    expect((await stat(join(directory, "managed-worktree-receipts"))).mode & 0o777).toBe(0o700);
    expect((await stat(receiptPath(directory))).mode & 0o777).toBe(0o600);
  });

  it("persists and reloads the exact source provenance for replay", async () => {
    const directory = await dataDirectory();
    const source = {
      mode: "origin" as const,
      branch: "development",
      remoteName: "origin",
      resolvedHead: "a".repeat(40),
      fetchedAt: createdAt,
    };
    const created = await store(directory).create({ ...input, source });

    expect(created.source).toEqual(source);
    const reloaded = await new ManagedWorktreeReceiptStore({ dataDirectory: directory }).load(
      receiptId,
    );
    expect(reloaded?.source).toEqual(source);
  });

  it("ignores an interrupted temporary write and reloads committed state", async () => {
    const directory = await dataDirectory();
    const receipts = join(directory, "managed-worktree-receipts");
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await writeFile(join(receipts, `.${receiptId}.interrupted.tmp`), "partial", { mode: 0o600 });

    const created = await store(directory).create(input);
    const reloaded = await new ManagedWorktreeReceiptStore({ dataDirectory: directory }).load(
      receiptId,
    );

    expect(reloaded).toEqual(created);
  });

  it.each([
    ["malformed", "not json"],
    [
      "excess fields",
      JSON.stringify({
        version: 1,
        receiptId,
        ...input,
        state: "creating",
        createdAt,
        updatedAt: createdAt,
        unexpected: true,
      }),
    ],
  ])("fails closed for %s persisted receipts", async (_label, contents) => {
    const directory = await dataDirectory();
    const receipts = join(directory, "managed-worktree-receipts");
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await writeFile(receiptPath(directory), contents, { mode: 0o600 });

    await expect(store(directory).load(receiptId)).rejects.toThrow(
      "invalid managed worktree receipt",
    );
  });

  it("refuses receipt identity collisions without overwriting the first receipt", async () => {
    const directory = await dataDirectory();
    const receipts = store(directory);
    const created = await receipts.create(input);

    await expect(receipts.create({ ...input, branchIntent: "octant/other" })).rejects.toThrow(
      "already exists",
    );

    expect(await receipts.load(receiptId)).toEqual(created);
  });

  it("atomically reserves one receipt owner for each canonical managed target", async () => {
    const directory = await dataDirectory();
    const competingId = "50000000-0000-4000-8000-000000000099";

    const results = await Promise.allSettled([
      store(directory, () => receiptId).create(input),
      store(directory, () => competingId).create({
        ...input,
        checkoutId: "50000000-0000-4000-8000-000000000098",
        branchIntent: "octant/competing",
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("allows only forward lifecycle transitions and persists them across reload", async () => {
    const directory = await dataDirectory();
    const receipts = store(directory);
    await receipts.create(input);

    await expect(receipts.transition(receiptId, "ready")).resolves.toMatchObject({
      state: "ready",
    });
    await expect(receipts.transition(receiptId, "cleanup-pending")).resolves.toMatchObject({
      state: "cleanup-pending",
    });
    await expect(receipts.transition(receiptId, "removed")).resolves.toMatchObject({
      state: "removed",
    });
    await expect(receipts.transition(receiptId, "ready")).rejects.toThrow(
      "invalid managed worktree receipt transition",
    );
    await expect(
      new ManagedWorktreeReceiptStore({ dataDirectory: directory }).load(receiptId),
    ).resolves.toMatchObject({
      state: "removed",
    });
  });

  it("finds one exact active receipt for crash recovery and fails closed on conflict", async () => {
    const directory = await dataDirectory();
    const receipts = store(directory);
    const created = await receipts.create(input);

    await expect(receipts.findActive(input)).resolves.toEqual(created);
    await expect(receipts.findActive({ ...input, branchIntent: "octant/other" })).rejects.toThrow(
      "conflicting",
    );
  });

  it("enforces private modes on existing receipt directories and receipt files", async () => {
    const directory = await dataDirectory();
    const receipts = join(directory, "managed-worktree-receipts");
    await mkdir(receipts, { recursive: true, mode: 0o755 });
    await store(directory).create(input);

    expect((await stat(receipts)).mode & 0o777).toBe(0o700);
    expect((await stat(receiptPath(directory))).mode & 0o777).toBe(0o600);
  });
});
