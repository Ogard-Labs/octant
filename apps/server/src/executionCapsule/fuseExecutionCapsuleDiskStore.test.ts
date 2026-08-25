import { chmod, lstat, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FuseExecutionCapsuleDiskStore,
  type ExecutionCapsuleDiskCommandRunner,
} from "./fuseExecutionCapsuleDiskStore";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

function fixture() {
  let mounted = false;
  const run = vi.fn<ExecutionCapsuleDiskCommandRunner["run"]>(async (command) => {
    if (command === "/usr/bin/fuse2fs") mounted = true;
    if (command === "/usr/bin/fusermount3") mounted = false;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return {
    run,
    mountProbe: { isMounted: async () => mounted },
  };
}

describe("FuseExecutionCapsuleDiskStore", () => {
  it("creates a hard-sized owner-only image for one private Podman VFS store", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "octant-capsule-disk-test-"));
    roots.push(stateRoot);
    await chmod(stateRoot, 0o700);
    const { run, mountProbe } = fixture();
    const store = new FuseExecutionCapsuleDiskStore({
      stateRoot,
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
      runner: { run },
      mountProbe,
    });

    const disk = await store.create({
      runtimeId: "octant-capsule-11111111111141118111111111111111",
      diskBytes: 256 * 1_024 * 1_024,
    });

    expect(disk).toEqual({
      directory: join(stateRoot, "stores", "octant-capsule-11111111111141118111111111111111"),
      imagePath: join(
        stateRoot,
        "stores",
        "octant-capsule-11111111111141118111111111111111",
        "capsule.ext4",
      ),
      mountPath: join(
        stateRoot,
        "stores",
        "octant-capsule-11111111111141118111111111111111",
        "mount",
      ),
      graphRoot: join(
        stateRoot,
        "stores",
        "octant-capsule-11111111111141118111111111111111",
        "mount",
        "graph",
      ),
      runRoot: join(
        stateRoot,
        "stores",
        "octant-capsule-11111111111141118111111111111111",
        "mount",
        "run",
      ),
      diskBytes: 256 * 1_024 * 1_024,
    });
    const image = await lstat(disk.imagePath);
    expect(image.size).toBe(256 * 1_024 * 1_024);
    expect(image.mode & 0o077).toBe(0);
    expect(run).toHaveBeenCalledWith("/usr/sbin/mkfs.ext4", [
      "-q",
      "-t",
      "ext4",
      "-F",
      "-E",
      `root_owner=${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
      disk.imagePath,
    ]);
    expect(run).toHaveBeenCalledWith("/usr/bin/fuse2fs", [
      "-o",
      "rw,fakeroot,nodev,nosuid",
      disk.imagePath,
      disk.mountPath,
    ]);
  });

  it("recovers durable graph data while clearing only ephemeral Podman run state", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "octant-capsule-disk-test-"));
    roots.push(stateRoot);
    await chmod(stateRoot, 0o700);
    const { run, mountProbe } = fixture();
    const store = new FuseExecutionCapsuleDiskStore({
      stateRoot,
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
      runner: { run },
      mountProbe,
    });
    const input = {
      runtimeId: "octant-capsule-11111111111141118111111111111111",
      diskBytes: 256 * 1_024 * 1_024,
    };
    const created = await store.create(input);
    await writeFile(join(created.graphRoot, "durable"), "kept");
    await writeFile(join(created.runRoot, "stale"), "removed");
    await store.close(created);
    run.mockClear();

    const recovered = await store.recover(input);

    expect(await readFile(join(recovered.graphRoot, "durable"), "utf8")).toBe("kept");
    await expect(readFile(join(recovered.runRoot, "stale"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(run.mock.calls.some(([command]) => command === "/usr/sbin/mkfs.ext4")).toBe(false);
    expect(run.mock.calls.some(([command]) => command === "/usr/bin/fuse2fs")).toBe(true);
  });

  it("refuses a resized backing image before remounting it", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "octant-capsule-disk-test-"));
    roots.push(stateRoot);
    await chmod(stateRoot, 0o700);
    const { run, mountProbe } = fixture();
    const store = new FuseExecutionCapsuleDiskStore({
      stateRoot,
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
      runner: { run },
      mountProbe,
    });
    const input = {
      runtimeId: "octant-capsule-11111111111141118111111111111111",
      diskBytes: 256 * 1_024 * 1_024,
    };
    const created = await store.create(input);
    await store.close(created);
    await truncate(created.imagePath, input.diskBytes - 1);
    run.mockClear();

    await expect(store.recover(input)).rejects.toThrow("backing image is unsafe");
    expect(run.mock.calls.some(([command]) => command === "/usr/bin/fuse2fs")).toBe(false);
  });

  it("unmounts and removes only the released capsule store", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "octant-capsule-disk-test-"));
    roots.push(stateRoot);
    await chmod(stateRoot, 0o700);
    const { run, mountProbe } = fixture();
    const store = new FuseExecutionCapsuleDiskStore({
      stateRoot,
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
      runner: { run },
      mountProbe,
    });
    const disk = await store.create({
      runtimeId: "octant-capsule-11111111111141118111111111111111",
      diskBytes: 256 * 1_024 * 1_024,
    });

    await store.release(disk);

    expect(run).toHaveBeenCalledWith("/usr/bin/fusermount3", ["-u", disk.mountPath]);
    await expect(lstat(disk.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a forged cleanup location without touching the unrelated directory", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "octant-capsule-disk-test-"));
    roots.push(stateRoot);
    await chmod(stateRoot, 0o700);
    const { run, mountProbe } = fixture();
    const store = new FuseExecutionCapsuleDiskStore({
      stateRoot,
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
      runner: { run },
      mountProbe,
    });
    const disk = await store.create({
      runtimeId: "octant-capsule-11111111111141118111111111111111",
      diskBytes: 256 * 1_024 * 1_024,
    });
    const unrelated = join(stateRoot, "unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "kept"), "kept");

    await expect(store.release({ ...disk, directory: unrelated })).rejects.toThrow(
      "location is not owned",
    );

    expect(await readFile(join(unrelated, "kept"), "utf8")).toBe("kept");
  });
});
