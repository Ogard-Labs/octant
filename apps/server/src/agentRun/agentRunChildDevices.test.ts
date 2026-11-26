import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunChildCodeThreads } from "./agentRunChildCodeThreads";
import {
  ChildBootedDeviceLedger,
  childAndroidTools,
  childAppleTools,
  type ChildDeviceToolInput,
} from "./agentRunChildDevices";
import { AgentRunChildResources } from "./agentRunChildTools";
import { CHILD_PARENT, CHILD_RUN, childHost } from "./agentRunChildTools.test-support";

const REPOSITORY = "88888888-8888-4888-8888-888888888888";
const PARENT_CHECKOUT = "44444444-4444-4444-8444-444444444444";
const DEVICE = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
let directory: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "octant-child-device-")));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const threads = () =>
  new AgentRunChildCodeThreads({
    readThread: (id) =>
      String(id) === CHILD_PARENT
        ? ({
            id: CHILD_PARENT,
            projectId: "77777777-7777-4777-8777-777777777777",
            bindingRevisionId: "60000000-0000-4000-8000-000000000001",
            repositoryId: REPOSITORY,
            checkoutId: PARENT_CHECKOUT,
            title: "Footer work",
            lifecycle: "active",
            executionPolicy: "full-access",
            permissionPersistence: "project-default",
            providerInstanceId: "99999999-9999-4999-8999-999999999999",
            modelId: "lead-model",
          } as never)
        : undefined,
    readCheckout: () =>
      ({
        id: PARENT_CHECKOUT,
        repositoryId: REPOSITORY,
        kind: "existing-worktree",
        availability: "available",
        head: { kind: "branch", name: "main", oid: "a".repeat(40) },
        observedAt: "2026-10-03T00:00:00.000Z",
      }) as never,
    verifiedHead: async () => "b".repeat(40),
    fileId: () => crypto.randomUUID() as never,
  });

function input(overrides: Parameters<typeof childHost>[0] = {}): ChildDeviceToolInput {
  return {
    host: childHost({ root: "/child", ...overrides }),
    threads: threads(),
    resources: new AgentRunChildResources(),
    hostId: "30000000-0000-4000-8000-000000000001" as never,
    externalContentIngested: () => false,
    recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }) as never,
    uuid: () => crypto.randomUUID(),
    ledger: new ChildBootedDeviceLedger(join(directory, "devices.json")),
    describe: (effect) => `Allow ${effect.kind} ${effect.request.kind}?`,
    head: async () => "b".repeat(40),
  };
}

function appleService(
  initial: "shutdown" | "booted" = "shutdown",
  fails: ReadonlyArray<string> = [],
  // What the host's device list says now, which Xcode can change without the cache seeing it.
  host: { state: "shutdown" | "booted" | undefined } = { state: undefined },
) {
  let state = initial;
  const executed: Array<{ kind: string; context: Record<string, unknown> }> = [];
  return {
    executed,
    discover: vi.fn(async () => undefined),
    cancel: vi.fn(async () => true),
    snapshot: vi.fn(() => ({
      simulators: [{ simulatorId: DEVICE, name: "iPhone", platform: "ios", state }],
      active: [],
    })),
    readScreenshotArtifact: vi.fn(),
    readLogArtifact: vi.fn(),
    simulatorStateNow: vi.fn(async () => {
      if (host.state !== undefined) state = host.state;
      return host.state ?? state;
    }),
    execute: vi.fn(async (request: { kind: string }, context: Record<string, unknown>) => {
      executed.push({ kind: request.kind, context });
      // As the Apple policy does: an off Simulator is refused, not shut down.
      if (request.kind === "shutdown" && state === "shutdown" && !fails.includes("shutdown"))
        return {
          outcome: "invalid-destination",
          kind: request.kind,
          artifacts: [],
          diagnostics: [{ severity: "error", message: "destination-not-booted" }],
        };
      if (context["approvalValid"] !== true && context["executionPolicy"] !== "full-access")
        return { outcome: "unauthorized", kind: request.kind, artifacts: [], diagnostics: [] };
      if (fails.includes(request.kind))
        return { outcome: "failed", kind: request.kind, artifacts: [], diagnostics: [] };
      if (request.kind === "boot") state = "booted";
      if (request.kind === "shutdown") state = "shutdown";
      return {
        outcome: "succeeded",
        kind: request.kind,
        simulatorId: DEVICE,
        artifacts: [],
        diagnostics: [],
      };
    }),
  };
}

const call = (name: string, body: unknown) => ({ name, inputJson: JSON.stringify(body) });
const apple = (child: ChildDeviceToolInput, service = appleService()) =>
  childAppleTools({
    ...child,
    apple: service as never,
    artifactRoot: "/artifacts",
    recordEvidence: () => undefined,
  });

describe("a Code child's Simulators", () => {
  it("are offered outside Plan where a person can answer, and nowhere else", () => {
    expect(apple(input())?.definitions.map((tool) => tool.name)).toEqual(["octant_apple"]);
    expect(apple(input({ policy: "plan" }))).toBeUndefined();
    expect(apple(input({ attended: false }))).toBeUndefined();
    expect(apple(input({ mode: "work" }))).toBeUndefined();
  });

  it("ask for each effect below Full access, in the child's own worktree at its own commit", async () => {
    const service = appleService();
    const ask = vi.fn(async (_input: { readonly summary: string }) => "approved" as const);
    const tools = apple(input({ ask }), service);
    await tools?.execute(call("octant_apple", { operation: "boot", simulatorId: DEVICE }));
    expect(ask.mock.calls[0]?.[0].summary).toBe("Allow apple-action boot?");
    expect(service.executed[0]).toMatchObject({
      kind: "boot",
      context: {
        threadId: CHILD_RUN,
        checkoutRoot: "/child",
        sourceRevision: "b".repeat(40),
        executionPolicy: "approval-gated",
        approvalValid: true,
      },
    });
    expect(service.executed[0]?.context["checkoutId"]).not.toBe(PARENT_CHECKOUT);
  });

  it("refuse an effect the person declined", async () => {
    const service = appleService();
    const tools = apple(input({ ask: async () => "denied" }), service);
    expect(
      await tools?.execute(call("octant_apple", { operation: "boot", simulatorId: DEVICE })),
    ).toMatchObject({ isError: true });
    expect(service.executed).toEqual([]);
  });

  it("are shut down when the run ends, unless something else had already booted them", async () => {
    const service = appleService();
    const child = input();
    const tools = apple(child, service);
    await tools?.execute(call("octant_apple", { operation: "boot", simulatorId: DEVICE }));
    expect(await child.ledger.leftOver()).toMatchObject([{ platform: "apple", deviceId: DEVICE }]);
    await tools?.close?.();
    expect(service.executed.map((entry) => entry.kind)).toEqual(["boot", "shutdown"]);
    expect(await child.ledger.leftOver()).toEqual([]);

    const running = appleService("booted");
    const other = apple(input(), running);
    await other?.execute(call("octant_apple", { operation: "boot", simulatorId: DEVICE }));
    await other?.close?.();
    expect(running.executed.map((entry) => entry.kind)).not.toContain("shutdown");
  });

  it("stay on disk for a restart when they would not shut down", async () => {
    const service = appleService("shutdown", ["shutdown"]);
    const child = input();
    const tools = apple(child, service);
    await tools?.execute(call("octant_apple", { operation: "boot", simulatorId: DEVICE }));
    await tools?.close?.();
    expect(service.executed.map((entry) => entry.kind)).toEqual(["boot", "shutdown"]);
    expect(
      await new ChildBootedDeviceLedger(join(directory, "devices.json")).leftOver(),
    ).toMatchObject([{ platform: "apple", deviceId: DEVICE }]);
  });

  it("are shut down with the run after a failed test on one that was off", async () => {
    // Xcode may boot the Simulator before the test fails, and the cached state still reads shutdown.
    const service = appleService("shutdown", ["test"], { state: "booted" });
    const child = input({ policy: "full-access" });
    const tools = apple(child, service);
    await tools?.execute(
      call("octant_apple", {
        operation: "test",
        projectPath: "App.xcodeproj",
        scheme: "App",
        simulatorId: DEVICE,
      }),
    );
    await tools?.close?.();
    expect(service.executed.map((entry) => entry.kind)).toEqual(["test", "shutdown"]);
  });

  it("forget one the run never booted, when a failed build left it off, so a restart cannot shut down the person's own", async () => {
    const service = appleService("shutdown", ["test"], { state: "shutdown" });
    const child = input({ policy: "full-access" });
    const tools = apple(child, service);
    await tools?.execute(
      call("octant_apple", {
        operation: "test",
        projectPath: "App.xcodeproj",
        scheme: "App",
        simulatorId: DEVICE,
      }),
    );
    await tools?.close?.();
    expect(await new ChildBootedDeviceLedger(join(directory, "devices.json")).leftOver()).toEqual(
      [],
    );
  });

  it("say no pane shows a running one, since a child opens none", async () => {
    const tools = apple(input(), appleService("booted"));
    const opened = await tools?.execute(
      call("octant_apple", { operation: "open", simulatorId: DEVICE }),
    );
    expect(opened).toMatchObject({ isError: false, result: { kind: "open" } });
    expect(opened?.result).not.toHaveProperty("opensInAppPane");
  });

  it("refuse a test on a Simulator the run could not be held to", async () => {
    const service = appleService();
    const tools = apple(input({ policy: "full-access" }), service);
    expect(
      await tools?.execute(
        call("octant_apple", { operation: "test", projectPath: "App.xcodeproj" }),
      ),
    ).toMatchObject({ isError: true, result: { error: "simulator-id-required" } });
    expect(service.executed).toEqual([]);
  });

  it("are shut down at once when the child loses its grant, and stay on disk for a restart until then", async () => {
    let held = true;
    const service = appleService();
    const child = input({ current: () => held });
    const tools = apple(child, service);
    await tools?.execute(call("octant_apple", { operation: "boot", simulatorId: DEVICE }));
    // What a restarted host would read.
    expect(
      await new ChildBootedDeviceLedger(join(directory, "devices.json")).leftOver(),
    ).toHaveLength(1);
    held = false;
    await child.resources.settle();
    expect(service.executed.map((entry) => entry.kind)).toEqual(["boot", "shutdown"]);
  });
});

describe("a Code child's emulators", () => {
  it("are offered under the same conditions, act in the child's worktree, and shut down with the run", async () => {
    let state = "shutdown";
    const kinds: string[] = [];
    const service = {
      discover: vi.fn(async () => undefined),
      cancel: vi.fn(async () => true),
      snapshot: vi.fn(() => ({
        sdk: { available: true },
        emulators: [{ emulatorId: "Pixel_9", name: "Pixel 9", state }],
        active: [],
      })),
      readScreenshotArtifact: vi.fn(),
      readLogArtifact: vi.fn(),
      execute: vi.fn(async (request: { kind: string }, _context: unknown) => {
        kinds.push(request.kind);
        if (request.kind === "boot") state = "booted";
        return { outcome: "succeeded", kind: request.kind, artifacts: [], diagnostics: [] };
      }),
    };
    const android = (child: ChildDeviceToolInput) =>
      childAndroidTools({ ...child, android: service as never, artifactRoot: "/artifacts" });
    expect(android(input({ policy: "plan" }))).toBeUndefined();
    expect(android(input({ attended: false }))).toBeUndefined();
    expect(android(input({ mode: "chat" }))).toBeUndefined();
    const tools = android(input());
    await tools?.execute(call("octant_android", { operation: "boot", emulatorId: "Pixel_9" }));
    expect(service.execute.mock.calls[0]?.[1]).toMatchObject({
      threadId: CHILD_RUN,
      checkoutRoot: "/child",
    });
    await tools?.close?.();
    expect(kinds).toEqual(["boot", "shutdown"]);
  });

  it("stay on disk for a restart when the image refuses to power off", async () => {
    const service = {
      discover: vi.fn(async () => undefined),
      cancel: vi.fn(async () => true),
      snapshot: vi.fn(() => ({
        sdk: { available: true },
        emulators: [{ emulatorId: "Pixel_9", name: "Pixel 9", state: "shutdown" }],
        active: [],
      })),
      readScreenshotArtifact: vi.fn(),
      readLogArtifact: vi.fn(),
      execute: vi.fn(async (request: { kind: string }, _context: unknown) => ({
        outcome: request.kind === "shutdown" ? "failed" : "succeeded",
        kind: request.kind,
        artifacts: [],
        diagnostics: [],
      })),
    };
    const child = input();
    const tools = childAndroidTools({ ...child, android: service as never, artifactRoot: "/a" });
    await tools?.execute(call("octant_android", { operation: "boot", emulatorId: "Pixel_9" }));
    await tools?.close?.();
    expect(
      await new ChildBootedDeviceLedger(join(directory, "devices.json")).leftOver(),
    ).toMatchObject([{ platform: "android", deviceId: "Pixel_9" }]);
  });

  it("stay on disk for a restart when adb lists an emulator it cannot yet name", async () => {
    const service = {
      discover: vi.fn(async () => undefined),
      cancel: vi.fn(async () => true),
      snapshot: vi.fn(() => ({
        sdk: { available: true },
        emulators: [{ emulatorId: "Pixel_9", name: "Pixel 9", state: "shutdown" }],
        active: [],
      })),
      readScreenshotArtifact: vi.fn(),
      readLogArtifact: vi.fn(),
      // An offline emulator: discovery calls it off, while it may still be running.
      listsUnnamedEmulator: vi.fn(async () => true),
      execute: vi.fn(async (request: { kind: string }, _context: unknown) =>
        request.kind === "shutdown"
          ? {
              outcome: "invalid-destination",
              kind: request.kind,
              artifacts: [],
              diagnostics: [{ severity: "error", message: "destination-not-booted" }],
            }
          : { outcome: "succeeded", kind: request.kind, artifacts: [], diagnostics: [] },
      ),
    };
    const child = input();
    const tools = childAndroidTools({ ...child, android: service as never, artifactRoot: "/a" });
    await tools?.execute(call("octant_android", { operation: "boot", emulatorId: "Pixel_9" }));
    await tools?.close?.();
    expect(
      await new ChildBootedDeviceLedger(join(directory, "devices.json")).leftOver(),
    ).toMatchObject([{ platform: "android", deviceId: "Pixel_9" }]);
  });
});
