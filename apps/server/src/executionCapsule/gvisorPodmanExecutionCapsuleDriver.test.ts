import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeExecutionCapsuleAcquireRequest } from "@octant/contracts/execution-capsule";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionCapsuleDiskLocation,
  ExecutionCapsuleDiskStore,
} from "./fuseExecutionCapsuleDiskStore";
import {
  GvisorPodmanExecutionCapsuleDriver,
  type ExecutionCapsuleCommandRunner,
  type ExecutionCapsuleGitBundleStore,
  type ExecutionCapsuleSourceBundleStore,
} from "./gvisorPodmanExecutionCapsuleDriver";

const capacity = {
  cpuMillicores: 4_000,
  memoryBytes: 8 * 1_024 * 1_024 * 1_024,
  diskBytes: 40 * 1_024 * 1_024 * 1_024,
  pidLimit: 2_048,
};

const fixtureRuntimeId = "octant-capsule-11111111111141118111111111111111";

function fixturePodmanArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return [
    "--root",
    `/var/lib/octant/capsules/stores/${fixtureRuntimeId}/mount/graph`,
    "--runroot",
    `/var/lib/octant/capsules/stores/${fixtureRuntimeId}/mount/run`,
    "--storage-driver",
    "vfs",
    "--cgroup-manager",
    "cgroupfs",
    ...args,
  ];
}

function diskLocation(runtimeId: string, diskBytes: number): ExecutionCapsuleDiskLocation {
  const directory = `/var/lib/octant/capsules/stores/${runtimeId}`;
  const mountPath = `${directory}/mount`;
  return {
    directory,
    imagePath: `${directory}/capsule.ext4`,
    mountPath,
    graphRoot: `${mountPath}/graph`,
    runRoot: `${mountPath}/run`,
    diskBytes,
  };
}

const diskStore: ExecutionCapsuleDiskStore = {
  create: async ({ runtimeId, diskBytes }) => diskLocation(runtimeId, diskBytes),
  recover: async ({ runtimeId, diskBytes }) => diskLocation(runtimeId, diskBytes),
  close: async () => undefined,
  release: async () => undefined,
};

const stationIdentity = {
  homeDirectory: "/var/lib/octant",
  expectedHomeDirectory: "/var/lib/octant",
  gid: 1001,
  supplementaryGroups: [1001],
  identityProbe: {
    probe: async () => ({ passwordlessSudo: false, dockerSocketAccessible: false }),
  },
  diskStore,
} as const;

const capsuleRequest = decodeExecutionCapsuleAcquireRequest({
  capsuleId: "11111111-1111-4111-8111-111111111111",
  owner: {
    kind: "code-thread",
    threadId: "22222222-2222-4222-8222-222222222222",
  },
  projectId: "33333333-3333-4333-8333-333333333333",
  recipe: {
    recipeId: "44444444-4444-4444-8444-444444444444",
    revision: 1,
    image: `ghcr.io/ogard-labs/octant-capsule@sha256:${"a".repeat(64)}`,
    setup: [],
  },
  budget: {
    cpuMillicores: 1_000,
    memoryBytes: 2 * 1_024 * 1_024 * 1_024,
    diskBytes: 10 * 1_024 * 1_024 * 1_024,
    pidLimit: 512,
  },
});

const source = {
  bundlePath: "/source/octant.bundle",
  sha256: "d".repeat(64),
  byteLength: 4_096,
  revision: "b".repeat(40),
};
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("GvisorPodmanExecutionCapsuleDriver", () => {
  it("reports a protected backend only after rootless Podman and systrap execute", async () => {
    const run = vi.fn<ExecutionCapsuleCommandRunner["run"]>(async (command) => {
      if (command === "/usr/bin/podman") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const driver = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
    });

    await expect(driver.probe()).resolves.toEqual({
      host: {
        platform: "linux",
        rootlessPodman: true,
        runsc: true,
        systrap: true,
        cgroupsV2: true,
        dedicatedIdentity: true,
      },
      available: capacity,
    });
    expect(run).toHaveBeenNthCalledWith(1, "/usr/bin/podman", ["info", "--format", "json"]);
    expect(run).toHaveBeenNthCalledWith(2, "/usr/bin/podman", [
      "unshare",
      "/usr/bin/runsc",
      "--ignore-cgroups",
      "--platform=systrap",
      "--network=none",
      "do",
      "true",
    ]);
  });

  it("refuses to call a grouped or sudo-capable octant account a dedicated Station identity", async () => {
    const run = vi.fn<ExecutionCapsuleCommandRunner["run"]>(async (command) => {
      if (command === "/usr/bin/podman") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const driver = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      supplementaryGroups: [1001, 999],
      identityProbe: {
        probe: async () => ({ passwordlessSudo: true, dockerSocketAccessible: false }),
      },
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
    });

    await expect(driver.probe()).resolves.toMatchObject({
      host: { dedicatedIdentity: false },
    });
  });

  it("refuses a hardlinked or digest-mismatched source bundle before container creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-capsule-source-test-"));
    roots.push(root);
    const bundlePath = join(root, "source.bundle");
    const linkedPath = join(root, "source-hardlink.bundle");
    const bytes = Buffer.from("bundle-fixture");
    await writeFile(bundlePath, bytes);
    await chmod(bundlePath, 0o600);
    await link(bundlePath, linkedPath);
    const run = vi.fn<ExecutionCapsuleCommandRunner["run"]>(async (command, args) => {
      if (command === "/usr/bin/podman" && args[0] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const driver = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: process.getuid?.() ?? 0,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: join(root, "state"),
      capacity,
      runner: { run },
    });
    const verifiedSource = {
      bundlePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      revision: "b".repeat(40),
    };

    await expect(
      driver.create({ request: capsuleRequest, source: verifiedSource }),
    ).resolves.toEqual({ status: "refused", reason: "source-unavailable" });
    await unlink(linkedPath);
    await expect(
      driver.create({
        request: capsuleRequest,
        source: { ...verifiedSource, sha256: "e".repeat(64) },
      }),
    ).resolves.toEqual({ status: "refused", reason: "source-unavailable" });
    expect(run.mock.calls.some(([, args]) => args.includes("create"))).toBe(false);
  });

  it("creates a resource-bounded runsc capsule from a verified source bundle", async () => {
    const run = vi.fn<ExecutionCapsuleCommandRunner["run"]>(async (command, args) => {
      if (command === "/usr/bin/podman" && args[0] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const verifySource = vi.fn<ExecutionCapsuleSourceBundleStore["verify"]>(async () => undefined);
    const driver = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
      sourceBundleStore: { verify: verifySource },
    });

    await expect(
      driver.create({
        request: capsuleRequest,
        source,
      }),
    ).resolves.toEqual({
      status: "ready",
      runtimeId: "octant-capsule-11111111111141118111111111111111",
    });

    expect(verifySource).toHaveBeenCalledWith(source);
    const createCall = run.mock.calls.find(
      ([command, args]) => command === "/usr/bin/podman" && args.includes("create"),
    );
    expect(createCall?.[1]).toEqual([
      "--root",
      "/var/lib/octant/capsules/stores/octant-capsule-11111111111141118111111111111111/mount/graph",
      "--runroot",
      "/var/lib/octant/capsules/stores/octant-capsule-11111111111141118111111111111111/mount/run",
      "--storage-driver",
      "vfs",
      "--cgroup-manager",
      "cgroupfs",
      "--runtime",
      "/usr/bin/runsc",
      "--runtime-flag",
      "platform=systrap",
      "--runtime-flag",
      "ignore-cgroups",
      "--runtime-flag",
      "network=none",
      "create",
      "--name",
      "octant-capsule-11111111111141118111111111111111",
      "--log-driver",
      "none",
      "--network",
      "none",
      "--cgroups",
      "disabled",
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
      `app.octant.capsule=${String(capsuleRequest.capsuleId)}`,
      "--entrypoint",
      "/bin/sh",
      String(capsuleRequest.recipe.image),
      "-c",
      "while :; do sleep 3600; done",
    ]);
    expect(createCall?.[1].join(" ")).not.toContain(source.bundlePath);
    expect(
      run.mock.calls.some(
        ([command, args]) =>
          command === "/usr/bin/podman" &&
          args.includes("cp") &&
          args.includes("--archive=true") &&
          args.includes("octant-capsule-11111111111141118111111111111111:/workspace"),
      ),
    ).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/podman",
      fixturePodmanArgs([
        "cp",
        source.bundlePath,
        "octant-capsule-11111111111141118111111111111111:/tmp/octant-source.bundle",
      ]),
    );
    expect(run).toHaveBeenCalledWith("/usr/bin/systemd-run", [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--unit",
      "octant-capsule-11111111111141118111111111111111.scope",
      "--property",
      "CPUQuota=100%",
      "--property",
      `MemoryMax=${String(capsuleRequest.budget.memoryBytes)}`,
      "--property",
      `TasksMax=${String(capsuleRequest.budget.pidLimit)}`,
      "/usr/bin/podman",
      ...fixturePodmanArgs([
        "--runtime",
        "/usr/bin/runsc",
        "--runtime-flag",
        "platform=systrap",
        "--runtime-flag",
        "ignore-cgroups",
        "--runtime-flag",
        "network=none",
        "start",
        "octant-capsule-11111111111141118111111111111111",
      ]),
    ]);
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/podman",
      fixturePodmanArgs([
        "exec",
        "--workdir",
        "/",
        "--",
        "octant-capsule-11111111111141118111111111111111",
        "git",
        "clone",
        "/tmp/octant-source.bundle",
        "/workspace",
      ]),
    );
  });

  it("executes argv only inside a runtime the driver created", async () => {
    const run = vi.fn<ExecutionCapsuleCommandRunner["run"]>(async (command, args) => {
      if (command === "/usr/bin/podman" && args[0] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
          stderr: "",
        };
      }
      if (command === "/usr/bin/podman" && args.at(-1) === "--short") {
        return { exitCode: 0, stdout: "M src/index.ts\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const driver = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
      sourceBundleStore: { verify: async () => undefined },
    });
    const created = await driver.create({
      request: capsuleRequest,
      source,
    });
    if (created.status !== "ready") throw new Error("Expected the fixture capsule to start.");

    await expect(
      driver.execute({ runtimeId: created.runtimeId, argv: ["git", "status", "--short"] }),
    ).resolves.toEqual({
      status: "exited",
      exitCode: 0,
      stdout: "M src/index.ts\n",
      stderr: "",
    });
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/podman",
      fixturePodmanArgs([
        "exec",
        "--workdir",
        "/workspace",
        "--",
        created.runtimeId,
        "git",
        "status",
        "--short",
      ]),
    );

    await expect(
      driver.execute({ runtimeId: "octant-capsule-unknown", argv: ["git", "status"] }),
    ).resolves.toEqual({ status: "failed", reason: "runtime-unavailable" });
  });

  it("copies and verifies a Git bundle before reporting an export", async () => {
    const run = vi.fn<ExecutionCapsuleCommandRunner["run"]>(async (command, args) => {
      if (command === "/usr/bin/podman" && args[0] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
          stderr: "",
        };
      }
      if (command === "/usr/bin/podman" && args.includes("rev-parse")) {
        return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
      }
      if (command === "/usr/bin/podman" && args.includes("sha256sum")) {
        return {
          exitCode: 0,
          stdout: `${"b".repeat(64)}  /tmp/octant-export.bundle\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const reserve = vi.fn<ExecutionCapsuleGitBundleStore["reserve"]>(
      async () => "/var/lib/octant/capsules/exports/capsule.bundle",
    );
    const verify = vi.fn<ExecutionCapsuleGitBundleStore["verify"]>(async () => ({
      sha256: "b".repeat(64),
      byteLength: 4_096,
    }));
    const driver = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
      sourceBundleStore: { verify: async () => undefined },
      bundleStore: { reserve, verify },
    });
    const created = await driver.create({
      request: capsuleRequest,
      source,
    });
    if (created.status !== "ready") throw new Error("Expected the fixture capsule to start.");

    await expect(driver.exportGitBundle({ runtimeId: created.runtimeId })).resolves.toEqual({
      status: "exported",
      artifactPath: "/var/lib/octant/capsules/exports/capsule.bundle",
      sha256: "b".repeat(64),
      byteLength: 4_096,
      headRevision: "c".repeat(40),
    });
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/podman",
      fixturePodmanArgs([
        "exec",
        "--workdir",
        "/workspace",
        "--",
        created.runtimeId,
        "git",
        "-C",
        "/workspace",
        "bundle",
        "create",
        "/tmp/octant-export.bundle",
        "--all",
      ]),
    );
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/podman",
      fixturePodmanArgs([
        "cp",
        `${created.runtimeId}:/tmp/octant-export.bundle`,
        "/var/lib/octant/capsules/exports/capsule.bundle",
      ]),
    );
    expect(verify).toHaveBeenCalledWith({
      artifactPath: "/var/lib/octant/capsules/exports/capsule.bundle",
      expectedSha256: "b".repeat(64),
    });
    expect(
      run.mock.calls.some(
        ([command, args]) =>
          command === "/usr/bin/podman" &&
          args.includes("/verify") &&
          args.includes("/tmp/capsule.bundle") &&
          args.includes("verify"),
      ),
    ).toBe(true);
  });

  it("releases only a runtime it owns and forgets it after confirmed removal", async () => {
    const run = vi.fn<ExecutionCapsuleCommandRunner["run"]>(async (command, args) => {
      if (command === "/usr/bin/podman" && args[0] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const driver = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
      sourceBundleStore: { verify: async () => undefined },
    });
    const created = await driver.create({
      request: capsuleRequest,
      source,
    });
    if (created.status !== "ready") throw new Error("Expected the fixture capsule to start.");

    await expect(driver.release({ runtimeId: created.runtimeId })).resolves.toEqual({
      status: "released",
    });
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/podman",
      fixturePodmanArgs(["rm", "--force", "--time", "10", created.runtimeId]),
    );
    await expect(
      driver.execute({ runtimeId: created.runtimeId, argv: ["git", "status"] }),
    ).resolves.toEqual({ status: "failed", reason: "runtime-unavailable" });
    await expect(driver.release({ runtimeId: "octant-capsule-unknown" })).resolves.toEqual({
      status: "failed",
      reason: "release-failed",
    });
  });

  it("stops a capsule without removing it and recovers the exact stopped identity", async () => {
    const runtimeId = "octant-capsule-11111111111141118111111111111111";
    let recoveredOciRuntime = "/usr/bin/runsc";
    const run = vi.fn<ExecutionCapsuleCommandRunner["run"]>(async (command, args) => {
      if (command === "/usr/bin/podman" && args[0] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
          stderr: "",
        };
      }
      if (command === "/usr/bin/podman" && args.includes("inspect")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Name: runtimeId,
              ImageName: String(capsuleRequest.recipe.image),
              OCIRuntime: recoveredOciRuntime,
              EffectiveCaps: [],
              Mounts: [],
              State: { Running: false },
              Config: {
                User: "0:0",
                CreateCommand: [
                  "podman",
                  "--root",
                  "/var/lib/octant/capsules/stores/octant-capsule-11111111111141118111111111111111/mount/graph",
                  "--runroot",
                  "/var/lib/octant/capsules/stores/octant-capsule-11111111111141118111111111111111/mount/run",
                  "--storage-driver",
                  "vfs",
                  "--cgroup-manager",
                  "cgroupfs",
                  "--runtime",
                  "/usr/bin/runsc",
                  "--runtime-flag",
                  "platform=systrap",
                  "--runtime-flag",
                  "ignore-cgroups",
                  "--runtime-flag",
                  "network=none",
                  "create",
                  "--log-driver",
                  "none",
                  "--network",
                  "none",
                  "--cgroups",
                  "disabled",
                  "--userns",
                  "auto",
                  "--cap-drop",
                  "all",
                  "--security-opt",
                  "no-new-privileges",
                ],
                Labels: { "app.octant.capsule": String(capsuleRequest.capsuleId) },
              },
              HostConfig: {
                NetworkMode: "none",
                SecurityOpt: ["no-new-privileges"],
                Privileged: false,
                UsernsMode: "auto",
                Memory: capsuleRequest.budget.memoryBytes,
                NanoCpus: capsuleRequest.budget.cpuMillicores * 1_000_000,
                PidsLimit: capsuleRequest.budget.pidLimit,
              },
            },
          ]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const driver = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
      sourceBundleStore: { verify: async () => undefined },
    });
    const created = await driver.create({ request: capsuleRequest, source });
    if (created.status !== "ready") throw new Error("Expected the fixture capsule to start.");

    await expect(driver.stop({ runtimeId: created.runtimeId })).resolves.toEqual({
      status: "stopped",
    });
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/podman",
      fixturePodmanArgs(["stop", "--time", "10", runtimeId]),
    );

    const afterRestart = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
      sourceBundleStore: { verify: async () => undefined },
    });
    await expect(afterRestart.recover({ request: capsuleRequest, source })).resolves.toEqual({
      status: "stopped",
      runtimeId,
    });
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/podman",
      fixturePodmanArgs(["inspect", "--format", "json", runtimeId]),
    );
    await expect(afterRestart.execute({ runtimeId, argv: ["git", "status"] })).resolves.toEqual({
      status: "failed",
      reason: "runtime-unavailable",
    });

    recoveredOciRuntime = "/usr/bin/runc";
    const forgedRuntime = new GvisorPodmanExecutionCapsuleDriver({
      platform: "linux",
      username: "octant",
      uid: 1001,
      ...stationIdentity,
      podmanPath: "/usr/bin/podman",
      runscPath: "/usr/bin/runsc",
      stateRoot: "/var/lib/octant/capsules",
      capacity,
      runner: { run },
      sourceBundleStore: { verify: async () => undefined },
    });
    await expect(forgedRuntime.recover({ request: capsuleRequest, source })).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });
  });
});
