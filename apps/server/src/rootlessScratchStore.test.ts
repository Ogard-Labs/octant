import { access, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRootlessTurnId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RootlessScratchStore } from "./rootlessScratchStore";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RootlessScratchStore", () => {
  it("creates fresh per-turn roots with owner-only permissions and purges them", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-scratch-"));
    directories.push(dataDirectory);
    const store = new RootlessScratchStore(dataDirectory);
    const firstId = decodeRootlessTurnId("00000000-0000-4000-8000-000000000801");
    const secondId = decodeRootlessTurnId("00000000-0000-4000-8000-000000000802");

    const first = await store.acquire(firstId);
    await writeFile(join(first, "temporary.txt"), "temporary");
    const second = await store.acquire(secondId);

    expect(first).not.toBe(second);
    expect((await lstat(first)).mode & 0o777).toBe(0o700);
    expect((await lstat(second)).mode & 0o777).toBe(0o700);
    await store.purge(firstId);
    await store.purge(secondId);
    await expect(access(first)).rejects.toThrow();
    await expect(access(second)).rejects.toThrow();
  });

  it("rejects a linked storage root without touching its target", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-link-"));
    const external = await mkdtemp(join(tmpdir(), "octant-rootless-external-"));
    directories.push(dataDirectory, external);
    await mkdir(dataDirectory, { recursive: true });
    await symlink(external, join(dataDirectory, "rootless-scratch"), "dir");
    const marker = join(external, "must-remain.txt");
    await writeFile(marker, "preserved");
    const store = new RootlessScratchStore(dataDirectory);

    await expect(
      store.acquire(decodeRootlessTurnId("00000000-0000-4000-8000-000000000803")),
    ).rejects.toThrow("not a plain directory");
    await expect(access(marker)).resolves.toBeUndefined();
  });
});
