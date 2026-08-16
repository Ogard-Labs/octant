import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionSupervisor,
  type ExtensionProcessHandle,
  type ExtensionProcessPort,
  type ExtensionRuntimeStartInput,
} from "./extensionSupervisor";

const extensionId = "42700000-0000-4000-8000-000000000001";
const packageId = "42700000-0000-4000-8000-000000000002";
const digest = `sha256:${"a".repeat(64)}`;

class FakeProcess extends EventEmitter implements ExtensionProcessHandle {
  readonly pid = 4271;
  ready = Promise.resolve();
  readonly wait = Promise.resolve({ code: 0, signal: null });
  readonly stop = vi.fn(async () => undefined);
  readonly cancel = vi.fn(async () => undefined);
  readonly output = "PRIVATE OUTPUT with /private/root and secret-token";
  exited = false;
}

function startInput(
  overrides: Partial<ExtensionRuntimeStartInput> = {},
): ExtensionRuntimeStartInput {
  return {
    extensionId,
    packageId,
    componentId: "server",
    version: "1.0.0",
    digest,
    entryPoint: "/private/octant/extensions/versions/server.mjs",
    command: "/private/octant/extensions/versions/server.mjs",
    args: ["--api-key", "secret-token"],
    cwd: "/private/octant/extensions/versions",
    env: { OCTANT_EXTENSION_ID: extensionId, SECRET_TOKEN: "secret-token" },
    effective: true,
    approved: true,
    authority: { kind: "trusted-extension", extensionId },
    ...overrides,
  };
}

function processPort(processes: FakeProcess[]): ExtensionProcessPort {
  return {
    start: vi.fn(async () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    }),
    receipts: vi.fn(async () => []),
  };
}

function supervisor(
  port: ExtensionProcessPort,
  evidence: unknown[] = [],
  overrides: Partial<ConstructorParameters<typeof ExtensionSupervisor>[0]> = {},
) {
  return new ExtensionSupervisor({
    process: port,
    clock: () => "2026-07-29T12:00:00.000Z",
    authorizeLaunch: async () => true,
    evidence: (event) => evidence.push(event),
    limits: {
      maxComponents: 2,
      startupTimeoutMs: 25,
      drainTimeoutMs: 25,
      maxCrashRestarts: 2,
      crashWindowMs: 1_000,
    },
    ...overrides,
  });
}

describe("extension runtime supervisor", () => {
  it("admits an effective approved component, waits for ready, and redacts launch evidence", async () => {
    const processes: FakeProcess[] = [];
    const evidence: unknown[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port, evidence);

    await expect(runtime.start(startInput())).resolves.toMatchObject({ state: "ready" });
    expect(port.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/private/octant/extensions/versions/server.mjs",
        cwd: "/private/octant/extensions/versions",
        maxOutputBytes: expect.any(Number),
        env: { OCTANT_EXTENSION_ID: extensionId },
      }),
    );
    expect(JSON.stringify(evidence)).not.toContain("secret-token");
    expect(JSON.stringify(evidence)).not.toContain("/private/octant");
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE OUTPUT");
  });

  it("preserves the approved MCP environment only for interactive runtimes", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port);

    await runtime.start(
      startInput({
        readiness: "spawn",
        env: {
          PATH: "/opt/homebrew/bin:/usr/bin:/bin",
          HOME: "/Users/example",
          PLUGIN_ROOT: "/private/octant/plugin",
          PLUGIN_DATA: "/private/octant/data",
          CONFIG: "public-value",
          OCTANT_CREDENTIAL: "must-not-pass",
        },
      }),
    );

    expect(port.start).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          PATH: "/opt/homebrew/bin:/usr/bin:/bin",
          HOME: "/Users/example",
          PLUGIN_ROOT: "/private/octant/plugin",
          PLUGIN_DATA: "/private/octant/data",
          CONFIG: "public-value",
        },
      }),
    );
  });

  it("does not auto-restart an interactive MCP child with an orphaned transport", async () => {
    const processes: FakeProcess[] = [];
    const runtime = supervisor(processPort(processes));

    await runtime.start(startInput({ readiness: "spawn" }));
    processes[0]!.emit("exit", { code: 1, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(processes).toHaveLength(1);
    await expect(runtime.receipts()).resolves.toEqual([
      expect.objectContaining({ state: "crashed" }),
    ]);
  });

  it("owns sandboxed interactive runtimes per authority scope", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port);
    const sandbox = (threadId: string) => ({
      kind: "macos-seatbelt" as const,
      scope: {
        hostId: "local",
        mode: "chat" as const,
        projectId: null,
        threadId,
        providerFamily: "openai-compatible",
      },
      allowRead: ["/private/octant/extensions"],
      allowWrite: ["/private/octant/data"],
      allowNetwork: false,
    });

    await runtime.start(startInput({ readiness: "spawn", sandbox: sandbox("thread-1") }));
    await runtime.start(startInput({ readiness: "spawn", sandbox: sandbox("thread-2") }));

    expect(port.start).toHaveBeenCalledTimes(2);
    await expect(runtime.receipts()).resolves.toHaveLength(2);
  });

  it.each([
    ["ineffective", { effective: false, blockReason: "untrusted" }],
    ["unapproved", { approved: false }],
    ["mismatched authority", { authority: { kind: "trusted-extension", extensionId: "other" } }],
  ] as const)("rejects %s admission without starting a process", async (_label, overrides) => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port);

    await expect(runtime.start(startInput(overrides))).rejects.toMatchObject({
      category: "blocked",
    });
    expect(port.start).not.toHaveBeenCalled();
    expect(processes).toHaveLength(0);
  });

  it("cancels and drains owned work before stopping, while refusing new starts after disable", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port);
    await runtime.start(startInput());

    await runtime.blockNewActivation(extensionId);
    await expect(runtime.start(startInput({ componentId: "other" }))).rejects.toMatchObject({
      category: "blocked",
    });
    await expect(runtime.drain(extensionId)).resolves.toEqual({ state: "drained" });
    expect(processes[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(processes[0]?.stop).toHaveBeenCalledTimes(1);
    expect(await runtime.receipts()).toEqual([]);
  });

  it("keeps disable-pending when owned process cleanup times out and blocks unregister", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port);
    await runtime.start(startInput());
    processes[0]!.stop.mockImplementation(() => new Promise(() => undefined));

    await runtime.blockNewActivation(extensionId);
    await expect(runtime.drain(extensionId)).resolves.toEqual({ state: "waiting" });
    expect((await runtime.receipts())[0]).toMatchObject({ state: "disable-pending" });
    await expect(runtime.unregister(extensionId)).rejects.toMatchObject({ category: "waiting" });
  });

  it("keeps a partially started process waiting when readiness times out and cleanup is uncertain", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    processes.push(new FakeProcess());
    processes[0]!.ready = new Promise(() => undefined);
    (port.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce(processes[0]);
    processes[0]!.stop.mockImplementation(() => new Promise(() => undefined));
    const runtime = supervisor(port);

    await expect(runtime.start(startInput())).rejects.toMatchObject({ category: "waiting" });
    expect((await runtime.receipts())[0]).toMatchObject({ state: "disable-pending" });
  });

  it("recovers one crash within the bound and quarantines a crash loop", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port);
    await runtime.start(startInput());

    processes[0]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    await vi.waitFor(async () =>
      expect((await runtime.receipts())[0]).toMatchObject({ state: "ready" }),
    );

    processes[1]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(() => expect(processes).toHaveLength(3));
    await vi.waitFor(async () =>
      expect((await runtime.receipts())[0]).toMatchObject({ state: "ready" }),
    );
    processes[2]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(async () =>
      expect((await runtime.receipts())[0]).toMatchObject({ state: "quarantined" }),
    );
    await expect(runtime.start(startInput())).rejects.toMatchObject({ category: "blocked" });
  });

  it("reuses a crashed component's slot at capacity without admitting a new component", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port, [], { limits: { maxComponents: 1 } });
    await runtime.start(startInput());
    await expect(runtime.start(startInput({ componentId: "other" }))).rejects.toMatchObject({
      category: "unavailable",
    });

    processes[0]!.emit("exit", { code: 1, signal: null });

    await vi.waitFor(() => expect(processes).toHaveLength(2));
    await vi.waitFor(async () =>
      expect((await runtime.receipts())[0]).toMatchObject({ state: "ready" }),
    );
    await expect(runtime.start(startInput({ componentId: "other" }))).rejects.toMatchObject({
      category: "unavailable",
    });
    expect(port.start).toHaveBeenCalledTimes(2);
  });

  it("reconciles an unknown process receipt to quarantine instead of treating it as ready", async () => {
    const port: ExtensionProcessPort = {
      start: vi.fn(),
      receipts: vi.fn(async () => [
        {
          extensionId,
          packageId,
          componentId: "server",
          version: "1.0.0",
          digest,
          state: "running" as const,
        },
      ]),
    };
    const runtime = supervisor(port);

    await runtime.reconcile();
    expect((await runtime.receipts())[0]).toMatchObject({ state: "quarantined" });
    expect(port.start).not.toHaveBeenCalled();
  });

  it("does not let a concurrent disable turn a partial start back into ready", async () => {
    const processes: FakeProcess[] = [];
    let releaseAuthorization!: (allowed: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      releaseAuthorization = resolve;
    });
    const port = processPort(processes);
    const runtime = supervisor(port, [], { authorizeLaunch: async () => authorization });

    const starting = runtime.start(startInput());
    await vi.waitFor(async () =>
      expect((await runtime.receipts())[0]).toMatchObject({ state: "starting" }),
    );
    await runtime.blockNewActivation(extensionId);
    releaseAuthorization(true);

    await expect(starting).rejects.toMatchObject({ category: "interrupted" });
    expect(processes).toHaveLength(0);
    expect((await runtime.receipts())[0]).toMatchObject({ state: "disable-pending" });
    await expect(runtime.start(startInput())).rejects.toMatchObject({ category: "blocked" });
  });

  it("times out a hung authorizer and never invokes the process port", async () => {
    const port = processPort([]);
    let authorizationSignal: AbortSignal | undefined;
    const runtime = supervisor(port, [], {
      authorizeLaunch: async (_input, signal) => {
        authorizationSignal = signal;
        return new Promise<boolean>(() => undefined);
      },
      limits: { startupTimeoutMs: 25 },
    });

    await expect(runtime.start(startInput())).rejects.toMatchObject({ category: "waiting" });
    expect(port.start).not.toHaveBeenCalled();
    expect(authorizationSignal?.aborted).toBe(true);
  });

  it("cancels a hung process acquisition and stops a late-owned process", async () => {
    const processes: FakeProcess[] = [];
    let releaseProcess!: (process: FakeProcess) => void;
    const acquisition = new Promise<FakeProcess>((resolve) => {
      releaseProcess = resolve;
    });
    let acquisitionSignal: AbortSignal | undefined;
    const port: ExtensionProcessPort = {
      start: vi.fn(async (input) => {
        acquisitionSignal = input.signal;
        return acquisition;
      }),
      receipts: vi.fn(async () => []),
    };
    const runtime = supervisor(port, [], { limits: { startupTimeoutMs: 25 } });
    const starting = runtime.start(startInput());
    void starting.catch(() => undefined);

    await vi.waitFor(() => expect(port.start).toHaveBeenCalled());
    await expect(starting).rejects.toMatchObject({ category: "waiting" });
    const lateProcess = new FakeProcess();
    processes.push(lateProcess);
    releaseProcess(lateProcess);
    await vi.waitFor(() => expect(lateProcess.stop).toHaveBeenCalledTimes(1));
    expect(acquisitionSignal?.aborted).toBe(true);
    expect((await runtime.receipts())[0]).toMatchObject({ state: "disable-pending" });
  });

  it("keeps drain waiting until a disabled partial acquisition is owned and stopped", async () => {
    let releaseProcess!: (process: FakeProcess) => void;
    const acquisition = new Promise<FakeProcess>((resolve) => {
      releaseProcess = resolve;
    });
    const port: ExtensionProcessPort = {
      start: vi.fn(async () => acquisition),
      receipts: vi.fn(async () => []),
    };
    const evidence: unknown[] = [];
    const runtime = supervisor(port, evidence, { limits: { drainTimeoutMs: 25 } });
    const starting = runtime.start(startInput());
    void starting.catch(() => undefined);
    await vi.waitFor(() => expect(port.start).toHaveBeenCalled());

    await runtime.blockNewActivation(extensionId);
    await expect(runtime.drain(extensionId)).resolves.toEqual({ state: "waiting" });
    expect((await runtime.receipts())[0]).toMatchObject({ state: "disable-pending" });

    const lateProcess = new FakeProcess();
    releaseProcess(lateProcess);
    await expect(starting).rejects.toMatchObject({ category: "interrupted" });
    await vi.waitFor(() => expect(lateProcess.stop).toHaveBeenCalledTimes(1));
    await expect(runtime.drain(extensionId)).resolves.toEqual({ state: "drained" });
    expect(await runtime.receipts()).toEqual([]);
    expect(evidence).not.toContainEqual(expect.objectContaining({ state: "ready" }));
  });

  it("fails closed when a ready component changes package identity", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port);
    await runtime.start(startInput());

    await expect(
      runtime.start(startInput({ version: "2.0.0", digest: `sha256:${"b".repeat(64)}` })),
    ).rejects.toMatchObject({ category: "conflict" });
    expect(port.start).toHaveBeenCalledTimes(1);
    expect((await runtime.receipts())[0]).toMatchObject({ state: "ready" });

    await expect(
      runtime.start(startInput({ packageId: "42700000-0000-4000-8000-000000000099" })),
    ).rejects.toMatchObject({ category: "conflict" });
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it("reuses the crashed runtime slot for bounded recovery at capacity", async () => {
    const processes: FakeProcess[] = [];
    const port = processPort(processes);
    const runtime = supervisor(port, [], {
      limits: { maxComponents: 1, maxCrashRestarts: 1 },
    });

    await runtime.start(startInput());
    processes[0]!.emit("exit", { code: 1, signal: null });

    await vi.waitFor(() => expect(processes).toHaveLength(2));
    await expect(runtime.receipts()).resolves.toMatchObject([{ state: "ready" }]);
  });
});
