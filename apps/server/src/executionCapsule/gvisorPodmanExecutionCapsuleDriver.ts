import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExecutionCapsuleAvailableCapacity } from "@octant/domain/execution-capsule-policy";
import type {
  ExecutionCapsuleCommandResult,
  ExecutionCapsuleDriver,
  ExecutionCapsuleDriverCreateResult,
  ExecutionCapsuleDriverCreateInput,
  ExecutionCapsuleDriverExecuteInput,
  ExecutionCapsuleDriverExportResult,
  ExecutionCapsuleDriverProbe,
} from "./executionCapsuleService";
import {
  FuseExecutionCapsuleDiskStore,
  type ExecutionCapsuleDiskLocation,
  type ExecutionCapsuleDiskStore,
} from "./fuseExecutionCapsuleDiskStore";

const execFileAsync = promisify(execFile);

export interface ExecutionCapsuleCommandResultPort {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecutionCapsuleCommandRunner {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Promise<ExecutionCapsuleCommandResultPort>;
}

export interface ExecutionCapsuleArtifactWriter {
  readonly write: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly artifactPath: string;
    readonly maxBytes: number;
  }) => Promise<{ readonly exitCode: number; readonly stderr: string }>;
}

export interface ExecutionCapsuleSourceBundleStore {
  readonly verify: (source: ExecutionCapsuleDriverCreateInput["source"]) => Promise<void>;
}

export interface ExecutionCapsuleGitBundleStore {
  readonly reserve: (runtimeId: string) => Promise<string>;
  readonly verify: (input: {
    readonly artifactPath: string;
    readonly expectedSha256: string;
  }) => Promise<{ readonly sha256: string; readonly byteLength: number }>;
  readonly discard?: (artifactPath: string) => Promise<void>;
}

export interface GvisorPodmanExecutionCapsuleDriverOptions {
  readonly stateRoot: string;
  readonly capacity: ExecutionCapsuleAvailableCapacity;
  readonly platform?: string;
  readonly username?: string;
  readonly uid?: number;
  readonly podmanPath?: string;
  readonly runscPath?: string;
  readonly systemdRunPath?: string;
  readonly runner?: ExecutionCapsuleCommandRunner;
  readonly sourceBundleStore?: ExecutionCapsuleSourceBundleStore;
  readonly bundleStore?: ExecutionCapsuleGitBundleStore;
  readonly runtimeEnvironment?: ExecutionCapsuleRuntimeEnvironment;
  readonly homeDirectory?: string;
  readonly expectedHomeDirectory?: string;
  readonly gid?: number;
  readonly supplementaryGroups?: ReadonlyArray<number>;
  readonly identityProbe?: ExecutionCapsuleStationIdentityProbe;
  readonly diskStore?: ExecutionCapsuleDiskStore;
  readonly recordDiagnostic?: (diagnostic: {
    readonly operation: string;
    readonly message: string;
  }) => void;
  readonly artifactWriter?: ExecutionCapsuleArtifactWriter;
}

export interface ExecutionCapsuleRuntimeEnvironment {
  readonly homeDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly sessionBusAddress?: string;
}

export interface ExecutionCapsuleStationIdentityProbe {
  readonly probe: () => Promise<{
    readonly passwordlessSudo: boolean;
    readonly dockerSocketAccessible: boolean;
  }>;
}

interface GvisorPodmanRuntime {
  readonly runtimeId: string;
  readonly capsuleId: string;
  readonly image: string;
  readonly disk: ExecutionCapsuleDiskLocation;
  readonly state: "ready" | "stopped";
}

/**
 * Linux execution-capsule adapter. The probe executes gVisor's systrap path;
 * observing a binary or version string alone never advertises protection.
 */
export class GvisorPodmanExecutionCapsuleDriver implements ExecutionCapsuleDriver {
  readonly #stateRoot: string;
  readonly #capacity: ExecutionCapsuleAvailableCapacity;
  readonly #platform: string;
  readonly #username: string;
  readonly #uid: number;
  readonly #gid: number;
  readonly #supplementaryGroups: ReadonlyArray<number>;
  readonly #homeDirectory: string;
  readonly #expectedHomeDirectory: string;
  readonly #podmanPath: string;
  readonly #runscPath: string;
  readonly #systemdRunPath: string;
  readonly #runner: ExecutionCapsuleCommandRunner;
  readonly #sourceBundleStore: ExecutionCapsuleSourceBundleStore;
  readonly #bundleStore: ExecutionCapsuleGitBundleStore;
  readonly #identityProbe: ExecutionCapsuleStationIdentityProbe;
  readonly #diskStore: ExecutionCapsuleDiskStore;
  readonly #recordDiagnostic:
    | ((diagnostic: { readonly operation: string; readonly message: string }) => void)
    | undefined;
  readonly #artifactWriter: ExecutionCapsuleArtifactWriter;
  readonly #runtimes = new Map<string, GvisorPodmanRuntime>();

  constructor(options: GvisorPodmanExecutionCapsuleDriverOptions) {
    const currentUser = userInfo();
    const runtimeEnvironment = options.runtimeEnvironment ?? defaultRuntimeEnvironment();
    this.#stateRoot = options.stateRoot;
    this.#capacity = options.capacity;
    this.#platform = options.platform ?? process.platform;
    this.#username = options.username ?? currentUser.username;
    this.#uid = options.uid ?? process.getuid?.() ?? 0;
    this.#gid = options.gid ?? process.getgid?.() ?? 0;
    this.#supplementaryGroups = options.supplementaryGroups ?? process.getgroups?.() ?? [];
    this.#homeDirectory = options.homeDirectory ?? currentUser.homedir;
    this.#expectedHomeDirectory = options.expectedHomeDirectory ?? "/var/lib/octant";
    this.#podmanPath = options.podmanPath ?? "/usr/bin/podman";
    this.#runscPath = options.runscPath ?? "/usr/bin/runsc";
    this.#systemdRunPath = options.systemdRunPath ?? "/usr/bin/systemd-run";
    this.#runner = options.runner ?? createNodeCommandRunner(runtimeEnvironment);
    this.#sourceBundleStore =
      options.sourceBundleStore ??
      createExecutionCapsuleSourceBundleStore({ expectedUid: this.#uid });
    this.#bundleStore =
      options.bundleStore ??
      createExecutionCapsuleGitBundleStore({
        stateRoot: this.#stateRoot,
        expectedUid: this.#uid,
      });
    this.#identityProbe =
      options.identityProbe ?? createStationIdentityProbe({ runner: this.#runner });
    this.#diskStore =
      options.diskStore ??
      new FuseExecutionCapsuleDiskStore({
        stateRoot: this.#stateRoot,
        runRootBase: join(
          runtimeEnvironment.runtimeDirectory ?? `/run/user/${String(this.#uid)}`,
          "o",
        ),
        expectedUid: this.#uid,
        expectedGid: this.#gid,
        podmanPath: this.#podmanPath,
        runner: this.#runner,
      });
    this.#recordDiagnostic = options.recordDiagnostic;
    this.#artifactWriter = options.artifactWriter ?? createNodeArtifactWriter(runtimeEnvironment);
  }

  #reportDiagnostic(operation: string, message: string): void {
    try {
      this.#recordDiagnostic?.({ operation, message });
    } catch {
      // Diagnostics never change the user-visible outcome.
    }
  }

  async probe(): Promise<ExecutionCapsuleDriverProbe> {
    const identity = await this.#identityProbe.probe().catch(() => ({
      passwordlessSudo: true,
      dockerSocketAccessible: true,
    }));
    const dedicatedIdentity =
      this.#username === "octant" &&
      this.#uid > 0 &&
      this.#gid > 0 &&
      this.#homeDirectory === this.#expectedHomeDirectory &&
      this.#supplementaryGroups.every((group) => group === this.#gid) &&
      !identity.passwordlessSudo &&
      !identity.dockerSocketAccessible;
    if (
      this.#platform !== "linux" ||
      !isAbsolute(this.#podmanPath) ||
      !isAbsolute(this.#runscPath) ||
      !isAbsolute(this.#systemdRunPath) ||
      !isAbsolute(this.#stateRoot)
    ) {
      return unavailableProbe(this.#platform, dedicatedIdentity, this.#capacity);
    }

    const podmanInfo = await this.#runner
      .run(this.#podmanPath, ["info", "--format", "json"])
      .catch(() => undefined);
    const facts = podmanInfo?.exitCode === 0 ? decodePodmanInfo(podmanInfo.stdout) : undefined;
    const rootlessPodman = facts?.rootless === true;
    const cgroupsV2 = facts?.cgroupVersion === "v2";
    const systrapProbe = await this.#runner
      .run(this.#podmanPath, [
        "unshare",
        this.#runscPath,
        // `runsc do` has no OCI cgroup path. Real capsules use the systemd
        // driver below; this probe proves only that systrap executes.
        "--ignore-cgroups",
        "--platform=systrap",
        "--network=none",
        "do",
        "true",
      ])
      .catch(() => undefined);
    const systrap = systrapProbe?.exitCode === 0;

    return {
      host: {
        platform: this.#platform,
        rootlessPodman,
        runsc: systrap,
        systrap,
        cgroupsV2,
        dedicatedIdentity,
      },
      available: this.#capacity,
    };
  }

  async create(
    input: ExecutionCapsuleDriverCreateInput,
  ): Promise<ExecutionCapsuleDriverCreateResult> {
    const probe = await this.probe();
    if (
      !probe.host.rootlessPodman ||
      !probe.host.runsc ||
      !probe.host.systrap ||
      !probe.host.cgroupsV2 ||
      !probe.host.dedicatedIdentity
    ) {
      return { status: "refused", reason: "runtime-unavailable" };
    }
    if (
      !isAbsolute(input.source.bundlePath) ||
      !/^[a-f0-9]{64}$/.test(input.source.sha256) ||
      !Number.isSafeInteger(input.source.byteLength) ||
      input.source.byteLength < 1 ||
      input.source.byteLength > 1_024 * 1_024 * 1_024 ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.source.revision)
    ) {
      return { status: "refused", reason: "source-unavailable" };
    }

    const runtimeId = capsuleRuntimeId(String(input.request.capsuleId));
    if (this.#runtimes.has(runtimeId)) return { status: "refused", reason: "creation-failed" };

    try {
      await this.#sourceBundleStore.verify(input.source);
    } catch {
      return { status: "refused", reason: "source-unavailable" };
    }

    let disk: ExecutionCapsuleDiskLocation;
    try {
      disk = await this.#diskStore.create({
        runtimeId,
        diskBytes: input.request.budget.diskBytes,
      });
    } catch {
      return { status: "refused", reason: "creation-failed" };
    }

    let created = false;
    try {
      const create = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(disk),
        ...gvisorRuntimeArgs(this.#runscPath),
        "create",
        "--name",
        runtimeId,
        "--log-driver",
        "none",
        "--network",
        "none",
        "--cgroups",
        "no-conmon",
        "--userns",
        "auto",
        "--user",
        "0:0",
        "--cap-drop",
        "all",
        "--security-opt",
        "no-new-privileges",
        "--workdir",
        "/",
        "--env",
        "HOME=/workspace/.home",
        "--env",
        "TMPDIR=/tmp",
        "--label",
        `app.octant.capsule=${String(input.request.capsuleId)}`,
        "--entrypoint",
        "/bin/sh",
        String(input.request.recipe.image),
        "-c",
        "while :; do sleep 3600; done",
      ]);
      if (create.exitCode !== 0) return { status: "refused", reason: "creation-failed" };
      created = true;
      if (!(await this.#provisionMappedDirectory(disk, runtimeId, "/workspace"))) {
        return { status: "refused", reason: "creation-failed" };
      }

      const copied = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(disk),
        "cp",
        input.source.bundlePath,
        `${runtimeId}:/tmp/octant-source.bundle`,
      ]);
      if (copied.exitCode !== 0) return { status: "refused", reason: "creation-failed" };
      const started = await this.#startInBudgetScope({
        disk,
        runtimeId,
        cpuMillicores: input.request.budget.cpuMillicores,
        memoryBytes: input.request.budget.memoryBytes,
        pidLimit: input.request.budget.pidLimit,
      });
      if (started.exitCode !== 0) return { status: "refused", reason: "creation-failed" };
      const cloned = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(disk),
        "exec",
        "--workdir",
        "/",
        "--",
        runtimeId,
        "git",
        "clone",
        "/tmp/octant-source.bundle",
        "/workspace",
      ]);
      if (cloned.exitCode !== 0) return { status: "refused", reason: "creation-failed" };
      const checkedOut = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(disk),
        "exec",
        "--workdir",
        "/workspace",
        "--",
        runtimeId,
        "git",
        "checkout",
        "-b",
        `octant-capsule-${String(input.request.capsuleId).replaceAll("-", "")}`,
        input.source.revision,
      ]);
      if (checkedOut.exitCode !== 0) return { status: "refused", reason: "creation-failed" };
      const home = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(disk),
        "exec",
        "--workdir",
        "/workspace",
        "--",
        runtimeId,
        "mkdir",
        "-p",
        "/workspace/.home",
      ]);
      if (home.exitCode !== 0) return { status: "refused", reason: "creation-failed" };
      await this.#runner
        .run(this.#podmanPath, [
          ...podmanStoreArgs(disk),
          "exec",
          "--workdir",
          "/workspace",
          "--",
          runtimeId,
          "rm",
          "-f",
          "/tmp/octant-source.bundle",
        ])
        .catch(() => undefined);
      for (const argv of input.request.recipe.setup) {
        const setup = await this.#runner.run(this.#podmanPath, [
          ...podmanStoreArgs(disk),
          "exec",
          "--workdir",
          "/workspace",
          "--",
          runtimeId,
          ...argv,
        ]);
        if (setup.exitCode !== 0) return { status: "refused", reason: "creation-failed" };
      }

      this.#runtimes.set(runtimeId, {
        runtimeId,
        capsuleId: String(input.request.capsuleId),
        image: String(input.request.recipe.image),
        disk,
        state: "ready",
      });
      return { status: "ready", runtimeId };
    } finally {
      if (created && !this.#runtimes.has(runtimeId)) {
        await this.#runner
          .run(this.#podmanPath, [
            ...podmanStoreArgs(disk),
            "rm",
            "--force",
            "--time",
            "10",
            runtimeId,
          ])
          .catch(() => undefined);
      }
      if (!this.#runtimes.has(runtimeId)) {
        await this.#diskStore.release(disk).catch(() => undefined);
      }
    }
  }

  async #provisionMappedDirectory(
    disk: ExecutionCapsuleDiskLocation,
    runtimeId: string,
    destination: "/verify" | "/workspace",
  ): Promise<boolean> {
    let seedDirectory: string | undefined;
    try {
      seedDirectory = await mkdtemp(join(tmpdir(), `octant-capsule-${destination.slice(1)}-`));
      const copied = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(disk),
        "cp",
        "--archive=true",
        seedDirectory,
        `${runtimeId}:${destination}`,
      ]);
      return copied.exitCode === 0;
    } catch {
      return false;
    } finally {
      if (seedDirectory !== undefined) {
        await rm(seedDirectory, { force: true, recursive: true }).catch(() => undefined);
      }
    }
  }

  #startInBudgetScope(input: {
    readonly disk: ExecutionCapsuleDiskLocation;
    readonly runtimeId: string;
    readonly cpuMillicores: number;
    readonly memoryBytes: number;
    readonly pidLimit: number;
  }): Promise<ExecutionCapsuleCommandResultPort> {
    return this.#runner.run(this.#systemdRunPath, [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--unit",
      `${input.runtimeId}.scope`,
      "--property",
      `CPUQuota=${formatCpuQuota(input.cpuMillicores)}`,
      "--property",
      `MemoryMax=${String(input.memoryBytes)}`,
      "--property",
      `TasksMax=${String(input.pidLimit)}`,
      this.#podmanPath,
      ...podmanStoreArgs(input.disk),
      ...gvisorRuntimeArgs(this.#runscPath),
      "start",
      input.runtimeId,
    ]);
  }

  async execute(
    input: ExecutionCapsuleDriverExecuteInput,
  ): Promise<Exclude<ExecutionCapsuleCommandResult, { readonly status: "refused" }>> {
    const runtime = this.#runtimes.get(input.runtimeId);
    if (runtime?.state !== "ready") {
      return { status: "failed", reason: "runtime-unavailable" };
    }
    const executed = await this.#runner
      .run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "exec",
        "--workdir",
        "/workspace",
        "--",
        input.runtimeId,
        ...input.argv,
      ])
      .catch(() => undefined);
    if (executed === undefined) return { status: "failed", reason: "runtime-unavailable" };
    return {
      status: "exited",
      exitCode: executed.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
    };
  }

  async exportGitBundle(input: {
    readonly runtimeId: string;
  }): Promise<ExecutionCapsuleDriverExportResult> {
    const runtime = this.#runtimes.get(input.runtimeId);
    if (runtime?.state !== "ready") return { status: "failed", reason: "export-failed" };

    let artifactPath: string | undefined;
    let capsuleBundleCreated = false;
    let operation = "read-head";
    try {
      const head = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "exec",
        "--workdir",
        "/workspace",
        "--",
        input.runtimeId,
        "git",
        "-C",
        "/workspace",
        "rev-parse",
        "HEAD",
      ]);
      const headRevision = head.stdout.trim();
      if (head.exitCode !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headRevision)) {
        return { status: "failed", reason: "export-failed" };
      }
      capsuleBundleCreated = true;
      operation = "create-bundle";
      const bundled = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "exec",
        "--workdir",
        "/workspace",
        "--",
        input.runtimeId,
        "git",
        "-C",
        "/workspace",
        "bundle",
        "create",
        "/tmp/octant-export.bundle",
        "--all",
      ]);
      if (bundled.exitCode !== 0) return { status: "failed", reason: "export-failed" };
      operation = "verify-producer-bundle";
      const bundleVerified = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "exec",
        "--workdir",
        "/workspace",
        "--",
        input.runtimeId,
        "git",
        "bundle",
        "verify",
        "/tmp/octant-export.bundle",
      ]);
      if (bundleVerified.exitCode !== 0) return { status: "failed", reason: "export-failed" };
      operation = "digest-producer-bundle";
      const digested = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "exec",
        "--workdir",
        "/workspace",
        "--",
        input.runtimeId,
        "sha256sum",
        "/tmp/octant-export.bundle",
      ]);
      const expectedSha256 = readSha256(digested.stdout);
      if (digested.exitCode !== 0 || expectedSha256 === undefined) {
        return { status: "failed", reason: "export-failed" };
      }

      operation = "reserve-host-artifact";
      artifactPath = await this.#bundleStore.reserve(input.runtimeId);
      operation = "copy-host-artifact";
      const copied = await this.#artifactWriter.write({
        command: this.#podmanPath,
        args: [
          ...podmanStoreArgs(runtime.disk),
          "exec",
          "--workdir",
          "/workspace",
          "--",
          input.runtimeId,
          "cat",
          "/tmp/octant-export.bundle",
        ],
        artifactPath,
        maxBytes: 1_024 * 1_024 * 1_024,
      });
      if (copied.exitCode !== 0) throw new Error("Execution capsule bundle copy failed.");
      operation = "verify-host-artifact";
      const verified = await this.#bundleStore.verify({
        artifactPath,
        expectedSha256,
      });
      operation = "verify-outside-producer";
      const verifiedOutsideProducer = await this.#verifyExportOutsideProducer({
        runtimeId: input.runtimeId,
        artifactPath,
        image: runtime.image,
        disk: runtime.disk,
      });
      if (!verifiedOutsideProducer) throw new Error("Execution capsule bundle verifier refused.");
      return {
        status: "exported",
        artifactPath,
        sha256: verified.sha256,
        byteLength: verified.byteLength,
        headRevision,
      };
    } catch (error) {
      try {
        this.#recordDiagnostic?.({
          operation,
          message: error instanceof Error ? error.message : "unknown export failure",
        });
      } catch {
        // Diagnostics never change the user-visible export outcome.
      }
      if (artifactPath !== undefined) {
        await this.#bundleStore.discard?.(artifactPath).catch(() => undefined);
      }
      return { status: "failed", reason: "export-failed" };
    } finally {
      if (capsuleBundleCreated) {
        await this.#runner
          .run(this.#podmanPath, [
            ...podmanStoreArgs(runtime.disk),
            "exec",
            "--workdir",
            "/workspace",
            "--",
            input.runtimeId,
            "rm",
            "-f",
            "/tmp/octant-export.bundle",
          ])
          .catch(() => undefined);
      }
    }
  }

  async stop(input: {
    readonly runtimeId: string;
  }): Promise<
    { readonly status: "stopped" } | { readonly status: "failed"; readonly reason: "stop-failed" }
  > {
    const runtime = this.#runtimes.get(input.runtimeId);
    if (runtime === undefined) return { status: "failed", reason: "stop-failed" };
    if (runtime.state === "stopped") return { status: "stopped" };
    const stopped = await this.#runner
      .run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "stop",
        "--time",
        "10",
        input.runtimeId,
      ])
      .catch(() => undefined);
    if (stopped?.exitCode !== 0) return { status: "failed", reason: "stop-failed" };
    this.#runtimes.set(input.runtimeId, { ...runtime, state: "stopped" });
    return { status: "stopped" };
  }

  async #verifyExportOutsideProducer(input: {
    readonly runtimeId: string;
    readonly artifactPath: string;
    readonly image: string;
    readonly disk: ExecutionCapsuleDiskLocation;
  }): Promise<boolean> {
    const verifierId = `${input.runtimeId}-verify-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    let created = false;
    try {
      const create = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(input.disk),
        ...gvisorRuntimeArgs(this.#runscPath),
        "create",
        "--name",
        verifierId,
        "--log-driver",
        "none",
        "--network",
        "none",
        "--cgroups",
        "no-conmon",
        "--userns",
        "auto",
        "--user",
        "0:0",
        "--cap-drop",
        "all",
        "--security-opt",
        "no-new-privileges",
        "--workdir",
        "/",
        "--entrypoint",
        "/bin/sh",
        input.image,
        "-c",
        "while :; do sleep 3600; done",
      ]);
      if (create.exitCode !== 0) return false;
      created = true;
      if (!(await this.#provisionMappedDirectory(input.disk, verifierId, "/verify"))) {
        return false;
      }
      const copied = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(input.disk),
        "cp",
        input.artifactPath,
        `${verifierId}:/tmp/capsule.bundle`,
      ]);
      if (copied.exitCode !== 0) return false;
      const started = await this.#startInBudgetScope({
        disk: input.disk,
        runtimeId: verifierId,
        cpuMillicores: 100,
        memoryBytes: 256 * 1_024 * 1_024,
        pidLimit: 64,
      });
      if (started.exitCode !== 0) return false;
      const initialized = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(input.disk),
        "exec",
        "--workdir",
        "/",
        "--",
        verifierId,
        "git",
        "init",
        "--bare",
        "/verify",
      ]);
      if (initialized.exitCode !== 0) return false;
      const verified = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(input.disk),
        "exec",
        "--workdir",
        "/verify",
        "--",
        verifierId,
        "git",
        "bundle",
        "verify",
        "/tmp/capsule.bundle",
      ]);
      return verified.exitCode === 0;
    } catch {
      return false;
    } finally {
      if (created) {
        await this.#runner
          .run(this.#podmanPath, [
            ...podmanStoreArgs(input.disk),
            "rm",
            "--force",
            "--time",
            "10",
            verifierId,
          ])
          .catch(() => undefined);
      }
    }
  }

  async verifyRecoveredExport(
    input: Parameters<ExecutionCapsuleDriver["verifyRecoveredExport"]>[0],
  ): Promise<boolean> {
    try {
      const verified = await this.#bundleStore.verify({
        artifactPath: input.artifactPath,
        expectedSha256: input.receipt.sha256,
      });
      return (
        verified.sha256 === input.receipt.sha256 && verified.byteLength === input.receipt.byteLength
      );
    } catch {
      return false;
    }
  }

  async discardCreated(input: {
    readonly capsuleId: ExecutionCapsuleDriverCreateInput["request"]["capsuleId"];
    readonly runtimeId: string;
  }): Promise<void> {
    const runtime = this.#runtimes.get(input.runtimeId);
    if (runtime?.capsuleId !== String(input.capsuleId)) return;
    const removed = await this.#runner
      .run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "rm",
        "--force",
        "--time",
        "10",
        input.runtimeId,
      ])
      .catch(() => undefined);
    if (removed?.exitCode !== 0) return;
    try {
      await this.#diskStore.release(runtime.disk);
      this.#runtimes.delete(input.runtimeId);
    } catch {
      // A failed exact-store cleanup remains owned for an explicit retry.
    }
  }

  async recover(
    input: ExecutionCapsuleDriverCreateInput,
  ): Promise<
    | { readonly status: "stopped"; readonly runtimeId: string }
    | { readonly status: "refused"; readonly reason: "runtime-unavailable" | "source-unavailable" }
  > {
    const probe = await this.probe();
    if (
      !probe.host.rootlessPodman ||
      !probe.host.runsc ||
      !probe.host.systrap ||
      !probe.host.cgroupsV2 ||
      !probe.host.dedicatedIdentity
    ) {
      this.#reportDiagnostic("recover-probe", "protected runtime probe failed");
      return { status: "refused", reason: "runtime-unavailable" };
    }
    try {
      await this.#sourceBundleStore.verify(input.source);
    } catch {
      this.#reportDiagnostic("recover-source", "source bundle verification failed");
      return { status: "refused", reason: "source-unavailable" };
    }
    const runtimeId = capsuleRuntimeId(String(input.request.capsuleId));
    let disk: ExecutionCapsuleDiskLocation;
    try {
      disk = await this.#diskStore.recover({
        runtimeId,
        diskBytes: input.request.budget.diskBytes,
      });
    } catch {
      this.#reportDiagnostic("recover-disk", "capsule disk recovery failed");
      return { status: "refused", reason: "runtime-unavailable" };
    }
    const inspected = await this.#runner
      .run(this.#podmanPath, [...podmanStoreArgs(disk), "inspect", "--format", "json", runtimeId])
      .catch(() => undefined);
    const recovered =
      inspected?.exitCode === 0 ? decodeRecoveredRuntime(inspected.stdout) : undefined;
    const mismatches =
      inspected === undefined
        ? ["inspect-command-unavailable"]
        : inspected.exitCode !== 0
          ? [`inspect-command-exit-${String(inspected.exitCode)}`]
          : recovered === undefined
            ? [describeRecoveredRuntimePayload(inspected.stdout)]
            : [
                ...(recovered.name.replace(/^\//, "") === runtimeId ? [] : ["runtime-name"]),
                ...(recovered.image === String(input.request.recipe.image) ? [] : ["image"]),
                ...(recovered.capsuleId === String(input.request.capsuleId)
                  ? []
                  : ["capsule-label"]),
                ...protectedRuntimeMismatches(recovered, this.#runscPath, disk),
              ];
    if (recovered === undefined || mismatches.length > 0) {
      this.#reportDiagnostic(
        "recover-inspected-runtime",
        `runtime protection mismatch: ${mismatches.join(",")}`,
      );
      await this.#diskStore.close(disk).catch(() => undefined);
      return { status: "refused", reason: "runtime-unavailable" };
    }
    if (recovered.running) {
      const stopped = await this.#runner
        .run(this.#podmanPath, [...podmanStoreArgs(disk), "stop", "--time", "10", runtimeId])
        .catch(() => undefined);
      if (stopped?.exitCode !== 0) {
        this.#reportDiagnostic("recover-stop", "live recovered runtime did not stop");
        await this.#diskStore.close(disk).catch(() => undefined);
        return { status: "refused", reason: "runtime-unavailable" };
      }
    }
    this.#runtimes.set(runtimeId, {
      runtimeId,
      capsuleId: String(input.request.capsuleId),
      image: String(input.request.recipe.image),
      disk,
      state: "stopped",
    });
    return { status: "stopped", runtimeId };
  }

  async release(input: {
    readonly runtimeId: string;
  }): Promise<
    | { readonly status: "released" }
    | { readonly status: "failed"; readonly reason: "release-failed" }
  > {
    const runtime = this.#runtimes.get(input.runtimeId);
    if (runtime === undefined) {
      return { status: "failed", reason: "release-failed" };
    }
    const removed = await this.#runner
      .run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "rm",
        "--force",
        "--time",
        "10",
        input.runtimeId,
      ])
      .catch(() => undefined);
    if (removed?.exitCode !== 0) return { status: "failed", reason: "release-failed" };
    try {
      await this.#diskStore.release(runtime.disk);
    } catch {
      return { status: "failed", reason: "release-failed" };
    }
    this.#runtimes.delete(input.runtimeId);
    return { status: "released" };
  }
}

function unavailableProbe(
  platform: string,
  dedicatedIdentity: boolean,
  available: ExecutionCapsuleAvailableCapacity,
): ExecutionCapsuleDriverProbe {
  return {
    host: {
      platform,
      rootlessPodman: false,
      runsc: false,
      systrap: false,
      cgroupsV2: false,
      dedicatedIdentity,
    },
    available,
  };
}

function capsuleRuntimeId(capsuleId: string): string {
  return `octant-capsule-${capsuleId.replaceAll("-", "")}`;
}

function podmanStoreArgs(disk: ExecutionCapsuleDiskLocation): ReadonlyArray<string> {
  return [
    "--root",
    disk.graphRoot,
    "--runroot",
    disk.runRoot,
    "--storage-driver",
    "vfs",
    "--cgroup-manager",
    "cgroupfs",
  ];
}

function gvisorRuntimeArgs(runscPath: string): ReadonlyArray<string> {
  // Podman owns and proves the outer systemd scope; runsc must not try to
  // create a second privileged cgroup from inside the rootless userns.
  return [
    "--runtime",
    runscPath,
    "--runtime-flag",
    "platform=systrap",
    "--runtime-flag",
    "ignore-cgroups",
    "--runtime-flag",
    "network=none",
    "--runtime-flag",
    "overlay2=none",
    "--runtime-flag",
    "file-access=shared",
  ];
}

function formatCpuQuota(cpuMillicores: number): string {
  return `${String(cpuMillicores / 10)}%`;
}

function createExecutionCapsuleSourceBundleStore(input: {
  readonly expectedUid: number;
}): ExecutionCapsuleSourceBundleStore {
  return {
    verify: async (source) =>
      void (await verifyOwnedFile(source.bundlePath, {
        expectedUid: input.expectedUid,
        expectedSha256: source.sha256,
        expectedByteLength: source.byteLength,
        requirePrivateMode: true,
      })),
  };
}

async function ensurePrivateDirectory(path: string, expectedUid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== expectedUid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Execution capsule state directory is not owner-only.");
  }
}

function createExecutionCapsuleGitBundleStore(input: {
  readonly stateRoot: string;
  readonly expectedUid: number;
}): ExecutionCapsuleGitBundleStore {
  const exportRoot = join(input.stateRoot, "exports");
  return {
    reserve: async (runtimeId) => {
      await ensureProtectedStateDirectory(input.stateRoot, input.expectedUid);
      await ensurePrivateDirectory(exportRoot, input.expectedUid);
      const directory = await mkdtemp(join(exportRoot, `${runtimeId}-`));
      await ensurePrivateDirectory(directory, input.expectedUid);
      const artifactPath = join(directory, "capsule.bundle");
      const artifact = await open(
        artifactPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await artifact.close();
      return artifactPath;
    },
    verify: ({ artifactPath, expectedSha256 }) =>
      verifyOwnedFile(artifactPath, {
        expectedUid: input.expectedUid,
        expectedSha256,
        requirePrivateMode: false,
      }),
    discard: (artifactPath) => rm(dirname(artifactPath), { force: true, recursive: true }),
  };
}

async function ensureProtectedStateDirectory(path: string, expectedUid: number): Promise<void> {
  const metadata = await lstat(path);
  const permissions = metadata.mode & 0o777;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== expectedUid ||
    (permissions !== 0o700 && permissions !== 0o711)
  ) {
    throw new Error("Execution capsule state directory is not protected.");
  }
}

async function verifyOwnedFile(
  path: string,
  input: {
    readonly expectedUid: number;
    readonly expectedSha256: string;
    readonly expectedByteLength?: number;
    readonly requirePrivateMode: boolean;
  },
): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== input.expectedUid ||
      metadata.nlink !== 1 ||
      metadata.size < 1 ||
      metadata.size > 1_024 * 1_024 * 1_024 ||
      (input.expectedByteLength !== undefined && metadata.size !== input.expectedByteLength) ||
      (input.requirePrivateMode && (metadata.mode & 0o077) !== 0)
    ) {
      throw new Error("Execution capsule bundle file is unsafe.");
    }
    if (!input.requirePrivateMode) await handle.chmod(0o600);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const sha256 = hash.digest("hex");
    if (sha256 !== input.expectedSha256) {
      throw new Error("Execution capsule bundle digest does not match.");
    }
    return { sha256, byteLength: metadata.size };
  } finally {
    await handle.close();
  }
}

function readSha256(input: string): string | undefined {
  const match = /^([a-f0-9]{64})(?:\s|$)/.exec(input.trim());
  return match?.[1];
}

function decodeRecoveredRuntime(input: string):
  | {
      readonly name: string;
      readonly image: string;
      readonly capsuleId: string;
      readonly running: boolean;
      readonly ociRuntime: string;
      readonly effectiveCaps: ReadonlyArray<string>;
      readonly mountCount: number;
      readonly user: string;
      readonly createCommand: ReadonlyArray<string>;
      readonly networkMode: string;
      readonly securityOptions: ReadonlyArray<string>;
      readonly privileged: boolean;
      readonly usernsMode: string;
    }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
  const record = parsed[0];
  if (
    typeof record !== "object" ||
    record === null ||
    !("Name" in record) ||
    !("ImageName" in record) ||
    !("State" in record) ||
    !("Config" in record) ||
    !("HostConfig" in record) ||
    !("OCIRuntime" in record) ||
    !("EffectiveCaps" in record) ||
    !("Mounts" in record) ||
    typeof record.Name !== "string" ||
    typeof record.ImageName !== "string" ||
    typeof record.OCIRuntime !== "string" ||
    !isStringArray(record.EffectiveCaps) ||
    !Array.isArray(record.Mounts)
  ) {
    return undefined;
  }
  const state = record.State;
  const config = record.Config;
  const hostConfig = record.HostConfig;
  if (
    typeof state !== "object" ||
    state === null ||
    !("Running" in state) ||
    typeof state.Running !== "boolean" ||
    typeof config !== "object" ||
    config === null ||
    !("Labels" in config) ||
    !("User" in config) ||
    !("CreateCommand" in config) ||
    typeof config.Labels !== "object" ||
    config.Labels === null ||
    typeof config.User !== "string" ||
    !isStringArray(config.CreateCommand) ||
    !("app.octant.capsule" in config.Labels) ||
    typeof config.Labels["app.octant.capsule"] !== "string" ||
    typeof hostConfig !== "object" ||
    hostConfig === null ||
    !("NetworkMode" in hostConfig) ||
    !("SecurityOpt" in hostConfig) ||
    !("Privileged" in hostConfig) ||
    !("UsernsMode" in hostConfig) ||
    typeof hostConfig.NetworkMode !== "string" ||
    !isStringArray(hostConfig.SecurityOpt) ||
    typeof hostConfig.Privileged !== "boolean" ||
    typeof hostConfig.UsernsMode !== "string"
  ) {
    return undefined;
  }
  return {
    name: record.Name,
    image: record.ImageName,
    capsuleId: config.Labels["app.octant.capsule"],
    running: state.Running,
    ociRuntime: record.OCIRuntime,
    effectiveCaps: record.EffectiveCaps,
    mountCount: record.Mounts.length,
    user: config.User,
    createCommand: config.CreateCommand,
    networkMode: hostConfig.NetworkMode,
    securityOptions: hostConfig.SecurityOpt,
    privileged: hostConfig.Privileged,
    usernsMode: hostConfig.UsernsMode,
  };
}

function describeRecoveredRuntimePayload(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return "invalid-inspect-payload:root=invalid-json";
  }
  const record = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  const state = readUnknownField(record, "State");
  const config = readUnknownField(record, "Config");
  const hostConfig = readUnknownField(record, "HostConfig");
  return `invalid-inspect-payload:${[
    `root=${unknownShape(parsed)}`,
    `Name=${unknownFieldShape(record, "Name")}`,
    `ImageName=${unknownFieldShape(record, "ImageName")}`,
    `State=${unknownFieldShape(record, "State")}`,
    `State.Running=${unknownFieldShape(state, "Running")}`,
    `Config=${unknownFieldShape(record, "Config")}`,
    `Config.Labels=${unknownFieldShape(config, "Labels")}`,
    `Config.User=${unknownFieldShape(config, "User")}`,
    `Config.CreateCommand=${unknownFieldShape(config, "CreateCommand")}`,
    `HostConfig=${unknownFieldShape(record, "HostConfig")}`,
    `HostConfig.NetworkMode=${unknownFieldShape(hostConfig, "NetworkMode")}`,
    `HostConfig.SecurityOpt=${unknownFieldShape(hostConfig, "SecurityOpt")}`,
    `HostConfig.Privileged=${unknownFieldShape(hostConfig, "Privileged")}`,
    `HostConfig.UsernsMode=${unknownFieldShape(hostConfig, "UsernsMode")}`,
    `OCIRuntime=${unknownFieldShape(record, "OCIRuntime")}`,
    `EffectiveCaps=${unknownFieldShape(record, "EffectiveCaps")}`,
    `Mounts=${unknownFieldShape(record, "Mounts")}`,
  ].join(",")}`;
}

function readUnknownField(input: unknown, field: string): unknown {
  return typeof input === "object" && input !== null && Reflect.has(input, field)
    ? Reflect.get(input, field)
    : undefined;
}

function unknownFieldShape(input: unknown, field: string): string {
  return typeof input === "object" && input !== null && Reflect.has(input, field)
    ? unknownShape(Reflect.get(input, field))
    : "missing";
}

function unknownShape(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) {
    return input.every((item) => typeof item === "string")
      ? `string-array(${String(input.length)})`
      : `array(${String(input.length)})`;
  }
  return typeof input;
}

function isStringArray(input: unknown): input is ReadonlyArray<string> {
  return Array.isArray(input) && input.every((item) => typeof item === "string");
}

function protectedRuntimeMismatches(
  recovered: NonNullable<ReturnType<typeof decodeRecoveredRuntime>>,
  runscPath: string,
  disk: ExecutionCapsuleDiskLocation,
): ReadonlyArray<string> {
  const mismatches: string[] = [];
  const command = recovered.createCommand;
  // Podman reports an auto-allocated user namespace as effective mode
  // `private`; the preserved create command separately proves `--userns auto`.
  if (basename(recovered.ociRuntime) !== basename(runscPath)) mismatches.push("oci-runtime");
  if (recovered.effectiveCaps.length !== 0) mismatches.push("effective-capabilities");
  if (recovered.mountCount !== 0) mismatches.push("host-mounts");
  if (recovered.user !== "0:0") mismatches.push("container-user");
  if (recovered.networkMode !== "none") mismatches.push("network-mode");
  if (!recovered.securityOptions.some((option) => option.startsWith("no-new-privileges"))) {
    mismatches.push("no-new-privileges");
  }
  if (recovered.privileged) mismatches.push("privileged");
  if (recovered.usernsMode !== "private") mismatches.push("private-userns");
  if (!hasFlagValue(command, "--root", disk.graphRoot)) mismatches.push("graph-root");
  if (!hasFlagValue(command, "--runroot", disk.runRoot)) mismatches.push("run-root");
  if (!hasFlagValue(command, "--storage-driver", "vfs")) mismatches.push("storage-driver");
  if (!hasFlagValue(command, "--cgroup-manager", "cgroupfs")) mismatches.push("cgroup-manager");
  if (!hasFlagValue(command, "--runtime", runscPath)) mismatches.push("runtime-command");
  if (!hasFlagValue(command, "--runtime-flag", "platform=systrap")) mismatches.push("systrap");
  if (!hasFlagValue(command, "--runtime-flag", "ignore-cgroups")) {
    mismatches.push("runsc-cgroups");
  }
  if (!hasFlagValue(command, "--runtime-flag", "network=none")) {
    mismatches.push("runsc-network");
  }
  if (!hasFlagValue(command, "--runtime-flag", "overlay2=none")) {
    mismatches.push("runsc-overlay");
  }
  if (!hasFlagValue(command, "--runtime-flag", "file-access=shared")) {
    mismatches.push("runsc-file-access");
  }
  if (!hasFlagValue(command, "--log-driver", "none")) mismatches.push("log-driver");
  if (!hasFlagValue(command, "--network", "none")) mismatches.push("network-command");
  if (!hasFlagValue(command, "--cgroups", "no-conmon")) mismatches.push("podman-cgroups");
  if (!hasFlagValue(command, "--userns", "auto")) mismatches.push("auto-userns");
  if (!hasFlagValue(command, "--cap-drop", "all")) mismatches.push("cap-drop");
  if (!hasFlagValue(command, "--security-opt", "no-new-privileges")) {
    mismatches.push("security-command");
  }
  return mismatches;
}

function hasFlagValue(
  command: ReadonlyArray<string>,
  flag: string,
  expectedValue: string,
): boolean {
  return command.some(
    (argument, index) => argument === flag && command[index + 1] === expectedValue,
  );
}

function decodePodmanInfo(
  input: string,
): { readonly rootless: boolean; readonly cgroupVersion: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("host" in parsed)) return undefined;
  const host = parsed.host;
  if (typeof host !== "object" || host === null) return undefined;
  if (!("security" in host) || !("cgroupVersion" in host)) return undefined;
  const security = host.security;
  const cgroupVersion = host.cgroupVersion;
  if (
    typeof security !== "object" ||
    security === null ||
    !("rootless" in security) ||
    typeof security.rootless !== "boolean" ||
    typeof cgroupVersion !== "string"
  ) {
    return undefined;
  }
  return { rootless: security.rootless, cgroupVersion };
}

function createStationIdentityProbe(input: {
  readonly runner: ExecutionCapsuleCommandRunner;
}): ExecutionCapsuleStationIdentityProbe {
  return {
    probe: async () => {
      const sudo = await input.runner.run("/usr/bin/sudo", ["-n", "-l"]).catch(() => undefined);
      const dockerSocketAccessible = await canAccessAny([
        "/var/run/docker.sock",
        "/run/docker.sock",
      ]);
      return {
        passwordlessSudo: sudo?.exitCode === 0,
        dockerSocketAccessible,
      };
    },
  };
}

async function canAccessAny(paths: ReadonlyArray<string>): Promise<boolean> {
  for (const path of paths) {
    try {
      await access(path, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      // An absent or inaccessible host socket contributes no authority.
    }
  }
  return false;
}

function createNodeCommandRunner(
  runtimeEnvironment: ExecutionCapsuleRuntimeEnvironment,
): ExecutionCapsuleCommandRunner {
  return {
    run: async (command, args) => {
      const longRunning =
        (command.endsWith("/podman") &&
          args.some(
            (argument) => argument === "create" || argument === "cp" || argument === "bundle",
          )) ||
        command.endsWith("/mkfs.ext4") ||
        command.endsWith("/fuse2fs");
      try {
        const result = await execFileAsync(command, [...args], {
          shell: false,
          timeout: longRunning ? 5 * 60_000 : 30_000,
          maxBuffer: 4 * 1_024 * 1_024,
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin",
            LC_ALL: "C",
            ...(runtimeEnvironment.homeDirectory === undefined
              ? {}
              : { HOME: runtimeEnvironment.homeDirectory }),
            ...(runtimeEnvironment.runtimeDirectory === undefined
              ? {}
              : { XDG_RUNTIME_DIR: runtimeEnvironment.runtimeDirectory }),
            ...(runtimeEnvironment.sessionBusAddress === undefined
              ? {}
              : { DBUS_SESSION_BUS_ADDRESS: runtimeEnvironment.sessionBusAddress }),
          },
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return {
          exitCode: commandExitCode(error),
          stdout: commandOutput(error, "stdout"),
          stderr: commandOutput(error, "stderr"),
        };
      }
    },
  };
}

function createNodeArtifactWriter(
  runtimeEnvironment: ExecutionCapsuleRuntimeEnvironment,
): ExecutionCapsuleArtifactWriter {
  return {
    write: async (input) => {
      const artifact = await open(
        input.artifactPath,
        constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      );
      const child = spawn(input.command, [...input.args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          ...(runtimeEnvironment.homeDirectory === undefined
            ? {}
            : { HOME: runtimeEnvironment.homeDirectory }),
          ...(runtimeEnvironment.runtimeDirectory === undefined
            ? {}
            : { XDG_RUNTIME_DIR: runtimeEnvironment.runtimeDirectory }),
          ...(runtimeEnvironment.sessionBusAddress === undefined
            ? {}
            : { DBUS_SESSION_BUS_ADDRESS: runtimeEnvironment.sessionBusAddress }),
        },
      });
      let byteLength = 0;
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 65_536) stderr += chunk.slice(0, 65_536 - stderr.length);
      });
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          byteLength += chunk.byteLength;
          if (byteLength > input.maxBytes) {
            callback(new Error("Execution capsule artifact exceeds its byte limit."));
            return;
          }
          callback(null, chunk);
        },
      });
      const exited = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      const piped = pipeline(
        child.stdout,
        limiter,
        artifact.createWriteStream({ autoClose: true }),
      ).catch((error: unknown) => {
        child.kill("SIGKILL");
        throw error;
      });
      try {
        const [pipeResult, exitResult] = await Promise.allSettled([piped, exited]);
        if (pipeResult.status === "rejected") {
          return { exitCode: 1, stderr: errorMessage(pipeResult.reason) };
        }
        if (exitResult.status === "rejected") {
          return { exitCode: 1, stderr: errorMessage(exitResult.reason) };
        }
        return { exitCode: exitResult.value, stderr };
      } finally {
        await artifact.close().catch(() => undefined);
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown command failure";
}

function defaultRuntimeEnvironment(): ExecutionCapsuleRuntimeEnvironment {
  const homeDirectory = process.env.HOME;
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const sessionBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
  return {
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
    ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
    ...(sessionBusAddress === undefined ? {} : { sessionBusAddress }),
  };
}

function commandExitCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "number" && Number.isInteger(code)) return code;
  }
  return 1;
}

function commandOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null) return "";
  if (key === "stdout" && "stdout" in error && typeof error.stdout === "string") {
    return error.stdout;
  }
  if (key === "stderr" && "stderr" in error && typeof error.stderr === "string") {
    return error.stderr;
  }
  return "";
}
