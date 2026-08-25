import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
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
  readonly #runner: ExecutionCapsuleCommandRunner;
  readonly #sourceBundleStore: ExecutionCapsuleSourceBundleStore;
  readonly #bundleStore: ExecutionCapsuleGitBundleStore;
  readonly #identityProbe: ExecutionCapsuleStationIdentityProbe;
  readonly #diskStore: ExecutionCapsuleDiskStore;
  readonly #runtimes = new Map<string, GvisorPodmanRuntime>();

  constructor(options: GvisorPodmanExecutionCapsuleDriverOptions) {
    const currentUser = userInfo();
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
    this.#runner =
      options.runner ??
      createNodeCommandRunner(options.runtimeEnvironment ?? defaultRuntimeEnvironment());
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
        expectedUid: this.#uid,
        expectedGid: this.#gid,
        runner: this.#runner,
      });
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
        "--runtime",
        this.#runscPath,
        "--runtime-flag",
        "platform=systrap",
        "--runtime-flag",
        "systemd-cgroup",
        "--runtime-flag",
        "network=none",
        "create",
        "--name",
        runtimeId,
        "--log-driver",
        "none",
        "--network",
        "none",
        "--userns",
        "auto",
        "--user",
        "0:0",
        "--cap-drop",
        "all",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        formatCpus(input.request.budget.cpuMillicores),
        "--memory",
        String(input.request.budget.memoryBytes),
        "--pids-limit",
        String(input.request.budget.pidLimit),
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

      const copied = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(disk),
        "cp",
        input.source.bundlePath,
        `${runtimeId}:/tmp/octant-source.bundle`,
      ]);
      if (copied.exitCode !== 0) return { status: "refused", reason: "creation-failed" };
      const started = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(disk),
        "start",
        runtimeId,
      ]);
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

      artifactPath = await this.#bundleStore.reserve(input.runtimeId);
      const copied = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(runtime.disk),
        "cp",
        `${input.runtimeId}:/tmp/octant-export.bundle`,
        artifactPath,
      ]);
      if (copied.exitCode !== 0) throw new Error("Execution capsule bundle copy failed.");
      const verified = await this.#bundleStore.verify({
        artifactPath,
        expectedSha256,
      });
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
    } catch {
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
        "--runtime",
        this.#runscPath,
        "--runtime-flag",
        "platform=systrap",
        "--runtime-flag",
        "systemd-cgroup",
        "--runtime-flag",
        "network=none",
        "create",
        "--name",
        verifierId,
        "--log-driver",
        "none",
        "--network",
        "none",
        "--userns",
        "auto",
        "--user",
        "0:0",
        "--cap-drop",
        "all",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        "0.1",
        "--memory",
        String(256 * 1_024 * 1_024),
        "--pids-limit",
        "64",
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
      const started = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(input.disk),
        "start",
        verifierId,
      ]);
      if (started.exitCode !== 0) return false;
      const copied = await this.#runner.run(this.#podmanPath, [
        ...podmanStoreArgs(input.disk),
        "cp",
        input.artifactPath,
        `${verifierId}:/tmp/capsule.bundle`,
      ]);
      if (copied.exitCode !== 0) return false;
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
      return { status: "refused", reason: "runtime-unavailable" };
    }
    try {
      await this.#sourceBundleStore.verify(input.source);
    } catch {
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
      return { status: "refused", reason: "runtime-unavailable" };
    }
    const inspected = await this.#runner
      .run(this.#podmanPath, [...podmanStoreArgs(disk), "inspect", "--format", "json", runtimeId])
      .catch(() => undefined);
    const recovered =
      inspected?.exitCode === 0 ? decodeRecoveredRuntime(inspected.stdout) : undefined;
    if (
      recovered === undefined ||
      recovered.name.replace(/^\//, "") !== runtimeId ||
      recovered.image !== String(input.request.recipe.image) ||
      recovered.capsuleId !== String(input.request.capsuleId) ||
      !matchesProtectedRuntime(recovered, input, this.#runscPath, disk)
    ) {
      await this.#diskStore.close(disk).catch(() => undefined);
      return { status: "refused", reason: "runtime-unavailable" };
    }
    if (recovered.running) {
      const stopped = await this.#runner
        .run(this.#podmanPath, [...podmanStoreArgs(disk), "stop", "--time", "10", runtimeId])
        .catch(() => undefined);
      if (stopped?.exitCode !== 0) {
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
  return ["--root", disk.graphRoot, "--runroot", disk.runRoot, "--storage-driver", "vfs"];
}

function formatCpus(cpuMillicores: number): string {
  return String(cpuMillicores / 1_000);
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
      await ensurePrivateDirectory(input.stateRoot, input.expectedUid);
      await ensurePrivateDirectory(exportRoot, input.expectedUid);
      const directory = await mkdtemp(join(exportRoot, `${runtimeId}-`));
      await ensurePrivateDirectory(directory, input.expectedUid);
      return join(directory, "capsule.bundle");
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
      readonly memoryBytes: number;
      readonly nanoCpus: number;
      readonly pidLimit: number;
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
    !("Memory" in hostConfig) ||
    !("NanoCpus" in hostConfig) ||
    !("PidsLimit" in hostConfig) ||
    typeof hostConfig.NetworkMode !== "string" ||
    !isStringArray(hostConfig.SecurityOpt) ||
    typeof hostConfig.Privileged !== "boolean" ||
    typeof hostConfig.UsernsMode !== "string" ||
    typeof hostConfig.Memory !== "number" ||
    typeof hostConfig.NanoCpus !== "number" ||
    typeof hostConfig.PidsLimit !== "number"
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
    memoryBytes: hostConfig.Memory,
    nanoCpus: hostConfig.NanoCpus,
    pidLimit: hostConfig.PidsLimit,
  };
}

function isStringArray(input: unknown): input is ReadonlyArray<string> {
  return Array.isArray(input) && input.every((item) => typeof item === "string");
}

function matchesProtectedRuntime(
  recovered: NonNullable<ReturnType<typeof decodeRecoveredRuntime>>,
  input: ExecutionCapsuleDriverCreateInput,
  runscPath: string,
  disk: ExecutionCapsuleDiskLocation,
): boolean {
  const command = recovered.createCommand;
  return (
    basename(recovered.ociRuntime) === basename(runscPath) &&
    recovered.effectiveCaps.length === 0 &&
    recovered.mountCount === 0 &&
    recovered.user === "0:0" &&
    recovered.networkMode === "none" &&
    recovered.securityOptions.some((option) => option.startsWith("no-new-privileges")) &&
    !recovered.privileged &&
    recovered.usernsMode.startsWith("auto") &&
    recovered.memoryBytes === input.request.budget.memoryBytes &&
    recovered.nanoCpus === input.request.budget.cpuMillicores * 1_000_000 &&
    recovered.pidLimit === input.request.budget.pidLimit &&
    hasFlagValue(command, "--root", disk.graphRoot) &&
    hasFlagValue(command, "--runroot", disk.runRoot) &&
    hasFlagValue(command, "--storage-driver", "vfs") &&
    hasFlagValue(command, "--runtime", runscPath) &&
    hasFlagValue(command, "--runtime-flag", "platform=systrap") &&
    hasFlagValue(command, "--runtime-flag", "systemd-cgroup") &&
    hasFlagValue(command, "--runtime-flag", "network=none") &&
    hasFlagValue(command, "--log-driver", "none") &&
    hasFlagValue(command, "--network", "none") &&
    hasFlagValue(command, "--userns", "auto") &&
    hasFlagValue(command, "--cap-drop", "all") &&
    hasFlagValue(command, "--security-opt", "no-new-privileges")
  );
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
