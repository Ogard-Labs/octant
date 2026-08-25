import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  decodeExecutionCapsuleAcquireRequest,
  type ExecutionCapsuleAcquireRequest,
} from "@octant/contracts/execution-capsule";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionCapsuleService } from "./executionCapsuleService";
import { GvisorPodmanExecutionCapsuleDriver } from "./gvisorPodmanExecutionCapsuleDriver";

const execFileAsync = promisify(execFile);
const runEvidence = process.env.OCTANT_RUN_GVISOR_CAPSULE_EVIDENCE === "1";
const evidence = runEvidence ? describe : describe.skip;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

function capsuleRequest(input: {
  readonly capsuleId: string;
  readonly threadId: string;
  readonly image: string;
}): ExecutionCapsuleAcquireRequest {
  return decodeExecutionCapsuleAcquireRequest({
    capsuleId: input.capsuleId,
    owner: { kind: "code-thread", threadId: input.threadId },
    projectId: "33333333-3333-4333-8333-333333333333",
    recipe: {
      recipeId: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      image: input.image,
      setup: [],
    },
    budget: {
      cpuMillicores: 500,
      memoryBytes: 512 * 1_024 * 1_024,
      diskBytes: 2 * 1_024 * 1_024 * 1_024,
      pidLimit: 128,
    },
  });
}

evidence("gVisor execution capsule evidence", () => {
  it("isolates two Code-thread clones and exports a verified bundle", async () => {
    expect(process.platform).toBe("linux");
    expect(userInfo().username).toBe("octant");
    const image = process.env.OCTANT_GVISOR_CAPSULE_IMAGE;
    if (image === undefined) throw new Error("OCTANT_GVISOR_CAPSULE_IMAGE is required.");

    const root = await mkdtemp(join(tmpdir(), "octant-gvisor-evidence-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const stateRoot = join(root, "state");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), "# capsule evidence\n");
    await git(sourceRoot, ["init", "--initial-branch=main"]);
    await git(sourceRoot, ["config", "user.name", "Octant Evidence"]);
    await git(sourceRoot, ["config", "user.email", "evidence@octant.invalid"]);
    await git(sourceRoot, ["add", "README.md"]);
    await git(sourceRoot, ["commit", "-m", "Initial evidence fixture"]);
    const revision = (await git(sourceRoot, ["rev-parse", "HEAD"])).trim();
    const sourceBundle = join(root, "source.bundle");
    await git(sourceRoot, ["bundle", "create", sourceBundle, "--all"]);
    await chmod(sourceBundle, 0o600);
    const sourceBytes = await readFile(sourceBundle);
    const sourceMetadata = await stat(sourceBundle);
    const source = {
      bundlePath: sourceBundle,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      byteLength: sourceMetadata.size,
      revision,
    };
    const sourceBranchBefore = (await git(sourceRoot, ["branch", "--show-current"])).trim();
    const sourceStatusBefore = await git(sourceRoot, ["status", "--short"]);

    const driver = new GvisorPodmanExecutionCapsuleDriver({
      stateRoot,
      capacity: {
        cpuMillicores: 2_000,
        memoryBytes: 2 * 1_024 * 1_024 * 1_024,
        diskBytes: 8 * 1_024 * 1_024 * 1_024,
        pidLimit: 512,
      },
      podmanPath: process.env.OCTANT_PODMAN_PATH ?? "/usr/bin/podman",
      runscPath: process.env.OCTANT_RUNSC_PATH ?? "/usr/bin/runsc",
    });
    const exportIds = [
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
    ];
    const service = new ExecutionCapsuleService({
      driver,
      createExportId: () => exportIds.shift() ?? "99999999-9999-4999-8999-999999999999",
    });
    const protectedProbe = await driver.probe();
    expect(protectedProbe.host).toEqual({
      platform: "linux",
      rootlessPodman: true,
      runsc: true,
      systrap: true,
      cgroupsV2: true,
      dedicatedIdentity: true,
    });
    const first = capsuleRequest({
      capsuleId: "11111111-1111-4111-8111-111111111111",
      threadId: "55555555-5555-4555-8555-555555555555",
      image,
    });
    const second = capsuleRequest({
      capsuleId: "22222222-2222-4222-8222-222222222222",
      threadId: "66666666-6666-4666-8666-666666666666",
      image,
    });
    const runtimeIds = [runtimeId(first), runtimeId(second)];
    let recoveredDriver: GvisorPodmanExecutionCapsuleDriver | undefined;

    try {
      const firstAcquisition = await service.acquire({ request: first, source });
      if (firstAcquisition.status !== "ready") {
        throw new Error(`First capsule acquisition ${JSON.stringify(firstAcquisition)}.`);
      }
      const secondAcquisition = await service.acquire({ request: second, source });
      if (secondAcquisition.status !== "ready") {
        throw new Error(`Second capsule acquisition ${JSON.stringify(secondAcquisition)}.`);
      }

      const firstDisk = await stat(join(stateRoot, "stores", runtimeId(first), "capsule.ext4"));
      const secondDisk = await stat(join(stateRoot, "stores", runtimeId(second), "capsule.ext4"));
      expect(firstDisk.size).toBe(first.budget.diskBytes);
      expect(secondDisk.size).toBe(second.budget.diskBytes);
      expect(firstDisk.nlink).toBe(1);
      expect(secondDisk.nlink).toBe(1);
      expect(firstDisk.ino).not.toBe(secondDisk.ino);

      await expect(
        service.execute({
          capsuleId: first.capsuleId,
          argv: ["/bin/sh", "-c", "printf 'first-only' > /workspace/first-only.txt"],
        }),
      ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
      const firstHostPid = Number(
        (
          await podman(stateRoot, runtimeId(first), [
            "inspect",
            "--format",
            "{{.State.Pid}}",
            runtimeId(first),
          ])
        ).trim(),
      );
      const secondHostPid = Number(
        (
          await podman(stateRoot, runtimeId(second), [
            "inspect",
            "--format",
            "{{.State.Pid}}",
            runtimeId(second),
          ])
        ).trim(),
      );
      expect(firstHostPid).toBeGreaterThan(1);
      expect(secondHostPid).toBeGreaterThan(1);
      expect(firstHostPid).not.toBe(secondHostPid);
      await expect(cgroupBudget(firstHostPid)).resolves.toEqual({
        memoryBytes: String(first.budget.memoryBytes),
        pidLimit: String(first.budget.pidLimit),
        cpuRatio: first.budget.cpuMillicores / 1_000,
      });
      await expect(cgroupBudget(secondHostPid)).resolves.toEqual({
        memoryBytes: String(second.budget.memoryBytes),
        pidLimit: String(second.budget.pidLimit),
        cpuRatio: second.budget.cpuMillicores / 1_000,
      });
      await expect(
        service.execute({
          capsuleId: second.capsuleId,
          argv: ["/bin/sh", "-c", "test ! -e /workspace/first-only.txt"],
        }),
      ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
      await expect(
        service.execute({
          capsuleId: second.capsuleId,
          argv: ["/bin/sh", "-c", `! kill -0 ${String(firstHostPid)} 2>/dev/null`],
        }),
      ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
      await expect(
        service.execute({
          capsuleId: second.capsuleId,
          argv: [
            "/bin/sh",
            "-c",
            `! grep -F '${runtimeId(first)}' /proc/1/cgroup /etc/hosts 2>/dev/null`,
          ],
        }),
      ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
      for (const capsule of [first, second]) {
        await expect(
          service.execute({
            capsuleId: capsule.capsuleId,
            argv: [
              "/bin/sh",
              "-c",
              'test "$(git rev-parse --git-common-dir)" = .git && test ! -f .git/objects/info/alternates && test -z "$(find .git/objects -type f -links +1 -print -quit)"',
            ],
          }),
        ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
        await expect(
          service.execute({
            capsuleId: capsule.capsuleId,
            argv: [
              "/bin/sh",
              "-c",
              "! grep -F 'octant-secret-canary' /proc/1/environ && ! env | grep -E '^(OCTANT_DESKTOP_BRIDGE_SECRET|GH_TOKEN|SSH_AUTH_SOCK|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR)='",
            ],
          }),
        ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
        await expect(
          service.execute({
            capsuleId: capsule.capsuleId,
            argv: [
              "/bin/sh",
              "-c",
              `! grep -F '${sourceRoot}' /proc/self/mountinfo && ! grep -F '${sourceBundle}' /proc/self/mountinfo`,
            ],
          }),
        ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
      }
      await expect(
        service.execute({
          capsuleId: first.capsuleId,
          argv: [
            "/bin/sh",
            "-c",
            "test ! -S /run/podman/podman.sock && test ! -S /var/run/docker.sock",
          ],
        }),
      ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
      await expect(
        service.execute({
          capsuleId: first.capsuleId,
          argv: [
            "/bin/sh",
            "-c",
            "printf 'issue-a\\n' > issue-a.txt && git add issue-a.txt && git -c user.name=Octant -c user.email=evidence@octant.invalid commit -m 'Issue A'",
          ],
        }),
      ).resolves.toMatchObject({ status: "exited", exitCode: 0 });

      const firstExport = await service.exportGitBundle(first.capsuleId);
      expect(firstExport).toMatchObject({ status: "exported", receipt: { verified: true } });
      if (firstExport.status !== "exported") throw new Error("First bundle export failed.");
      const secondExport = await service.exportGitBundle(second.capsuleId);
      expect(secondExport).toMatchObject({ status: "exported", receipt: { verified: true } });
      if (secondExport.status !== "exported") throw new Error("Second bundle export failed.");
      expect((await git(sourceRoot, ["rev-parse", "HEAD"])).trim()).toBe(revision);
      expect((await git(sourceRoot, ["branch", "--show-current"])).trim()).toBe(sourceBranchBefore);
      expect(await git(sourceRoot, ["status", "--short"])).toBe(sourceStatusBefore);

      await expect(service.stop(second.capsuleId)).resolves.toMatchObject({
        status: "stopped",
        receipt: { status: "stopped" },
      });
      const recovery = service.recoveryRecord(second.capsuleId);
      if (recovery.status !== "ready") throw new Error("Capsule recovery record is unavailable.");
      recoveredDriver = new GvisorPodmanExecutionCapsuleDriver({
        stateRoot,
        capacity: {
          cpuMillicores: 2_000,
          memoryBytes: 2 * 1_024 * 1_024 * 1_024,
          diskBytes: 8 * 1_024 * 1_024 * 1_024,
          pidLimit: 512,
        },
        podmanPath: process.env.OCTANT_PODMAN_PATH ?? "/usr/bin/podman",
        runscPath: process.env.OCTANT_RUNSC_PATH ?? "/usr/bin/runsc",
      });
      const afterRestart = new ExecutionCapsuleService({
        driver: recoveredDriver,
        revalidateRecovery: async () => ({ status: "valid" }),
      });
      await expect(afterRestart.recover(recovery.record)).resolves.toMatchObject({
        status: "stopped",
        receipt: { capsuleId: second.capsuleId, status: "stopped" },
      });
      expect(
        (
          await podman(stateRoot, runtimeId(second), [
            "inspect",
            "--format",
            "{{.State.Running}}",
            runtimeId(second),
          ])
        ).trim(),
      ).toBe("false");
      await expect(
        afterRestart.execute({ capsuleId: second.capsuleId, argv: ["git", "status"] }),
      ).resolves.toEqual({ status: "refused", reason: "capsule-unavailable" });

      await expect(
        service.release({ capsuleId: first.capsuleId, exportId: firstExport.receipt.exportId }),
      ).resolves.toMatchObject({ status: "released" });
      await expect(
        afterRestart.release({
          capsuleId: second.capsuleId,
          exportId: secondExport.receipt.exportId,
        }),
      ).resolves.toMatchObject({ status: "released" });
      expect(afterRestart.list()).toEqual([]);
    } finally {
      if (recoveredDriver !== undefined) {
        for (const id of runtimeIds) {
          await recoveredDriver.release({ runtimeId: id }).catch(() => undefined);
        }
      }
      for (const id of runtimeIds) await driver.release({ runtimeId: id }).catch(() => undefined);
    }
  });
});

async function git(repositoryRoot: string, args: ReadonlyArray<string>): Promise<string> {
  const result = await execFileAsync("/usr/bin/git", args, {
    cwd: repositoryRoot,
    shell: false,
    timeout: 30_000,
    maxBuffer: 4 * 1_024 * 1_024,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  return result.stdout;
}

async function podman(
  stateRoot: string,
  capsuleRuntimeId: string,
  args: ReadonlyArray<string>,
): Promise<string> {
  const homeDirectory = process.env.HOME;
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const sessionBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
  const mountPath = join(stateRoot, "stores", capsuleRuntimeId, "mount");
  const result = await execFileAsync(
    process.env.OCTANT_PODMAN_PATH ?? "/usr/bin/podman",
    [
      "--root",
      join(mountPath, "graph"),
      "--runroot",
      join(mountPath, "run"),
      "--storage-driver",
      "vfs",
      ...args,
    ],
    {
      shell: false,
      timeout: 30_000,
      maxBuffer: 4 * 1_024 * 1_024,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        ...(homeDirectory === undefined ? {} : { HOME: homeDirectory }),
        ...(runtimeDirectory === undefined ? {} : { XDG_RUNTIME_DIR: runtimeDirectory }),
        ...(sessionBusAddress === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: sessionBusAddress }),
      },
    },
  );
  return result.stdout;
}

async function cgroupBudget(pid: number): Promise<{
  readonly memoryBytes: string;
  readonly pidLimit: string;
  readonly cpuRatio: number;
}> {
  const membership = await readFile(`/proc/${String(pid)}/cgroup`, "utf8");
  const unified = membership.split("\n").find((line) => line.startsWith("0::"));
  if (unified === undefined) throw new Error("Sandbox PID has no unified cgroup membership.");
  const cgroupRoot = join("/sys/fs/cgroup", unified.slice(3).replace(/^\/+/, ""));
  const [memoryBytes, pidLimit, cpuMax] = await Promise.all([
    readFile(join(cgroupRoot, "memory.max"), "utf8"),
    readFile(join(cgroupRoot, "pids.max"), "utf8"),
    readFile(join(cgroupRoot, "cpu.max"), "utf8"),
  ]);
  const [quota, period] = cpuMax.trim().split(" ");
  if (quota === undefined || period === undefined || quota === "max") {
    throw new Error("Sandbox cgroup has no finite CPU limit.");
  }
  return {
    memoryBytes: memoryBytes.trim(),
    pidLimit: pidLimit.trim(),
    cpuRatio: Number(quota) / Number(period),
  };
}

function runtimeId(request: ExecutionCapsuleAcquireRequest): string {
  return `octant-capsule-${String(request.capsuleId).replaceAll("-", "")}`;
}
