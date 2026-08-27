import { isAbsolute } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveServerRunOptions, runServerRunCommand, type ServerRunSpawnSpec } from "./serverRun";

describe("runServerRunCommand", () => {
  it("uses an absolute runtime for the default nested server invocation", async () => {
    let captured: { readonly command: string; readonly args: readonly string[] } | undefined;
    await runServerRunCommand({
      env: {},
      spawn: (spec) => {
        captured = spec;
        return { exited: Promise.resolve(0), kill: vi.fn() };
      },
      instanceId: () => "11111111-1111-4111-8111-111111111111",
      bridgeSecret: () => "foreground-bridge-secret",
      installSignalHandler: () => () => undefined,
    });

    expect(captured).toBeDefined();
    expect(isAbsolute(captured!.command)).toBe(true);
    expect(captured!.command).toBe(process.execPath);
    expect(captured!.args).toEqual([
      "run",
      "--cwd",
      expect.stringMatching(/\/apps\/server$/),
      "start",
    ]);
  });

  it("runs the shared server in the foreground with canonical ownership metadata", async () => {
    let captured:
      | {
          readonly command: string;
          readonly args: readonly string[];
          readonly env: NodeJS.ProcessEnv;
        }
      | undefined;
    const child = {
      exited: Promise.resolve(0),
      kill: vi.fn(),
    };
    const result = await runServerRunCommand({
      env: { OCTANT_DATA_DIR: "/tmp/octant-test" },
      serverStartCommand: () => ({ command: "server-bin", args: ["serve"] }),
      spawn: (spec) => {
        captured = spec;
        return child;
      },
      instanceId: () => "11111111-1111-4111-8111-111111111111",
      bridgeSecret: () => "foreground-bridge-secret",
      installSignalHandler: () => () => undefined,
    });

    expect(result).toBe(0);
    expect(captured).toMatchObject({
      command: "server-bin",
      args: ["serve"],
      env: {
        OCTANT_DATA_DIR: "/tmp/octant-test",
        OCTANT_HOST_SERVICE_MODE: "foreground",
        OCTANT_SERVER_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
        OCTANT_DESKTOP_BRIDGE_SECRET: "foreground-bridge-secret",
      },
    });
  });

  it("accepts only the documented server-run argument shape", () => {
    expect(resolveServerRunOptions({ port: "14780" }, ["run"])).toEqual({ port: 14780 });
    expect(resolveServerRunOptions({}, ["run"])).toEqual({});
    expect(resolveServerRunOptions({ prot: "14780" }, ["run"])).toBeUndefined();
    expect(resolveServerRunOptions({ port: true }, ["run"])).toBeUndefined();
    expect(resolveServerRunOptions({ port: "not-a-port" }, ["run"])).toBeUndefined();
    expect(resolveServerRunOptions({ port: "0" }, ["run"])).toBeUndefined();
    expect(resolveServerRunOptions({ port: "65536" }, ["run"])).toBeUndefined();
    expect(resolveServerRunOptions({}, ["run", "extra"])).toBeUndefined();
  });

  it("forwards termination to the foreground child and preserves its exit code", async () => {
    let terminate: (() => void) | undefined;
    const kill = vi.fn();
    const result = await runServerRunCommand({
      env: {},
      spawn: () => ({ exited: Promise.resolve(7), kill }),
      serverStartCommand: () => ({ command: "server-bin", args: [] }),
      instanceId: () => "11111111-1111-4111-8111-111111111111",
      installSignalHandler: (handler) => {
        terminate = handler;
        return () => undefined;
      },
      afterSpawn: () => terminate?.(),
    });

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(result).toBe(7);
  });

  it("restarts a crashed foreground server after the calculated backoff", async () => {
    const children = [
      { exited: Promise.resolve(9), kill: vi.fn() },
      { exited: Promise.resolve(0), kill: vi.fn() },
    ];
    const specs: ServerRunSpawnSpec[] = [];
    const spawn = vi.fn((spec: ServerRunSpawnSpec) => {
      specs.push(spec);
      return children.shift() ?? { exited: Promise.resolve(0), kill: vi.fn() };
    });
    const sleep = vi.fn(async () => undefined);
    const writeNotice = vi.fn();
    const result = await runServerRunCommand({
      env: {},
      spawn,
      sleep,
      writeNotice,
      installSignalHandler: () => () => undefined,
      instanceId: vi
        .fn()
        .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
        .mockReturnValueOnce("22222222-2222-4222-8222-222222222222"),
      bridgeSecret: vi
        .fn()
        .mockReturnValueOnce("first-secret")
        .mockReturnValueOnce("second-secret"),
    });

    expect(result).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(writeNotice).toHaveBeenCalledWith(
      "Octant server exited with code 9; restarting in 1000ms.",
    );
    expect(specs[0]?.env.OCTANT_SERVER_INSTANCE_ID).not.toBe(
      specs[1]?.env.OCTANT_SERVER_INSTANCE_ID,
    );
    expect(specs[0]?.env.OCTANT_DESKTOP_BRIDGE_SECRET).not.toBe(
      specs[1]?.env.OCTANT_DESKTOP_BRIDGE_SECRET,
    );
  });

  it("does not restart a foreground server that exits cleanly", async () => {
    const spawn = vi.fn(() => ({ exited: Promise.resolve(0), kill: vi.fn() }));
    const result = await runServerRunCommand({
      env: {},
      spawn,
      installSignalHandler: () => () => undefined,
    });

    expect(result).toBe(0);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("does not restart a foreground server after Ctrl-C requests shutdown", async () => {
    let terminate: (() => void) | undefined;
    const spawn = vi.fn(() => ({ exited: Promise.resolve(7), kill: vi.fn() }));
    const result = await runServerRunCommand({
      env: {},
      spawn,
      installSignalHandler: (handler) => {
        terminate = handler;
        return () => undefined;
      },
      afterSpawn: () => terminate?.(),
    });

    expect(result).toBe(7);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("returns the last exit code when repeated foreground crashes reach the cap", async () => {
    const spawn = vi.fn(() => ({ exited: Promise.resolve(11), kill: vi.fn() }));
    const sleep = vi.fn(async () => undefined);
    const result = await runServerRunCommand({
      env: {},
      spawn,
      sleep,
      writeNotice: vi.fn(),
      installSignalHandler: () => () => undefined,
    });

    expect(result).toBe(11);
    expect(spawn).toHaveBeenCalledTimes(6);
  });
});
