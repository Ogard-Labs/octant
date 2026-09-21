import type {
  AndroidDiscoveryRequest,
  AndroidEmulatorRequest,
  ToolActionAuthority,
  ToolActionCancellation,
} from "@octant/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

type ServiceConstructor = new (options: Record<string, unknown>) => {
  discover(request: AndroidDiscoveryRequest, context: ExecutionContext): Promise<any>;
  execute(request: AndroidEmulatorRequest, context: ExecutionContext): Promise<any>;
  snapshot(context: ExecutionContext): any;
  cancel(request: ToolActionCancellation, context: ExecutionContext): Promise<boolean>;
  requestPaneOpen(context: ExecutionContext, emulatorId: string): any;
  watchScreen(
    id: string,
    context: ExecutionContext,
    signal: AbortSignal,
  ): Promise<
    | { kind: "watching"; frames: ReadableStream<Uint8Array> }
    | { kind: "unavailable"; message: string }
  >;
  close(): Promise<void>;
};

let AndroidToolchainService: ServiceConstructor;
let isReplayedAndroidEvidence: (value: unknown) => boolean;

beforeAll(async () => {
  const path = "./androidToolchainService";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.AndroidToolchainService).toBeTypeOf("function");
  AndroidToolchainService = loaded!.AndroidToolchainService as ServiceConstructor;
  isReplayedAndroidEvidence = loaded!.isReplayedAndroidEvidence as typeof isReplayedAndroidEvidence;
});

const ids = {
  action: "30000000-0000-4000-8000-000000000001",
  correlation: "30000000-0000-4000-8000-000000000002",
  host: "30000000-0000-4000-8000-000000000003",
  project: "30000000-0000-4000-8000-000000000004",
  provider: "30000000-0000-4000-8000-000000000007",
  thread: "30000000-0000-4000-8000-000000000008",
  checkout: "30000000-0000-4000-8000-000000000009",
  approval: "30000000-0000-4000-8000-000000000011",
} as const;

const authority: ToolActionAuthority = {
  hostId: ids.host as never,
  mode: "code",
  projectId: ids.project as never,
  providerInstanceId: ids.provider as never,
  extension: { kind: "core" },
};

interface ExecutionContext {
  readonly authority: ToolActionAuthority;
  readonly threadId: any;
  readonly checkoutId: any;
  readonly checkoutRoot: string;
  readonly artifactRoot: string;
  readonly executionPolicy: "plan" | "approval-gated" | "full-access";
  readonly approvalValid: boolean;
  readonly inputGranted?: boolean;
}

const context: ExecutionContext = {
  authority,
  threadId: ids.thread,
  checkoutId: ids.checkout,
  checkoutRoot: "/private/project",
  artifactRoot: "/private/artifacts",
  executionPolicy: "full-access",
  approvalValid: true,
};

const actor = { kind: "local-user" as const, actorId: "30000000-0000-4000-8000-000000000099" };

const discoveryRequest: AndroidDiscoveryRequest = {
  actionId: ids.action as never,
  correlationId: ids.correlation as never,
  authority,
  threadId: ids.thread as never,
  checkoutId: ids.checkout as never,
};

function processResult(stdout: string) {
  return {
    termination: "exited" as const,
    exitCode: 0,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    cleanupUncertain: false,
  };
}

function discoveryExecutor() {
  return vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
    const argv = input.argv.join(" ");
    if (argv.includes("-list-avds")) return processResult("Pixel_8_API_34\n");
    if (argv.includes("devices")) {
      return processResult(
        "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64\n",
      );
    }
    if (argv.includes("emu avd name") || argv.includes("avd name")) {
      return processResult("Pixel_8_API_34\r\nOK\r\n");
    }
    if (argv.includes("sys.boot_completed")) return processResult("1\n");
    if (argv.includes("input tap") || argv.includes("input swipe") || argv.includes("input text")) {
      return processResult("");
    }
    if (argv.includes("emu kill")) return processResult("");
    return processResult("");
  });
}

function action(kind: AndroidEmulatorRequest["kind"], extra: Record<string, unknown> = {}) {
  return {
    actionId: ids.action,
    correlationId: ids.correlation,
    authority,
    threadId: ids.thread,
    checkoutId: ids.checkout,
    kind,
    emulatorId: "Pixel_8_API_34",
    approval: { kind: "not-required" },
    timeoutMs: 30_000,
    ...extra,
  } as AndroidEmulatorRequest;
}

describe("AndroidToolchainService", () => {
  it("discovers AVDs the SDK lists and which adb already sees", async () => {
    const execute = discoveryExecutor();
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    const result = await service.discover(discoveryRequest, context);
    expect(result.kind).toBe("discovered");
    if (result.kind !== "discovered") return;
    expect(result.sdk.available).toBe(true);
    expect(result.emulators).toEqual([
      expect.objectContaining({
        emulatorId: "Pixel_8_API_34",
        state: "booted",
        serial: "emulator-5554",
      }),
    ]);
  });

  it("opens a grant without sending adb input", async () => {
    const execute = discoveryExecutor();
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    execute.mockClear();
    const evidence = await service.execute(
      action("open-input", {
        requestedBy: actor,
        approval: { kind: "approved", approvalId: ids.approval },
      }),
      { ...context, executionPolicy: "approval-gated", approvalValid: true },
    );
    expect(evidence.outcome).toBe("succeeded");
    expect(evidence.kind).toBe("open-input");
    expect(JSON.stringify(evidence.diagnostics)).toContain("Input is allowed to this emulator.");
    expect(execute).not.toHaveBeenCalled();
  });

  it("sends a tap through adb once the destination is booted", async () => {
    const execute = discoveryExecutor();
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const evidence = await service.execute(
      action("tap", { requestedBy: actor, point: { x: 40, y: 80 } }),
      context,
    );
    expect(evidence.outcome).toBe("succeeded");
    expect(execute.mock.calls.some((call) => call[0].argv.includes("tap"))).toBe(true);
  });

  it("boots an AVD as a detached process and waits for adb readiness", async () => {
    let attached = false;
    const execute = vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
      const argv = input.argv.join(" ");
      if (argv.includes("-list-avds")) return processResult("Pixel_8_API_34\n");
      if (argv.includes("devices")) {
        return processResult(
          attached
            ? "List of devices attached\nemulator-5554          device\n"
            : "List of devices attached\n",
        );
      }
      if (argv.includes("avd name")) return processResult("Pixel_8_API_34\r\nOK\r\n");
      if (argv.includes("sys.boot_completed")) return processResult("1\n");
      return processResult("");
    });
    const spawnDetached = vi.fn(async () => {
      attached = true;
      return { kind: "spawned" as const };
    });
    const service = new AndroidToolchainService({
      execute,
      spawnDetached,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    const listed = await service.discover(discoveryRequest, context);
    expect(listed.kind).toBe("discovered");
    if (listed.kind === "discovered") {
      expect(listed.emulators[0]?.state).toBe("shutdown");
    }
    const evidence = await service.execute(action("boot", { timeoutMs: 5_000 }), context);
    expect(spawnDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining(["-avd", "Pixel_8_API_34", "-no-window", "-no-audio"]),
      }),
    );
    expect(evidence.outcome).toBe("succeeded");
  });

  it("stamps a pane-open request for the bound thread", async () => {
    const service = new AndroidToolchainService({
      execute: discoveryExecutor(),
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const snapshot = service.requestPaneOpen(context, "Pixel_8_API_34" as never);
    expect(snapshot.paneOpenRequest).toEqual({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      emulatorId: "Pixel_8_API_34",
      requestedAt: "2026-09-20T20:00:00.000Z",
    });
    const other = { ...context, threadId: "30000000-0000-4000-8000-000000000099" as never };
    service.requestPaneOpen(other, "Pixel_8_API_34" as never);
    expect(service.snapshot(context).paneOpenRequest).toEqual(snapshot.paneOpenRequest);
    expect(service.snapshot(other).paneOpenRequest).toBeDefined();
  });

  it("returns replayed evidence for a repeated input without sending it again", async () => {
    const execute = discoveryExecutor();
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const request = action("tap", { requestedBy: actor, point: { x: 1, y: 2 } });
    const first = await service.execute(request, context);
    execute.mockClear();
    const second = await service.execute(request, context);
    expect(first.outcome).toBe("succeeded");
    expect(second.outcome).toBe("succeeded");
    expect(isReplayedAndroidEvidence(second)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps completed input evidence scoped and rejects changed or unauthorized replay", async () => {
    const execute = discoveryExecutor();
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => ids.action,
    });
    await service.discover(discoveryRequest, context);
    const request = action("tap", { requestedBy: actor, point: { x: 1, y: 2 } });
    await service.execute(request, context);
    const other = { ...context, threadId: "30000000-0000-4000-8000-000000000099" as never };
    expect(service.snapshot(other).recentEvidence).toEqual([]);
    execute.mockClear();
    const forbidden = await service.execute(request, other);
    expect(forbidden.outcome).toBe("unauthorized");
    const changed = await service.execute({ ...request, point: { x: 3, y: 4 } }, context);
    expect(changed.outcome).toBe("unauthorized");
    const revoked = await service.execute(request, { ...context, executionPolicy: "plan" });
    expect(revoked.outcome).toBe("unauthorized");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a running action private and only lets its owner cancel it", async () => {
    const held = Promise.withResolvers<void>();
    const discovery = discoveryExecutor();
    let signalSeen: AbortSignal | undefined;
    const execute = vi.fn(
      async (input: { readonly argv: ReadonlyArray<string> }, signal?: AbortSignal) => {
        if (!input.argv.includes("tap")) return discovery(input);
        signalSeen = signal;
        await held.promise;
        return processResult("");
      },
    );
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => ids.action,
    });
    await service.discover(discoveryRequest, context);
    const request = action("tap", { requestedBy: actor, point: { x: 1, y: 2 } });
    const running = service.execute(request, context);
    try {
      await vi.waitFor(() => expect(signalSeen).toBeDefined());
      const other = { ...context, threadId: "30000000-0000-4000-8000-000000000099" as never };
      expect(service.snapshot(other).active).toEqual([]);
      const cancellation: ToolActionCancellation = {
        actionId: request.actionId,
        correlationId: request.correlationId,
        authority: request.authority,
        reason: "user-requested",
      };
      expect(await service.cancel(cancellation, other)).toBe(false);
      expect(signalSeen?.aborted).toBe(false);
      const duplicate = service.execute(request, context);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(execute.mock.calls.filter(([input]) => input.argv.includes("tap"))).toHaveLength(1);
      expect((await duplicate).outcome).toBe("unauthorized");
      expect(await service.cancel(cancellation, context)).toBe(true);
      expect(signalSeen?.aborted).toBe(true);
    } finally {
      held.resolve();
      await running;
    }
  });

  it("aborts the first frame capture when the service closes", async () => {
    const held = Promise.withResolvers<void>();
    const discovery = discoveryExecutor();
    let signalSeen: AbortSignal | undefined;
    const execute = async (
      input: { readonly argv: ReadonlyArray<string> },
      signal?: AbortSignal,
    ) => {
      if (!input.argv.includes("screencap")) return discovery(input);
      signalSeen = signal;
      await held.promise;
      return processResult("");
    };
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => ids.action,
    });
    await service.discover(discoveryRequest, context);
    const watching = service.watchScreen("Pixel_8_API_34", context, new AbortController().signal);
    try {
      await vi.waitFor(() => expect(signalSeen).toBeDefined());
      await service.close();
      expect(signalSeen?.aborted).toBe(true);
    } finally {
      held.resolve();
      await watching;
    }
  });

  it("captures only when a reader asks and stops polling after reader cancellation", async () => {
    vi.useFakeTimers();
    try {
      const discovery = discoveryExecutor();
      let captures = 0;
      const execute = vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
        if (!input.argv.includes("screencap")) return discovery(input);
        captures++;
        const png = new Uint8Array(24);
        png.set([0x89, 0x50, 0x4e, 0x47]);
        new DataView(png.buffer).setUint32(16, 100);
        new DataView(png.buffer).setUint32(20, 200);
        png[8] = captures;
        return { ...processResult(""), stdout: png };
      });
      const service = new AndroidToolchainService({
        execute,
        access: async () => undefined,
        environment: () => ({ ANDROID_HOME: "/sdk" }),
        writeArtifact: async () => undefined,
        readArtifact: async () => undefined,
        realpath: async (path: string) => path,
        now: () => "2026-09-20T20:00:00.000Z",
        newId: () => ids.action,
      });
      await service.discover(discoveryRequest, context);
      const watch = await service.watchScreen(
        "Pixel_8_API_34",
        context,
        new AbortController().signal,
      );
      if (watch.kind !== "watching") throw new Error("expected screen");
      await vi.advanceTimersByTimeAsync(4_000);
      expect(captures).toBe(1);
      const reader = watch.frames.getReader();
      await reader.read();
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(400);
      expect((await next).done).toBe(false);
      const beforeCancel = captures;
      await reader.cancel();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(captures).toBe(beforeCancel);
      await service.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
