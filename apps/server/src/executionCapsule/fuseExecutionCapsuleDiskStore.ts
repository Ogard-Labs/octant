import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

export interface ExecutionCapsuleDiskCommandRunner {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

export interface ExecutionCapsuleDiskMountProbe {
  readonly isMounted: (mountPath: string) => Promise<boolean>;
}

export interface ExecutionCapsuleDiskLocation {
  readonly directory: string;
  readonly imagePath: string;
  readonly mountPath: string;
  readonly graphRoot: string;
  readonly runRoot: string;
  readonly diskBytes: number;
}

export interface ExecutionCapsuleDiskStore {
  readonly create: (input: {
    readonly runtimeId: string;
    readonly diskBytes: number;
  }) => Promise<ExecutionCapsuleDiskLocation>;
  readonly recover: (input: {
    readonly runtimeId: string;
    readonly diskBytes: number;
  }) => Promise<ExecutionCapsuleDiskLocation>;
  readonly close: (location: ExecutionCapsuleDiskLocation) => Promise<void>;
  readonly release: (location: ExecutionCapsuleDiskLocation) => Promise<void>;
}

export interface FuseExecutionCapsuleDiskStoreOptions {
  readonly stateRoot: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly runner: ExecutionCapsuleDiskCommandRunner;
  readonly mountProbe?: ExecutionCapsuleDiskMountProbe;
  readonly mkfsPath?: string;
  readonly fuse2fsPath?: string;
  readonly fusermountPath?: string;
}

/**
 * Gives each capsule a durable, fixed-size filesystem without requiring the
 * Station identity to administer host project quotas or mount block devices.
 */
export class FuseExecutionCapsuleDiskStore implements ExecutionCapsuleDiskStore {
  readonly #stateRoot: string;
  readonly #expectedUid: number;
  readonly #expectedGid: number;
  readonly #runner: ExecutionCapsuleDiskCommandRunner;
  readonly #mountProbe: ExecutionCapsuleDiskMountProbe;
  readonly #mkfsPath: string;
  readonly #fuse2fsPath: string;
  readonly #fusermountPath: string;

  constructor(options: FuseExecutionCapsuleDiskStoreOptions) {
    this.#stateRoot = options.stateRoot;
    this.#expectedUid = options.expectedUid;
    this.#expectedGid = options.expectedGid;
    this.#runner = options.runner;
    this.#mountProbe = options.mountProbe ?? createProcMountProbe();
    this.#mkfsPath = options.mkfsPath ?? "/usr/sbin/mkfs.ext4";
    this.#fuse2fsPath = options.fuse2fsPath ?? "/usr/bin/fuse2fs";
    this.#fusermountPath = options.fusermountPath ?? "/usr/bin/fusermount3";
  }

  async create(input: {
    readonly runtimeId: string;
    readonly diskBytes: number;
  }): Promise<ExecutionCapsuleDiskLocation> {
    const location = this.#location(input);
    await ensurePrivateDirectory(this.#stateRoot, this.#expectedUid, true);
    const storesRoot = join(this.#stateRoot, "stores");
    await ensurePrivateDirectory(storesRoot, this.#expectedUid, true);
    await mkdir(location.directory, { mode: 0o700 });
    await ensurePrivateDirectory(location.directory, this.#expectedUid, false);

    try {
      const image = await open(
        location.imagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await image.truncate(location.diskBytes);
      } finally {
        await image.close();
      }
      await this.#verifyImage(location);
      const formatted = await this.#runner.run(this.#mkfsPath, [
        "-q",
        "-t",
        "ext4",
        "-F",
        "-E",
        `root_owner=${String(this.#expectedUid)}:${String(this.#expectedGid)}`,
        location.imagePath,
      ]);
      if (formatted.exitCode !== 0) throw new Error("Execution capsule disk format failed.");
      await mkdir(location.mountPath, { mode: 0o700 });
      await ensurePrivateDirectory(location.mountPath, this.#expectedUid, false);
      await this.#mount(location);
      await this.#prepareMountedStore(location);
      return location;
    } catch (error) {
      await this.close(location).catch(() => undefined);
      await rm(location.directory, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async recover(input: {
    readonly runtimeId: string;
    readonly diskBytes: number;
  }): Promise<ExecutionCapsuleDiskLocation> {
    const location = this.#location(input);
    await ensurePrivateDirectory(this.#stateRoot, this.#expectedUid, false);
    await ensurePrivateDirectory(join(this.#stateRoot, "stores"), this.#expectedUid, false);
    await ensurePrivateDirectory(location.directory, this.#expectedUid, false);
    await this.#verifyImage(location);
    await ensurePrivateDirectory(location.mountPath, this.#expectedUid, false);
    if (!(await this.#mountProbe.isMounted(location.mountPath))) await this.#mount(location);
    await this.#prepareMountedStore(location);
    return location;
  }

  async close(location: ExecutionCapsuleDiskLocation): Promise<void> {
    this.#assertOwnedLocation(location);
    if (!(await this.#mountProbe.isMounted(location.mountPath))) return;
    const unmounted = await this.#runner.run(this.#fusermountPath, ["-u", location.mountPath]);
    if (unmounted.exitCode !== 0 || (await this.#mountProbe.isMounted(location.mountPath))) {
      throw new Error("Execution capsule disk unmount failed.");
    }
  }

  async release(location: ExecutionCapsuleDiskLocation): Promise<void> {
    await this.close(location);
    await rm(location.directory, { force: true, recursive: true });
  }

  #location(input: {
    readonly runtimeId: string;
    readonly diskBytes: number;
  }): ExecutionCapsuleDiskLocation {
    if (
      !isAbsolute(this.#stateRoot) ||
      !/^octant-capsule-[a-f0-9]{32}$/.test(input.runtimeId) ||
      !Number.isSafeInteger(input.diskBytes) ||
      input.diskBytes < 256 * 1_024 * 1_024 ||
      input.diskBytes > 16 * 1_024 ** 4
    ) {
      throw new Error("Execution capsule disk request is invalid.");
    }
    const directory = join(this.#stateRoot, "stores", input.runtimeId);
    const mountPath = join(directory, "mount");
    return {
      directory,
      imagePath: join(directory, "capsule.ext4"),
      mountPath,
      graphRoot: join(mountPath, "graph"),
      runRoot: join(mountPath, "run"),
      diskBytes: input.diskBytes,
    };
  }

  async #verifyImage(location: ExecutionCapsuleDiskLocation): Promise<void> {
    const metadata = await lstat(location.imagePath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.uid !== this.#expectedUid ||
      metadata.nlink !== 1 ||
      metadata.size !== location.diskBytes ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("Execution capsule backing image is unsafe.");
    }
  }

  #assertOwnedLocation(location: ExecutionCapsuleDiskLocation): void {
    let expected: ExecutionCapsuleDiskLocation;
    try {
      expected = this.#location({
        runtimeId: basename(location.directory),
        diskBytes: location.diskBytes,
      });
    } catch {
      throw new Error("Execution capsule disk location is not owned.");
    }
    if (
      location.directory !== expected.directory ||
      location.imagePath !== expected.imagePath ||
      location.mountPath !== expected.mountPath ||
      location.graphRoot !== expected.graphRoot ||
      location.runRoot !== expected.runRoot
    ) {
      throw new Error("Execution capsule disk location is not owned.");
    }
  }

  async #mount(location: ExecutionCapsuleDiskLocation): Promise<void> {
    const mounted = await this.#runner.run(this.#fuse2fsPath, [
      "-o",
      "rw,allow_other,fakeroot,nodev,nosuid",
      location.imagePath,
      location.mountPath,
    ]);
    if (mounted.exitCode !== 0 || !(await this.#mountProbe.isMounted(location.mountPath))) {
      throw new Error("Execution capsule disk mount failed.");
    }
  }

  async #prepareMountedStore(location: ExecutionCapsuleDiskLocation): Promise<void> {
    await chmod(location.mountPath, 0o700);
    await ensurePrivateMountedDirectory(location.mountPath, this.#expectedUid, false);
    await ensurePrivateMountedDirectory(location.graphRoot, this.#expectedUid, true);
    await rm(location.runRoot, { force: true, recursive: true });
    await ensurePrivateMountedDirectory(location.runRoot, this.#expectedUid, true);
  }
}

async function ensurePrivateMountedDirectory(
  path: string,
  expectedUid: number,
  create: boolean,
): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.uid !== expectedUid && metadata.uid !== 0) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Execution capsule mounted directory is not private.");
  }
}

async function ensurePrivateDirectory(
  path: string,
  expectedUid: number,
  create: boolean,
): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== expectedUid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Execution capsule disk directory is not owner-only.");
  }
}

function createProcMountProbe(): ExecutionCapsuleDiskMountProbe {
  return {
    isMounted: async (mountPath) => {
      const encodedMountPath = encodeMountInfoPath(mountPath);
      const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
      return mountInfo
        .split("\n")
        .some((line) => line.length > 0 && line.split(" ")[4] === encodedMountPath);
    },
  };
}

function encodeMountInfoPath(path: string): string {
  return path
    .replaceAll("\\", "\\134")
    .replaceAll(" ", "\\040")
    .replaceAll("\t", "\\011")
    .replaceAll("\n", "\\012");
}
