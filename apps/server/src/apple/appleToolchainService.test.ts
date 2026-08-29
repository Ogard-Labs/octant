import type {
  AppleBuildRequest,
  AppleDiscoveryRequest,
  AppleSimulatorRequest,
  ToolActionAuthority,
  ToolActionCancellation,
} from "@octant/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

type ServiceConstructor = new (options: Record<string, unknown>) => {
  discover(request: AppleDiscoveryRequest, context: ExecutionContext): Promise<any>;
  execute(
    request: AppleBuildRequest | AppleSimulatorRequest,
    context: ExecutionContext,
  ): Promise<any>;
  cancel(request: ToolActionCancellation, context: ExecutionContext): Promise<boolean>;
  snapshot(context: ExecutionContext): any;
  close(): Promise<void>;
  reconcileAfterRestart(
    receipts: ReadonlyArray<Record<string, unknown>>,
    context: ExecutionContext,
  ): Promise<ReadonlyArray<any>>;
  readScreenshotArtifact(
    reference: string,
    context: ExecutionContext,
  ): Promise<
    | { readonly kind: "found"; readonly bytes: Uint8Array }
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "unauthorized"; readonly message: string }
  >;
};

let AppleToolchainService: ServiceConstructor;

beforeAll(async () => {
  const path = "./appleToolchainService";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.AppleToolchainService).toBeTypeOf("function");
  AppleToolchainService = loaded!.AppleToolchainService as ServiceConstructor;
});

const ids = {
  action: "30000000-0000-4000-8000-000000000001",
  correlation: "30000000-0000-4000-8000-000000000002",
  host: "30000000-0000-4000-8000-000000000003",
  project: "30000000-0000-4000-8000-000000000004",
  root: "30000000-0000-4000-8000-000000000005",
  worktree: "30000000-0000-4000-8000-000000000006",
  provider: "30000000-0000-4000-8000-000000000007",
  thread: "30000000-0000-4000-8000-000000000008",
  checkout: "30000000-0000-4000-8000-000000000009",
  simulator: "30000000-0000-4000-8000-000000000010",
  approval: "30000000-0000-4000-8000-000000000011",
} as const;

const authority: ToolActionAuthority = {
  hostId: ids.host as never,
  mode: "code",
  projectId: ids.project as never,
  rootId: ids.root as never,
  worktreeId: ids.worktree as never,
  providerInstanceId: ids.provider as never,
  extension: { kind: "core" },
};

interface ExecutionContext {
  readonly authority: ToolActionAuthority;
  readonly threadId: any;
  readonly checkoutId: any;
  readonly checkoutRoot: string;
  readonly artifactRoot: string;
  readonly sourceRevision: string;
  readonly executionPolicy: "plan" | "approval-gated" | "full-access";
  readonly approvalValid: boolean;
}

const context: ExecutionContext = {
  authority,
  threadId: ids.thread,
  checkoutId: ids.checkout,
  checkoutRoot: "/private/octant-fixture",
  artifactRoot: "/private/octant-artifacts",
  sourceRevision: "a".repeat(40),
  executionPolicy: "full-access",
  approvalValid: true,
};

const discoveryRequest: AppleDiscoveryRequest = {
  actionId: ids.action as never,
  correlationId: ids.correlation as never,
  authority,
  threadId: ids.thread as never,
  checkoutId: ids.checkout as never,
  projectPath: "Fixture/Fixture.xcodeproj",
};

function buildRequest(overrides: Partial<AppleBuildRequest> = {}): AppleBuildRequest {
  return {
    ...discoveryRequest,
    kind: "build",
    platform: "ios",
    scheme: "Fixture",
    configuration: "debug",
    simulatorId: ids.simulator as never,
    timeoutMs: 120_000,
    approval: { kind: "approved", approvalId: ids.approval as never },
    ...overrides,
  };
}

function simulatorRequest(overrides: Partial<AppleSimulatorRequest> = {}): AppleSimulatorRequest {
  return {
    actionId: ids.action as never,
    correlationId: ids.correlation as never,
    authority,
    threadId: ids.thread as never,
    checkoutId: ids.checkout as never,
    kind: "logs",
    simulatorId: ids.simulator as never,
    bundleIdentifier: "app.octant.fixture",
    timeoutMs: 30_000,
    approval: { kind: "not-required" },
    ...overrides,
  };
}

function processResult(
  stdout = "",
  options: {
    readonly stderr?: string;
    readonly exitCode?: number | null;
    readonly termination?: "exited" | "cancelled" | "timed-out" | "unavailable";
    readonly cleanupUncertain?: boolean;
  } = {},
) {
  return {
    termination: options.termination ?? "exited",
    exitCode: options.exitCode === undefined ? 0 : options.exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(options.stderr ?? ""),
    parserFailed: false,
    cleanupUncertain: options.cleanupUncertain ?? false,
  } as const;
}

function discoveryExecutor() {
  return vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
    const command = input.argv.join(" ");
    if (command === "xcode-select -p") {
      return processResult("/Applications/Xcode.app/Contents/Developer\n");
    }
    if (command === "xcodebuild -version") return processResult("Xcode 16.4\nBuild version 16F6\n");
    if (command === "swift --version") return processResult("Apple Swift version 6.1\n");
    if (command === "xcodebuild -showsdks") {
      return processResult(
        "iOS Simulator 18.5 -sdk iphonesimulator18.5\nmacOS 15.5 -sdk macosx15.5\n",
      );
    }
    if (command === "xcrun simctl list devices available --json") {
      return processResult(
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
              {
                name: "iPhone 16",
                udid: ids.simulator,
                state: "Booted",
                isAvailable: true,
              },
            ],
          },
        }),
      );
    }
    if (command.includes("-list -json")) {
      return processResult(
        JSON.stringify({
          project: {
            schemes: ["Fixture"],
            configurations: ["Debug", "Release"],
            targets: ["Fixture", "FixtureTests"],
          },
        }),
      );
    }
    return processResult("", { exitCode: 1, stderr: `unexpected command: ${command}` });
  });
}

describe("AppleToolchainService discovery", () => {
  it("discovers Xcode, SDKs, project metadata, and available Simulators truthfully", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });

    const result = await service.discover(discoveryRequest, context);

    expect(result.kind).toBe("discovered");
    expect(result.toolchain).toMatchObject({ available: true, xcodeVersion: "16.4" });
    expect(result.toolchain.sdks).toEqual(
      expect.arrayContaining([expect.objectContaining({ canonicalName: "iphonesimulator18.5" })]),
    );
    expect(result.workspace).toMatchObject({
      schemes: ["Fixture"],
      targets: ["Fixture", "FixtureTests"],
    });
    expect(result.simulators).toEqual([
      expect.objectContaining({ simulatorId: ids.simulator, state: "booted", platform: "ios" }),
    ]);
    expect(JSON.stringify(result.workspace)).not.toContain(context.checkoutRoot);
  });

  it("fails closed before discovery when thread authority does not match", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    const result = await service.discover(discoveryRequest, {
      ...context,
      threadId: "40000000-0000-4000-8000-000000000001",
    });
    expect(result).toMatchObject({ kind: "failure", failure: { category: "unauthorized" } });
    expect(JSON.stringify(result)).not.toContain(context.checkoutRoot);
    expect(execute).not.toHaveBeenCalled();
  });

  it("denies extension-owned authority while core Apple discovery, build, and evidence stay core-only", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    // A trusted extension (for example an installed Build iOS Apps plugin) can
    // never own the core Apple capability: discovery and actions fail closed.
    const extensionAuthority: ToolActionAuthority = {
      ...authority,
      extension: {
        kind: "trusted-extension",
        extensionId: "30000000-0000-4000-8000-000000000020" as never,
      },
    };
    const extensionContext: ExecutionContext = { ...context, authority: extensionAuthority };

    const discovery = await service.discover(
      { ...discoveryRequest, authority: extensionAuthority },
      extensionContext,
    );
    expect(discovery).toMatchObject({ kind: "failure", failure: { category: "unauthorized" } });

    const build = await service.execute(
      buildRequest({ authority: extensionAuthority }),
      extensionContext,
    );
    expect(build.outcome).toBe("unauthorized");
    expect(build.authority.extension.kind).toBe("trusted-extension");
    expect(JSON.stringify(build)).toContain("core-capability-required");
    expect(execute).not.toHaveBeenCalled();

    // The same service instance keeps serving the core path with core
    // authority; an absent or disabled extension changes nothing.
    const core = await service.discover(discoveryRequest, context);
    expect(core.kind).toBe("discovered");
    expect(execute).toHaveBeenCalled();
  });

  it("reports unavailable Xcode without attempting project discovery", async () => {
    const execute = vi.fn(async () => processResult("", { exitCode: 1 }));
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });

    await expect(service.discover(discoveryRequest, context)).resolves.toEqual({
      kind: "failure",
      failure: { category: "xcode-not-found", message: "Xcode is unavailable on this host." },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("AppleToolchainService lifecycle", () => {
  it("scopes recent evidence to the requesting thread and checkout", async () => {
    const service = new AppleToolchainService({
      execute: vi.fn(),
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    const firstContext = { ...context, executionPolicy: "plan" as const };
    const secondContext = {
      ...firstContext,
      threadId: "30000000-0000-4000-8000-000000000013",
      checkoutId: "30000000-0000-4000-8000-000000000014",
    };
    await service.execute(buildRequest(), firstContext);
    await service.execute(
      buildRequest({
        actionId: "30000000-0000-4000-8000-000000000015" as never,
        correlationId: "30000000-0000-4000-8000-000000000016" as never,
        threadId: secondContext.threadId as never,
        checkoutId: secondContext.checkoutId as never,
      }),
      secondContext,
    );

    expect(
      service.snapshot(firstContext).recentEvidence.map(({ actionId }: any) => actionId),
    ).toEqual([ids.action]);
  });

  it("builds, installs, launches, and records normalized progress/evidence", async () => {
    const execute = discoveryExecutor();
    execute.mockImplementation(async (input: { readonly argv: ReadonlyArray<string> }) => {
      const command = input.argv.join(" ");
      const discovered = await discoveryExecutor()(input);
      if (!String(new TextDecoder().decode(discovered.stderr)).startsWith("unexpected"))
        return discovered;
      if (command.includes("-showBuildSettings -json")) {
        return processResult(
          JSON.stringify([
            {
              buildSettings: {
                TARGET_BUILD_DIR:
                  "/private/octant-artifacts/DerivedData/Build/Products/Debug-iphonesimulator",
                WRAPPER_NAME: "Fixture.app",
                PRODUCT_BUNDLE_IDENTIFIER: "app.octant.fixture",
              },
            },
          ]),
        );
      }
      if (command.startsWith("xcrun simctl bootstatus ")) return processResult("booted\n");
      if (
        command.startsWith("xcodebuild ") ||
        command.startsWith("xcrun simctl install ") ||
        command.startsWith("xcrun simctl launch ")
      ) {
        return processResult("ok\n");
      }
      return discovered;
    });
    const writeArtifact = vi.fn(async () => undefined);
    const persistedReceipts: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> = [];
    const service = new AppleToolchainService({
      execute,
      writeArtifact,
      persistReceipts: async (receipts: ReadonlyArray<Record<string, unknown>>) => {
        (persistedReceipts as Array<ReadonlyArray<Record<string, unknown>>>).push(receipts);
      },
      realpath: async (path: string) => path,
      now: (() => {
        let second = 0;
        return () => `2026-07-27T20:00:${String(second++).padStart(2, "0")}.000Z`;
      })(),
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const evidence = await service.execute(buildRequest({ kind: "run" }), context);

    expect(evidence).toMatchObject({
      kind: "run",
      outcome: "succeeded",
      simulatorId: ids.simulator,
      cleanup: "complete",
    });
    expect(execute.mock.calls.map(([input]) => input.argv.join(" ")).join("\n")).toContain(
      `xcrun simctl launch --terminate-running-process ${ids.simulator} app.octant.fixture`,
    );
    expect(service.snapshot(context).recentEvidence).toContainEqual(evidence);
    expect(service.snapshot(context).active).toEqual([]);
    expect(writeArtifact).toHaveBeenCalled();
    expect(persistedReceipts).toContainEqual([
      expect.objectContaining({
        kind: "run",
        bundleIdentifier: "app.octant.fixture",
      }),
    ]);
  });

  it("maps cancellation, timeout, process death, and cleanup uncertainty distinctly", async () => {
    const cases = [
      ["cancelled", "cancelled", false],
      ["timed-out", "timed-out", false],
      ["exited", "process-died", false],
      ["timed-out", "interrupted", true],
    ] as const;
    for (const [termination, outcome, cleanupUncertain] of cases) {
      const execute = discoveryExecutor();
      const service = new AppleToolchainService({
        execute,
        realpath: async (path: string) => path,
        now: () => "2026-07-27T20:00:00.000Z",
        newId: () => "30000000-0000-4000-8000-000000000012",
      });
      await service.discover(discoveryRequest, context);
      execute.mockResolvedValue(
        processResult("", {
          termination,
          exitCode: termination === "exited" ? null : 1,
          cleanupUncertain,
        }),
      );
      const evidence = await service.execute(buildRequest(), context);
      expect(evidence.outcome).toBe(outcome);
      expect(evidence.cleanup).toBe(cleanupUncertain ? "uncertain" : "complete");
    }
  });

  it("keeps an ordinary failed build distinct from process death", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    execute.mockResolvedValue(processResult("", { exitCode: 65, stderr: "build failed" }));

    await expect(service.execute(buildRequest(), context)).resolves.toMatchObject({
      outcome: "failed",
      cleanup: "complete",
    });
  });

  it("cancels only the exactly owned active action", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    execute.mockImplementation(
      async (_input: unknown, signal?: AbortSignal) =>
        await new Promise((resolve) => {
          if (signal?.aborted) {
            resolve(processResult("", { termination: "cancelled", exitCode: null }));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => resolve(processResult("", { termination: "cancelled", exitCode: null })),
            { once: true },
          );
        }),
    );
    const running = service.execute(buildRequest(), context);
    await vi.waitFor(() => expect(service.snapshot(context).active).toHaveLength(1));
    const cancellation: ToolActionCancellation = {
      actionId: ids.action as never,
      correlationId: ids.correlation as never,
      authority,
      reason: "user-requested",
    };
    await expect(service.cancel(cancellation, context)).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ outcome: "cancelled" });
    await expect(
      service.cancel(cancellation, {
        ...context,
        threadId: "40000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toBe(false);
  });

  it("aborts owned actions and waits for their process cleanup before closing", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    let releaseCleanup: (() => void) | undefined;
    let abortObserved = false;
    execute.mockImplementation(
      async (_input: unknown, signal?: AbortSignal) =>
        await new Promise((resolve) => {
          if (signal?.aborted) {
            abortObserved = true;
            releaseCleanup = () =>
              resolve(processResult("", { termination: "cancelled", exitCode: null }));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              releaseCleanup = () =>
                resolve(processResult("", { termination: "cancelled", exitCode: null }));
            },
            { once: true },
          );
        }),
    );
    const running = service.execute(buildRequest(), context);
    await vi.waitFor(() => expect(service.snapshot(context).active).toHaveLength(1));

    let closeResolved = false;
    const closing = service.close().then(() => {
      closeResolved = true;
    });
    await vi.waitFor(() => expect(abortObserved).toBe(true));
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    releaseCleanup?.();
    await expect(running).resolves.toMatchObject({ outcome: "cancelled", cleanup: "complete" });
    await expect(closing).resolves.toBeUndefined();
    expect(service.snapshot(context).active).toEqual([]);
  });

  it("serializes active receipt persistence across overlapping actions", async () => {
    const execute = discoveryExecutor();
    let releasePersistence: (() => void) | undefined;
    let persistenceCalls = 0;
    let concurrentPersistence = 0;
    let maximumConcurrentPersistence = 0;
    const service = new AppleToolchainService({
      execute,
      persistReceipts: async () => {
        persistenceCalls += 1;
        concurrentPersistence += 1;
        maximumConcurrentPersistence = Math.max(
          maximumConcurrentPersistence,
          concurrentPersistence,
        );
        if (persistenceCalls === 1) {
          await new Promise<void>((resolve) => {
            releasePersistence = resolve;
          });
        }
        concurrentPersistence -= 1;
      },
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);

    const first = service.execute(buildRequest(), context);
    const second = service.execute(
      buildRequest({
        actionId: "30000000-0000-4000-8000-000000000013" as never,
        correlationId: "30000000-0000-4000-8000-000000000014" as never,
      }),
      context,
    );
    await vi.waitFor(() => expect(service.snapshot(context).active).toHaveLength(2));
    await Promise.resolve();
    expect(maximumConcurrentPersistence).toBe(1);
    releasePersistence?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(service.snapshot(context).active).toEqual([]);
  });

  it("reconciles a stale launched app as interrupted and performs scoped cleanup", async () => {
    const execute = vi.fn(async () => processResult("ok\n"));
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    const evidence = await service.reconcileAfterRestart(
      [
        {
          actionId: ids.action,
          correlationId: ids.correlation,
          authority,
          threadId: ids.thread,
          checkoutId: ids.checkout,
          kind: "run",
          simulatorId: ids.simulator,
          bundleIdentifier: "app.octant.fixture",
          startedAt: "2026-07-27T19:59:00.000Z",
        },
      ],
      context,
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["xcrun", "simctl", "terminate", ids.simulator, "app.octant.fixture"],
      }),
      undefined,
    );
    expect(evidence).toEqual([
      expect.objectContaining({ outcome: "interrupted", cleanup: "complete" }),
    ]);
  });

  it("collects bounded logs without leaking project or artifact paths", async () => {
    const execute = discoveryExecutor();
    const writeArtifact = vi.fn(async () => undefined);
    const service = new AppleToolchainService({
      execute,
      writeArtifact,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    execute.mockResolvedValue(
      processResult(`${context.checkoutRoot}/secret.swift:2:1: error: boom\n`),
    );
    const evidence = await service.execute(simulatorRequest(), context);
    expect(evidence.outcome).toBe("succeeded");
    expect(evidence.diagnostics).toEqual([
      expect.objectContaining({ message: "boom", location: "[PROJECT]/secret.swift:2:1" }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain(context.checkoutRoot);
    expect(writeArtifact).toHaveBeenCalledWith(
      expect.stringMatching(/^apple-log-/),
      expect.any(Uint8Array),
    );
  });

  it("reconciles the shared Simulator state after owned boot and shutdown", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const cached = service.snapshot(context).simulators[0];
    expect(cached?.state).toBe("booted");
    execute.mockResolvedValue(processResult("ok\n"));
    await service.execute(
      simulatorRequest({ kind: "shutdown", approval: buildRequest().approval }),
      context,
    );
    expect(service.snapshot(context).simulators[0]?.state).toBe("shutdown");
  });

  it("captures the Simulator screen as its own evidence artifact, keeping the log readable", async () => {
    const execute = discoveryExecutor();
    const artifacts = new Map<string, Uint8Array>();
    const writeArtifact = vi.fn(async (reference: string, bytes: Uint8Array) => {
      artifacts.set(reference, bytes);
    });
    const service = new AppleToolchainService({
      execute,
      writeArtifact,
      readArtifact: async (reference: string) => artifacts.get(reference),
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    execute.mockResolvedValue({
      termination: "exited" as const,
      exitCode: 0,
      stdout: png,
      stderr: new TextEncoder().encode(""),
      parserFailed: false,
      cleanupUncertain: false,
    });

    const evidence = await service.execute(
      simulatorRequest({ kind: "screenshot", bundleIdentifier: undefined }),
      context,
    );

    expect(evidence.outcome).toBe("succeeded");
    expect(evidence.kind).toBe("screenshot");
    const screenshot = evidence.artifacts.find(
      (artifact: { readonly kind: string }) => artifact.kind === "screenshot",
    );
    expect(screenshot).toBeDefined();
    expect(artifacts.get(screenshot!.reference)).toEqual(png);
    const command = execute.mock.calls.at(-1)?.[0] as { readonly argv: ReadonlyArray<string> };
    expect(command.argv).toEqual([
      "xcrun",
      "simctl",
      "io",
      ids.simulator,
      "screenshot",
      "--type",
      "png",
      "-",
    ]);
    // The screen is bytes, not text: putting it in the log would make the log
    // unreadable and would say nothing a reader could act on.
    const log = evidence.artifacts.find(
      (artifact: { readonly kind: string }) => artifact.kind === "log",
    );
    expect(artifacts.get(log!.reference)).toEqual(new Uint8Array());

    const readBack = await service.readScreenshotArtifact(screenshot!.reference, context);
    expect(readBack).toEqual({ kind: "found", bytes: png });
    await expect(
      service.readScreenshotArtifact("apple-screenshot-other", context),
    ).resolves.toEqual({
      kind: "unauthorized",
      message: "Apple screenshot evidence is not available for this thread.",
    });
  });

  it("records a failed capture without inventing a screenshot artifact", async () => {
    const execute = discoveryExecutor();
    const writeArtifact = vi.fn(async () => undefined);
    const service = new AppleToolchainService({
      execute,
      writeArtifact,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    execute.mockResolvedValue(processResult("", { exitCode: 1, stderr: "Invalid device state\n" }));

    const evidence = await service.execute(
      simulatorRequest({ kind: "screenshot", bundleIdentifier: undefined }),
      context,
    );

    expect(evidence.outcome).toBe("failed");
    expect(evidence.artifacts.map((artifact: { readonly kind: string }) => artifact.kind)).toEqual([
      "log",
    ]);
  });
});

describe("AppleToolchainService Simulator input", () => {
  const actor = {
    kind: "local-user" as const,
    actorId: "30000000-0000-4000-8000-000000000099" as never,
  };

  it("injects tap through the workbench channel and never re-runs a finished actionId", async () => {
    const execute = discoveryExecutor();
    const injectSimulatorInput = vi.fn(async () => processResult("ok\n"));
    const service = new AppleToolchainService({
      execute,
      injectSimulatorInput,
      writeArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const request = simulatorRequest({
      kind: "tap",
      bundleIdentifier: undefined,
      requestedBy: actor,
      point: { x: 10, y: 20 },
      approval: { kind: "approved", approvalId: ids.approval as never },
    });
    const first = await service.execute(request, context);
    expect(first.outcome).toBe("succeeded");
    expect(first.requestedBy).toEqual(actor);
    expect(injectSimulatorInput).toHaveBeenCalledTimes(1);

    const second = await service.execute(request, context);
    expect(second).toEqual(first);
    expect(injectSimulatorInput).toHaveBeenCalledTimes(1);
  });

  it("refuses to re-inject interrupted input under the same actionId", async () => {
    const execute = discoveryExecutor();
    const injectSimulatorInput = vi.fn(async () =>
      processResult("", { cleanupUncertain: true, termination: "exited", exitCode: 0 }),
    );
    const service = new AppleToolchainService({
      execute,
      injectSimulatorInput,
      writeArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const request = simulatorRequest({
      kind: "key-press",
      bundleIdentifier: undefined,
      requestedBy: actor,
      key: "return",
      approval: { kind: "approved", approvalId: ids.approval as never },
    });
    const first = await service.execute(request, context);
    expect(first.outcome).toBe("interrupted");
    const second = await service.execute(request, context);
    expect(second.outcome).toBe("interrupted");
    expect(JSON.stringify(second.diagnostics)).toContain("Issue a new actionId");
    expect(injectSimulatorInput).toHaveBeenCalledTimes(1);
  });

  it("never stores typed text in diagnostics or log artifacts", async () => {
    const execute = discoveryExecutor();
    const artifacts = new Map<string, Uint8Array>();
    const secret = "hunter2-should-not-persist";
    const service = new AppleToolchainService({
      execute,
      injectSimulatorInput: async () => processResult(`echoed:${secret}\n`),
      writeArtifact: async (reference: string, bytes: Uint8Array) => {
        artifacts.set(reference, bytes);
      },
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const evidence = await service.execute(
      simulatorRequest({
        kind: "type-text",
        bundleIdentifier: undefined,
        requestedBy: actor,
        text: secret,
        approval: { kind: "approved", approvalId: ids.approval as never },
      }),
      context,
    );
    expect(evidence.outcome).toBe("succeeded");
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(evidence.diagnostics[0]?.message).toContain("redacted");
    for (const bytes of artifacts.values()) {
      expect(new TextDecoder().decode(bytes)).not.toContain(secret);
    }
  });

  it("reports unavailable input honestly off Darwin when no injector is configured", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      platform: "linux",
      writeArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const evidence = await service.execute(
      simulatorRequest({
        kind: "tap",
        bundleIdentifier: undefined,
        requestedBy: actor,
        point: { x: 1, y: 2 },
        approval: { kind: "approved", approvalId: ids.approval as never },
      }),
      context,
    );
    expect(evidence.outcome).toBe("unavailable");
    expect(evidence.diagnostics[0]?.message).toContain("unavailable");
    expect(evidence.diagnostics[0]?.message).toContain("Open the thread on the Mac");
  });

  it("refuses Darwin coordinate taps without a reviewed injector or semantic target", async () => {
    const execute = discoveryExecutor();
    const service = new AppleToolchainService({
      execute,
      platform: "darwin",
      writeArtifact: async () => undefined,
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    await service.discover(discoveryRequest, context);
    const evidence = await service.execute(
      simulatorRequest({
        kind: "tap",
        bundleIdentifier: undefined,
        requestedBy: actor,
        point: { x: 10, y: 20 },
        approval: { kind: "approved", approvalId: ids.approval as never },
      }),
      context,
    );
    expect(evidence.outcome).toBe("unavailable");
    expect(JSON.stringify(evidence.diagnostics)).toContain("Coordinate taps require");
    expect(execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ argv: expect.arrayContaining(["osascript"]) }),
      expect.anything(),
    );
  });

  it("reconciles an interrupted type-text receipt with requestedBy after restart", async () => {
    const service = new AppleToolchainService({
      execute: discoveryExecutor(),
      realpath: async (path: string) => path,
      now: () => "2026-07-27T20:00:00.000Z",
      newId: () => "30000000-0000-4000-8000-000000000012",
    });
    const evidence = await service.reconcileAfterRestart(
      [
        {
          actionId: ids.action,
          correlationId: ids.correlation,
          authority,
          threadId: ids.thread,
          checkoutId: ids.checkout,
          kind: "type-text",
          simulatorId: ids.simulator,
          requestedBy: actor,
          startedAt: "2026-07-27T19:59:00.000Z",
        },
      ],
      context,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("type-text");
    expect(evidence[0]?.outcome).toBe("interrupted");
    expect(evidence[0]?.requestedBy).toEqual(actor);
  });

  it("keeps the must-reissue note when interrupted evidence already has a full diagnostic list", async () => {
    const { withInputMustReissueNote: appendNote } = await import("./appleToolchainService");
    const filled = {
      actionId: ids.action,
      correlationId: ids.correlation,
      authority,
      kind: "key-press" as const,
      outcome: "interrupted" as const,
      requestedBy: actor,
      diagnostics: Array.from({ length: 64 }, (_, index) => ({
        severity: "note" as const,
        message: `filled-${String(index)}`,
      })),
      artifacts: [],
      cleanup: "uncertain" as const,
      durationMs: 1,
      completedAt: "2026-07-27T20:00:00.000Z" as const,
    };
    const next = appendNote(filled as never);
    expect(next.diagnostics).toHaveLength(64);
    expect(next.diagnostics.at(-1)?.message).toContain("Issue a new actionId");
  });
});
