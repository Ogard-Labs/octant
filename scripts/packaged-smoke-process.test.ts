import { describe, expect, it, vi } from "vitest";
import {
  PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS,
  PACKAGED_SMOKE_SERVER_PORT,
  PACKAGED_SMOKE_SERVER_URL,
  cleanupPackagedProcess,
  packagedServerEnvironment,
  runBoundedCommand,
  sanitizedPackagedEnvironment,
  waitForProcessCleanup,
  type BoundedCommandHandle,
} from "./packaged-smoke-process";

describe("sanitizedPackagedEnvironment", () => {
  it("keeps only portable host values and excludes Bun-specific environment", () => {
    expect(
      sanitizedPackagedEnvironment(
        {
          HOME: "/Users/test",
          TMPDIR: "/tmp/",
          LANG: "en_US.UTF-8",
          PATH: "/opt/homebrew/bin:/usr/bin",
          BUN_INSTALL: "/Users/test/.bun",
          OCTANT_WEB_URL: "http://127.0.0.1:5173",
        },
        "/tmp/octant-data",
      ),
    ).toEqual({
      HOME: "/Users/test",
      TMPDIR: "/tmp/",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      OCTANT_DATA_DIR: "/tmp/octant-data",
    });
  });

  it("adds the deterministic server port used by packaged provider smokes", () => {
    expect(packagedServerEnvironment({ HOME: "/Users/test" }, "/tmp/octant-data")).toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      OCTANT_DATA_DIR: "/tmp/octant-data",
      OCTANT_SERVER_PORT: String(PACKAGED_SMOKE_SERVER_PORT),
    });
    expect(PACKAGED_SMOKE_SERVER_URL).toBe(`http://127.0.0.1:${PACKAGED_SMOKE_SERVER_PORT}`);
  });
});

describe("cleanupPackagedProcess", () => {
  it("polls transient process residue within a hard cleanup bound", async () => {
    const assertNoProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient renderer"))
      .mockResolvedValue(undefined);

    await waitForProcessCleanup(assertNoProcesses, {
      timeoutMs: 20_000,
      intervalMs: 0,
      sleep: async () => undefined,
    });

    expect(assertNoProcesses).toHaveBeenCalledTimes(2);
    expect(assertNoProcesses).toHaveBeenNthCalledWith(1, PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS);
  });

  it("terminates and awaits one timed-out cleanup subprocess before rejecting", async () => {
    let resolveExit: ((exitCode: number | null) => void) | undefined;
    let finalized = false;
    const exit = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    }).finally(() => {
      finalized = true;
    });
    const terminate = vi.fn(async () => {
      resolveExit?.(null);
      await exit;
    });
    const startCommand = vi.fn(
      (): BoundedCommandHandle => ({
        exit,
        stdout: Promise.resolve(""),
        stderr: Promise.resolve(""),
        terminate,
      }),
    );
    let probes = 0;

    await expect(
      waitForProcessCleanup(
        async (remainingMs) => {
          probes += 1;
          await runBoundedCommand("/bin/ps", [], {}, remainingMs, startCommand);
        },
        {
          timeoutMs: 10,
          probeTimeoutMs: 10,
          intervalMs: 0,
        },
      ),
    ).rejects.toThrow("timed out");

    expect(startCommand).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    expect(finalized).toBe(true);
    expect(probes).toBe(1);
  });

  it("awaits process-group fallback and verifies child/listener cleanup after failure", async () => {
    const child = { exitCode: null, signalCode: null, pid: 42 };
    const requestQuit = vi.fn().mockRejectedValue(new Error("window unavailable"));
    const waitForExit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const signalGroup = vi.fn();
    const waitForServerCleanup = vi.fn().mockResolvedValue(undefined);
    const assertNoProcesses = vi.fn().mockResolvedValue(undefined);

    await cleanupPackagedProcess({
      child,
      requestQuit,
      waitForExit,
      signalGroup,
      waitForServerCleanup,
      assertNoProcesses,
      gracefulTimeoutMs: 10,
      forceTimeoutMs: 5,
    });

    expect(requestQuit).toHaveBeenCalledOnce();
    expect(waitForExit.mock.calls).toEqual([
      [child, 10],
      [child, 10],
    ]);
    expect(signalGroup).toHaveBeenCalledWith(42, "SIGTERM");
    expect(waitForServerCleanup).toHaveBeenCalledOnce();
    expect(assertNoProcesses).toHaveBeenCalledOnce();
  });

  it("escalates the process group to SIGKILL when SIGTERM does not exit", async () => {
    const child = { exitCode: null, signalCode: null, pid: 84 };
    const waitForExit = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const signalGroup = vi.fn();

    await cleanupPackagedProcess({
      child,
      requestQuit: vi.fn().mockRejectedValue(new Error("window unavailable")),
      waitForExit,
      signalGroup,
      waitForServerCleanup: vi.fn().mockResolvedValue(undefined),
      assertNoProcesses: vi.fn().mockResolvedValue(undefined),
      gracefulTimeoutMs: 10,
      forceTimeoutMs: 5,
    });

    expect(signalGroup.mock.calls).toEqual([
      [84, "SIGTERM"],
      [84, "SIGKILL"],
    ]);
    expect(waitForExit.mock.calls.map((call) => call[1])).toEqual([10, 10, 5]);
  });
});
