import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_CLEANUP_PENDING_MESSAGE,
  WindowsConfinementLeaseStore,
} from "./windowsConfinementRecovery";

const LAUNCHER = "C:\\Program Files\\Octant\\resources\\native\\octant-windows-confine.exe";
const LAUNCH_A = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const LAUNCH_B = "102030405060708090a0b0c0d0e0f011";
const CONTAINER_A = `Octant.Confined.${LAUNCH_A}`;
const CONTAINER_B = `Octant.Confined.${LAUNCH_B}`;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function leaseDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "octant-win-lease-test-"));
  directories.push(dir);
  return dir;
}

describe("Windows confinement durable pre-ACL recovery", () => {
  it("writes the durable pre-ACL record before launch, updates PID, and removes it only after verified recovery", async () => {
    const dir = leaseDirectory();
    const calls: Array<{ readonly launcher: string; readonly args: ReadonlyArray<string> }> = [];
    const store = new WindowsConfinementLeaseStore({
      leaseDirectory: dir,
      isProcessAlive: () => false,
      runRecovery: async (launcher, args) => {
        calls.push({ launcher, args });
        return true;
      },
    });

    const recorded = store.recordPreAcl({
      launchId: LAUNCH_A,
      appContainerName: CONTAINER_A,
      grants: ["C:\\Work\\repo", "C:\\Temp\\scratch"],
      launcherPath: LAUNCHER,
    });
    expect(recorded).toEqual({ status: "recorded" });
    expect(existsSync(join(dir, `${LAUNCH_A}.json`))).toBe(true);

    store.recordLauncherPid(LAUNCH_A, 4242);

    const released = await store.releaseAndVerify(LAUNCH_A);
    expect(released).toEqual({ status: "clean" });
    expect(calls).toEqual([
      {
        launcher: LAUNCHER,
        args: [
          "--recover",
          "--container",
          CONTAINER_A,
          "--grant-path",
          "C:\\Work\\repo",
          "--grant-path",
          "C:\\Temp\\scratch",
        ],
      },
    ]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("recovers leftover leases on startup after terminating a surviving launcher, and is idempotent", async () => {
    const dir = leaseDirectory();
    // Simulate a crashed host that left a durable record with a live PID.
    const writer = new WindowsConfinementLeaseStore({ leaseDirectory: dir });
    writer.recordPreAcl({
      launchId: LAUNCH_A,
      appContainerName: CONTAINER_A,
      grants: ["C:\\Work\\repo"],
      launcherPath: LAUNCHER,
    });
    writer.recordLauncherPid(LAUNCH_A, 7777);

    let alive = true;
    const stopped: number[] = [];
    const recovered: Array<ReadonlyArray<string>> = [];
    const restarted = new WindowsConfinementLeaseStore({
      leaseDirectory: dir,
      isProcessAlive: (pid) => pid === 7777 && alive,
      stopProcessTree: async (pid) => {
        stopped.push(pid);
        alive = false;
        return "stopped";
      },
      runRecovery: async (_launcher, args) => {
        recovered.push(args);
        return true;
      },
    });

    // Before recovery completes, overlapping grants are refused as cleanup-pending.
    expect(restarted.pendingBlockerFor(["C:\\Work\\repo\\sub"])).toBe(
      WINDOWS_CLEANUP_PENDING_MESSAGE,
    );
    // Unrelated grants are not blocked by a valid lease on another folder.
    expect(restarted.pendingBlockerFor(["C:\\Other\\project"])).toBeUndefined();

    const firstSweep = await restarted.recoverAll();
    expect(firstSweep).toEqual({ status: "clean", recoveredCount: 1 });
    expect(stopped).toEqual([7777]);
    expect(recovered).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);

    // Re-running startup recovery is idempotent.
    const secondSweep = await restarted.recoverAll();
    expect(secondSweep).toEqual({ status: "clean", recoveredCount: 0 });
    expect(restarted.pendingBlockerFor(["C:\\Work\\repo"])).toBeUndefined();
  });

  it("retains the durable record and refuses affected launches when cleanup cannot be verified", async () => {
    const dir = leaseDirectory();
    let shouldSucceed = false;
    const store = new WindowsConfinementLeaseStore({
      leaseDirectory: dir,
      isProcessAlive: () => false,
      runRecovery: async () => shouldSucceed,
    });

    expect(
      store.recordPreAcl({
        launchId: LAUNCH_A,
        appContainerName: CONTAINER_A,
        grants: ["C:\\Work\\repo"],
        launcherPath: LAUNCHER,
      }),
    ).toEqual({ status: "recorded" });

    const failedCleanup = await store.releaseAndVerify(LAUNCH_A);
    expect(failedCleanup).toEqual({
      status: "cleanup-pending",
      message: WINDOWS_CLEANUP_PENDING_MESSAGE,
    });
    expect(existsSync(join(dir, `${LAUNCH_A}.json`))).toBe(true);

    // An overlapping launch is refused until recovery succeeds.
    expect(
      store.recordPreAcl({
        launchId: LAUNCH_B,
        appContainerName: CONTAINER_B,
        grants: ["C:\\Work\\repo"],
        launcherPath: LAUNCHER,
      }),
    ).toEqual({ status: "refused", message: WINDOWS_CLEANUP_PENDING_MESSAGE });

    // Once recovery succeeds, the record is cleared and launches resume.
    shouldSucceed = true;
    const recovered = await store.recoverAll();
    expect(recovered).toEqual({ status: "clean", recoveredCount: 1 });
    expect(
      store.recordPreAcl({
        launchId: LAUNCH_B,
        appContainerName: CONTAINER_B,
        grants: ["C:\\Work\\repo"],
        launcherPath: LAUNCHER,
      }),
    ).toEqual({ status: "recorded" });
  });

  it("refuses all launches globally if a malformed lease record cannot be parsed", async () => {
    const dir = leaseDirectory();
    writeFileSync(join(dir, "corrupt.json"), "{not-valid-json", "utf8");
    const store = new WindowsConfinementLeaseStore({
      leaseDirectory: dir,
      runRecovery: vi.fn(async () => true),
    });

    const sweep = await store.recoverAll();
    expect(sweep).toMatchObject({
      status: "cleanup-pending",
      pendingCount: 1,
      message: WINDOWS_CLEANUP_PENDING_MESSAGE,
    });
    expect(
      store.recordPreAcl({
        launchId: LAUNCH_A,
        appContainerName: CONTAINER_A,
        grants: ["C:\\Unrelated\\repo"],
        launcherPath: LAUNCHER,
      }),
    ).toEqual({ status: "refused", message: WINDOWS_CLEANUP_PENDING_MESSAGE });
  });
});
