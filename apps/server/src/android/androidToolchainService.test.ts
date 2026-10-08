import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
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
    | {
        kind: "watching";
        screen: { width: number; height: number };
        frames: ReadableStream<Uint8Array>;
      }
    | { kind: "unavailable"; message: string }
  >;
  close(): Promise<void>;
};

let AndroidToolchainService: ServiceConstructor;
let isReplayedAndroidEvidence: (value: unknown) => boolean;
let androidToolchainStorePaths: (
  environment: Readonly<Record<string, string | undefined>>,
) => ReadonlyArray<string>;

beforeAll(async () => {
  const path = "./androidToolchainService";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.AndroidToolchainService).toBeTypeOf("function");
  AndroidToolchainService = loaded!.AndroidToolchainService as ServiceConstructor;
  isReplayedAndroidEvidence = loaded!.isReplayedAndroidEvidence as typeof isReplayedAndroidEvidence;
  androidToolchainStorePaths = loaded!
    .androidToolchainStorePaths as typeof androidToolchainStorePaths;
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
    if (argv.includes("ro.boot.qemu.avd_name")) {
      return processResult("Pixel_8_API_34\n");
    }
    if (argv.includes("sys.boot_completed")) return processResult("1\n");
    if (argv.includes("input tap") || argv.includes("input swipe") || argv.includes("input text")) {
      return processResult("");
    }
    if (argv.includes("root") || argv.includes("reboot")) return processResult("");
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
  it("names the AVD store, and a configured ANDROID_AVD_HOME, as state confined commands may write", () => {
    expect(androidToolchainStorePaths({})).toEqual([join(homedir(), ".android")]);
    expect(androidToolchainStorePaths({ ANDROID_AVD_HOME: "/store/avds" })).toEqual([
      join(homedir(), ".android"),
      "/store/avds",
    ]);
    // An explicitly empty override is unset: forwarding "" would make the
    // confinement builder refuse every Android command, not just this one.
    expect(androidToolchainStorePaths({ ANDROID_AVD_HOME: "" })).toEqual([
      join(homedir(), ".android"),
    ]);
  });

  it("drops an empty ANDROID_AVD_HOME instead of forwarding it to toolchain commands", async () => {
    const environments: Array<Record<string, string>> = [];
    const base = discoveryExecutor();
    const service = new AndroidToolchainService({
      execute: vi.fn(
        async (input: {
          readonly argv: ReadonlyArray<string>;
          readonly environment: Record<string, string>;
        }) => {
          environments.push(input.environment);
          return base(input);
        },
      ),
      access: async () => undefined,
      realpath: async (path: string) => path,
      environment: () => ({ ANDROID_HOME: "/sdk", ANDROID_AVD_HOME: "" }),
      writeArtifact: async () => undefined,
      now: () => "2026-09-18T10:00:00.000Z",
      newId: () => ids.action,
    });
    try {
      await service.discover(discoveryRequest, context);
      expect(environments.length).toBeGreaterThan(0);
      expect(environments.every((env) => env.ANDROID_AVD_HOME === undefined)).toBe(true);
    } finally {
      await service.close();
    }
  });

  it("passes a configured ANDROID_AVD_HOME through to toolchain commands", async () => {
    const environments: Array<Record<string, string>> = [];
    const base = discoveryExecutor();
    const service = new AndroidToolchainService({
      execute: vi.fn(
        async (input: {
          readonly argv: ReadonlyArray<string>;
          readonly environment: Record<string, string>;
        }) => {
          environments.push(input.environment);
          return base(input);
        },
      ),
      access: async () => undefined,
      realpath: async (path: string) => path,
      environment: () => ({ ANDROID_HOME: "/sdk", ANDROID_AVD_HOME: "/store/avds" }),
      writeArtifact: async () => undefined,
      now: () => "2026-09-18T10:00:00.000Z",
      newId: () => ids.action,
    });
    try {
      await service.discover(discoveryRequest, context);
      expect(environments.length).toBeGreaterThan(0);
      expect(environments.every((env) => env.ANDROID_AVD_HOME === "/store/avds")).toBe(true);
    } finally {
      await service.close();
    }
  });

  it.each([false, true])(
    "keeps a newer empty discovery when an older listing finishes (initially populated: %s)",
    async (populated) => {
      const base = discoveryExecutor();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let hold = false;
      let removed = false;
      const execute = vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
        if (removed && input.argv.includes("-list-avds")) return processResult("");
        const result = await base(input);
        if (hold && input.argv.includes("devices")) {
          hold = false;
          await gate;
        }
        return result;
      });
      const service = new AndroidToolchainService({
        execute,
        access: async () => undefined,
        realpath: async (path: string) => path,
        environment: () => ({ ANDROID_HOME: "/sdk" }),
        writeArtifact: async () => undefined,
        now: () => "2026-09-18T10:00:00.000Z",
        newId: () => ids.action,
      });
      try {
        if (populated) await service.discover(discoveryRequest, context);
        hold = true;
        const pending = service.discover(discoveryRequest, context);
        await vi.waitFor(() => expect(hold).toBe(false));
        removed = true;
        expect(await service.discover(discoveryRequest, context)).toMatchObject({
          kind: "discovered",
          emulators: [],
        });
        release();
        expect(await pending).toMatchObject({ kind: "discovered", emulators: [] });
      } finally {
        release();
        await service.close();
      }
    },
  );

  it("does not let an older SDK failure clear a newer successful discovery", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const service = new AndroidToolchainService({
      execute: discoveryExecutor(),
      access: async () => {
        if (first) {
          first = false;
          await gate;
          throw new Error("missing");
        }
      },
      realpath: async (path: string) => path,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      now: () => "2026-09-18T10:00:00.000Z",
      newId: () => ids.action,
    });
    try {
      const pending = service.discover(discoveryRequest, context);
      await vi.waitFor(() => expect(first).toBe(false));
      const latest = await service.discover(discoveryRequest, context);
      expect(latest).toMatchObject({
        kind: "discovered",
        emulators: [{ emulatorId: "Pixel_8_API_34" }],
      });
      release();
      expect(await pending).toEqual(latest);
    } finally {
      release();
      await service.close();
    }
  });

  it("preserves a shutdown completed while discovery was reading stale devices", async () => {
    const base = discoveryExecutor();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    const execute = vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
      const result = await base(input);
      if (hold && input.argv.includes("devices")) await gate;
      return result;
    });
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      realpath: async (path: string) => path,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      now: () => "2026-09-18T10:00:00.000Z",
      newId: () => ids.action,
    });
    try {
      await service.discover(discoveryRequest, context);
      hold = true;
      const pending = service.discover(discoveryRequest, context);
      await vi.waitFor(() =>
        expect(execute.mock.calls.filter(([call]) => call.argv.includes("devices"))).toHaveLength(
          2,
        ),
      );
      expect((await service.execute(action("shutdown"), context)).outcome).toBe("succeeded");
      release();
      const discovered = await pending;
      expect(discovered.emulators[0]).toMatchObject({ state: "shutdown" });
      expect(discovered.emulators[0].serial).toBeUndefined();
    } finally {
      release();
      await service.close();
    }
  });

  it.each([
    "hello world",
    "it's quoted",
    "a; printf INJECTED",
    "$(printf INJECTED)",
    "`printf INJECTED`",
    "a\nb",
    '"quoted" & | < > \\',
  ])("keeps typed text literal when the device shell reparses it: %s", async (text) => {
    const execute = discoveryExecutor();
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      realpath: async (path: string) => path,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      now: () => "2026-09-18T10:00:00.000Z",
      newId: () => ids.action,
    });
    try {
      await service.discover(discoveryRequest, context);
      const result = await service.execute(action("type-text", { text, requestedBy: actor }), {
        ...context,
        inputGranted: true,
      });
      expect(result.outcome).toBe("succeeded");
      const argv = execute.mock.calls.find(([call]) => call.argv.includes("text"))?.[0].argv;
      expect(argv).toBeDefined();
      // Match adb's device-shell parsing; the fake input command only prints arguments.
      const command = argv?.slice(4).join(" ") ?? "";
      const received = execFileSync(
        "/bin/sh",
        ["-c", `input() { printf '%s\\0' "$@"; }; ${command}`],
        { encoding: "utf8" },
      );
      expect(received.split("\0")).toEqual(["text", text.replaceAll(" ", "%s"), ""]);
    } finally {
      await service.close();
    }
  });

  it("refuses discovery outside the requesting task authority before probing the SDK", async () => {
    const execute = discoveryExecutor();
    const access = vi.fn(async () => undefined);
    const service = new AndroidToolchainService({
      execute,
      access,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => ids.action,
    });
    const stranger = "30000000-0000-4000-8000-000000000099";
    for (const request of [
      { ...discoveryRequest, threadId: stranger as never },
      { ...discoveryRequest, checkoutId: stranger as never },
      { ...discoveryRequest, authority: { ...authority, hostId: stranger as never } },
      { ...discoveryRequest, authority: { ...authority, mode: "chat" as const } },
    ]) {
      expect(await service.discover(request, context)).toMatchObject({
        kind: "failure",
        failure: { category: "unauthorized" },
      });
    }
    expect(access).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

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
      if (argv.includes("ro.boot.qemu.avd_name")) return processResult("Pixel_8_API_34\n");
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
    for (let index = 0; index < 256; index += 1) {
      service.requestPaneOpen(
        { ...context, threadId: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}` },
        "Pixel_8_API_34",
      );
      if (index === 128) service.requestPaneOpen(context, "Pixel_8_API_34");
    }
    expect(service.snapshot(other).paneOpenRequest).toBeUndefined();
    expect(service.snapshot(context).paneOpenRequest).toBeDefined();
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

  it("waits for action cleanup and refuses new work after closing", async () => {
    const writing = Promise.withResolvers<void>();
    const finishWrite = Promise.withResolvers<void>();
    const execute = discoveryExecutor();
    const writeArtifact = vi.fn(async () => {
      writing.resolve();
      await finishWrite.promise;
    });
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => ids.action,
    });
    await service.discover(discoveryRequest, context);
    const request = action("tap", { requestedBy: actor, point: { x: 1, y: 2 } });
    const running = service.execute(request, context);
    await writing.promise;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      execute.mockClear();
      expect((await service.execute(request, context)).outcome).toBe("unavailable");
      expect(execute).not.toHaveBeenCalled();
      expect(writeArtifact).toHaveBeenCalledTimes(1);
    } finally {
      finishWrite.resolve();
      await running;
      await closing;
    }
    expect(service.snapshot(context).active).toEqual([]);
  });

  it("waits for the cancelled first capture to exit before closing", async () => {
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
      let closed = false;
      const closing = service.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signalSeen?.aborted).toBe(true);
      expect(closed).toBe(false);
      held.resolve();
      await closing;
      expect(closed).toBe(true);
      expect(await service.discover(discoveryRequest, context)).toMatchObject({
        kind: "failure",
        failure: { category: "unavailable" },
      });
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

  it("shows a managed JPEG stream for a booted emulator and does not screencap", async () => {
    const execute = discoveryExecutor();
    const jpeg = Uint8Array.of(0xff, 0xd8, 0x11, 0xff, 0xd9);
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => ids.action,
      serveAvd: {
        open: async () => ({
          origin: "http://127.0.0.1:9",
          streamUrl: "http://127.0.0.1:9/helper/emulator-5554/stream.mjpeg",
        }),
      },
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) {
          return new Response(JSON.stringify({ width: 1080, height: 1920 }));
        }
        if (url.endsWith("/stream.mjpeg")) return new Response(jpeg);
        return new Response("no", { status: 404 });
      },
    });
    await service.discover(discoveryRequest, context);
    execute.mockClear();
    const watch = await service.watchScreen(
      "Pixel_8_API_34",
      context,
      new AbortController().signal,
    );
    if (watch.kind !== "watching") throw new Error("expected a managed stream");
    expect(watch.screen).toEqual({ width: 1080, height: 1920 });
    const reader = watch.frames.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    if (chunk.done) return;
    const length = new DataView(chunk.value.buffer, chunk.value.byteOffset, 4).getUint32(0);
    expect(chunk.value.slice(4, 4 + length)).toEqual(jpeg);
    expect(execute).not.toHaveBeenCalled();
    await reader.cancel();
    await service.close();
  });

  it("falls back to screencap when the managed stream is absent", async () => {
    const discovery = discoveryExecutor();
    let captures = 0;
    const execute = vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
      if (!input.argv.includes("screencap")) return discovery(input);
      captures += 1;
      const png = new Uint8Array(24);
      png.set([0x89, 0x50, 0x4e, 0x47]);
      new DataView(png.buffer).setUint32(16, 100);
      new DataView(png.buffer).setUint32(20, 200);
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
      serveAvd: { open: async () => undefined },
    });
    await service.discover(discoveryRequest, context);
    const watch = await service.watchScreen(
      "Pixel_8_API_34",
      context,
      new AbortController().signal,
    );
    expect(watch.kind).toBe("watching");
    expect(captures).toBe(1);
    if (watch.kind === "watching") await watch.frames.cancel();
    await service.close();
  });

  it("sends a tap through the managed emulator and does not also send adb", async () => {
    const execute = discoveryExecutor();
    const actions: unknown[] = [];
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => ids.action,
      serveAvd: {
        open: async () => ({
          origin: "http://127.0.0.1:9",
          streamUrl: "http://127.0.0.1:9/helper/emulator-5554/stream.mjpeg",
        }),
      },
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/config")) {
          return new Response(JSON.stringify({ width: 1080, height: 1920 }));
        }
        if (url.endsWith("/action")) {
          actions.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response("no", { status: 404 });
      },
    });
    await service.discover(discoveryRequest, context);
    execute.mockClear();
    const evidence = await service.execute(
      action("tap", { point: { x: 540, y: 960 }, requestedBy: actor }),
      context,
    );
    expect(evidence.outcome).toBe("succeeded");
    expect(actions).toEqual([{ action: "tap", x: 0.5, y: 0.5 }]);
    expect(execute).not.toHaveBeenCalled();
    await service.close();
  });

  it("does not send adb when the managed emulator refuses the tap", async () => {
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
      serveAvd: {
        open: async () => ({
          origin: "http://127.0.0.1:9",
          streamUrl: "http://127.0.0.1:9/helper/emulator-5554/stream.mjpeg",
        }),
      },
      fetchImpl: async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/config")) {
          return new Response(JSON.stringify({ width: 100, height: 200 }));
        }
        return new Response(JSON.stringify({ ok: false, error: "failed" }), { status: 500 });
      },
    });
    await service.discover(discoveryRequest, context);
    execute.mockClear();
    const evidence = await service.execute(
      action("tap", { point: { x: 1, y: 1 }, requestedBy: actor }),
      context,
    );
    expect(evidence.outcome).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
    await service.close();
  });

  it("sends an unmapped key through adb once", async () => {
    const execute = discoveryExecutor();
    const opened: string[] = [];
    const service = new AndroidToolchainService({
      execute,
      access: async () => undefined,
      environment: () => ({ ANDROID_HOME: "/sdk" }),
      writeArtifact: async () => undefined,
      readArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-09-20T20:00:00.000Z",
      newId: () => ids.action,
      serveAvd: {
        open: async (serial: string) => {
          opened.push(serial);
          return {
            origin: "http://127.0.0.1:9",
            streamUrl: "http://127.0.0.1:9/helper/emulator-5554/stream.mjpeg",
          };
        },
      },
    });
    await service.discover(discoveryRequest, context);
    execute.mockClear();
    const evidence = await service.execute(
      action("key-press", { key: "space", requestedBy: actor }),
      context,
    );
    expect(evidence.outcome).toBe("succeeded");
    expect(opened).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].argv).toContain("KEYCODE_SPACE");
    await service.close();
  });

  it("keeps one adb server alive across ten pane inputs", async () => {
    // The fake models the shared adb server: the first client that finds none
    // starts it with that client's environment, and a server started with mDNS
    // discovery on aborts before the next command, as adb 37 does on macOS 27.
    let server: { readonly pid: number; readonly crashes: boolean } | undefined;
    let nextPid = 4_000;
    const serverPids: number[] = [];
    const base = discoveryExecutor();
    const execute = vi.fn(
      async (input: {
        readonly argv: ReadonlyArray<string>;
        readonly environment: Record<string, string>;
      }) => {
        if (input.argv[0]?.endsWith("/adb")) {
          if (server === undefined || server.crashes) {
            nextPid += 1;
            server = { pid: nextPid, crashes: input.environment.ADB_MDNS !== "0" };
          }
          if (input.argv.includes("input")) serverPids.push(server.pid);
        }
        return base(input);
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
    try {
      await service.discover(discoveryRequest, context);
      const inputs: ReadonlyArray<Record<string, unknown>> = [
        { kind: "tap", point: { x: 40, y: 80 } },
        { kind: "swipe", point: { x: 40, y: 800 }, toPoint: { x: 40, y: 200 } },
        { kind: "key-press", key: "home" },
        { kind: "type-text", text: "hello" },
        { kind: "key-press", key: "back" },
        { kind: "tap", point: { x: 120, y: 300 } },
        { kind: "type-text", text: "world" },
        { kind: "swipe", point: { x: 500, y: 900 }, toPoint: { x: 100, y: 900 } },
        { kind: "key-press", key: "enter" },
        { kind: "tap", point: { x: 10, y: 10 } },
      ];
      for (const [index, { kind, ...extra }] of inputs.entries()) {
        const evidence = await service.execute(
          action(kind as AndroidEmulatorRequest["kind"], {
            ...extra,
            requestedBy: actor,
            actionId: `30000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
          }),
          context,
        );
        expect(evidence.outcome).toBe("succeeded");
      }
      expect(serverPids).toHaveLength(10);
      expect(new Set(serverPids).size).toBe(1);
    } finally {
      await service.close();
    }
  });

  it("reports typed text as interrupted, not failed, when adb loses its server after handing it over", async () => {
    let stderr = "";
    const base = discoveryExecutor();
    const execute = vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
      if (!input.argv.includes("text")) return base(input);
      return {
        termination: "exited" as const,
        exitCode: 255,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(stderr),
        cleanupUncertain: false,
      };
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
    try {
      await service.discover(discoveryRequest, context);
      stderr = "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n";
      const lost = await service.execute(
        action("type-text", {
          text: "hello",
          requestedBy: actor,
          actionId: "30000000-0000-4000-8000-000000000201",
        }),
        context,
      );
      expect(lost.outcome).toBe("interrupted");
      expect(JSON.stringify(lost.diagnostics)).toContain("may have reached the emulator");
      expect(JSON.stringify(lost.diagnostics)).not.toContain("hello");

      // A client that never reached the device says so, and that is a failure.
      stderr = "adb: device offline\n";
      const refused = await service.execute(
        action("type-text", {
          text: "hello",
          requestedBy: actor,
          actionId: "30000000-0000-4000-8000-000000000202",
        }),
        context,
      );
      expect(refused.outcome).toBe("failed");
    } finally {
      await service.close();
    }
  });

  it.runIf(process.platform === "darwin")(
    "finds a Homebrew command-line-tools SDK when no SDK variable is set",
    async () => {
      const sdk = "/opt/homebrew/share/android-commandlinetools";
      const service = new AndroidToolchainService({
        execute: discoveryExecutor(),
        access: async (path: string) => {
          if (!path.startsWith(`${sdk}/`)) throw new Error("ENOENT");
        },
        environment: () => ({}),
        writeArtifact: async () => undefined,
        readArtifact: async () => undefined,
        realpath: async (path: string) => path,
        now: () => "2026-09-20T20:00:00.000Z",
        newId: () => ids.action,
      });
      try {
        const result = await service.discover(discoveryRequest, context);
        expect(result.kind).toBe("discovered");
        if (result.kind !== "discovered") return;
        expect(result.sdk).toMatchObject({
          available: true,
          sdkRoot: sdk,
          adbPath: `${sdk}/platform-tools/adb`,
        });
      } finally {
        await service.close();
      }
    },
  );
});
