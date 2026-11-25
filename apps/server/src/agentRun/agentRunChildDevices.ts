import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AndroidEmulatorRequest,
  AppleActionRequest,
  AppleSimulatorRequest,
  CodeThread,
  ToolActionApproval,
  ToolActionAuthority,
} from "@octant/contracts";
import {
  createCodeAppManagedTools,
  type CodeAndroidToolPort,
  type CodeAppleToolPort,
  type CodeAppManagedToolsOptions,
  type CodeDeviceApprovalEffect,
} from "../code/codeAppManagedTools";
import type {
  AndroidExecutionContext,
  AndroidToolchainService,
} from "../android/androidToolchainService";
import type { AppleExecutionContext, AppleToolchainService } from "../apple/appleToolchainService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { childCodeAuthority, type ChildCodeToolInput } from "./agentRunChildCodeTools";
import { whileChildRuns } from "./agentRunChildTools";

const APPLE = "octant_apple";
const ANDROID = "octant_android";
const SHUTDOWN_TIMEOUT_MS = 30_000;

/** One device a child booted, with what shutting it down again must name. */
export interface ChildBootedDevice {
  readonly platform: "apple" | "android";
  readonly deviceId: string;
  readonly authority: ToolActionAuthority;
  readonly threadId: string;
  readonly checkoutId: string;
}

/**
 * The devices child runs booted and have not shut down yet, on disk. A
 * Simulator or an emulator outlives the host that booted it, so a restart
 * reads this and shuts down what a child it cut off left running. It holds
 * identifiers only.
 */
export class ChildBootedDeviceLedger {
  readonly #path: string;
  #writing: Promise<void> = Promise.resolve();
  #devices: ReadonlyArray<ChildBootedDevice> = [];

  constructor(path: string) {
    this.#path = path;
  }

  /** What an earlier host left, kept on disk until each is removed. */
  async leftOver(): Promise<ReadonlyArray<ChildBootedDevice>> {
    let left: ReadonlyArray<ChildBootedDevice> = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      left = Array.isArray(parsed) ? parsed.filter(isBootedDevice) : [];
    } catch {
      return [];
    }
    for (const device of left) this.#devices = [...this.#without(device), device];
    return left;
  }

  add(device: ChildBootedDevice): Promise<void> {
    this.#devices = [...this.#without(device), device];
    return this.#save();
  }

  remove(device: ChildBootedDevice): Promise<void> {
    this.#devices = this.#without(device);
    return this.#save();
  }

  #without(device: ChildBootedDevice): ReadonlyArray<ChildBootedDevice> {
    return this.#devices.filter(
      (held) => held.platform !== device.platform || held.deviceId !== device.deviceId,
    );
  }

  #save(): Promise<void> {
    const devices = this.#devices;
    this.#writing = this.#writing
      .then(async () => {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        await writeFile(`${this.#path}.tmp`, JSON.stringify(devices), { mode: 0o600 });
        await rename(`${this.#path}.tmp`, this.#path);
      })
      .catch(() => undefined);
    return this.#writing;
  }
}

function isBootedDevice(value: unknown): value is ChildBootedDevice {
  if (typeof value !== "object" || value === null) return false;
  const text = (key: string) => typeof Reflect.get(value, key) === "string";
  const authority: unknown = Reflect.get(value, "authority");
  return (
    ["apple", "android"].includes(String(Reflect.get(value, "platform"))) &&
    text("deviceId") &&
    text("threadId") &&
    text("checkoutId") &&
    typeof authority === "object" &&
    authority !== null
  );
}

export interface ChildDeviceToolInput extends ChildCodeToolInput {
  readonly ledger: ChildBootedDeviceLedger;
  /** What the person is asked about one effect, in the words a thread's own device ask uses. */
  readonly describe: (effect: CodeDeviceApprovalEffect, thread: CodeThread) => string;
  /** The commit the child's worktree stands on, proven for this call; undefined refuses it. */
  readonly head: (threadId: string) => Promise<string | undefined>;
}

/** The parts a child's device tool shares whichever platform it drives. */
function deviceTool(
  input: ChildDeviceToolInput,
  toolName: typeof APPLE | typeof ANDROID,
  build: (device: {
    readonly context: (approval?: ToolActionApproval) => Promise<
      | {
          readonly thread: CodeThread;
          readonly folder: string;
          readonly head: string;
          readonly approvalValid: boolean;
        }
      | undefined
    >;
    readonly own: (deviceId: string) => ChildBootedDevice;
    readonly booted: (deviceId: string) => Promise<void>;
    readonly forget: (deviceId: string) => Promise<void>;
    readonly recording: (deviceId: string, running: boolean) => void;
  }) => {
    readonly port: Pick<CodeAppManagedToolsOptions, "apple" | "android">;
    readonly stopRecording: (deviceId: string) => Promise<unknown>;
    readonly cancelActive: () => Promise<unknown>;
    readonly stop: (device: ChildBootedDevice) => Promise<unknown>;
  },
): AppManagedToolSet | undefined {
  const { host, threads } = input;
  if (!host.authority.shell || !host.attended()) return undefined;
  const windowId = host.window();
  const child = host.mode === "code" ? threads.read(host) : undefined;
  const authority = childCodeAuthority(input);
  if (windowId === undefined || child === undefined || authority === undefined) return undefined;
  const platform = toolName === APPLE ? "apple" : "android";
  const only = [toolName];
  const threadNow = (): CodeThread | undefined => {
    const current =
      host.current() && host.window() !== undefined ? threads.read(host)?.thread : undefined;
    return current === undefined ? undefined : { ...current, toolConstraints: only };
  };
  // Each answer allows the one action it was asked for, once.
  const approved = new Set<string>();
  const devices = new Map<string, ChildBootedDevice>();
  const recordings = new Set<string>();
  // The child's own scope, fixed when its tools were built: ending what it
  // started needs no current grant, because a run that lost it is the one to stop.
  const own = (deviceId: string): ChildBootedDevice => ({
    platform,
    deviceId,
    authority,
    threadId: host.runId,
    checkoutId: String(child.checkout.id),
  });
  const built = build({
    own,
    context: async (approval) => {
      const thread = threadNow();
      const head = thread === undefined ? undefined : await input.head(host.runId);
      if (thread === undefined || head === undefined) return undefined;
      return {
        thread,
        folder: child.folder,
        head,
        approvalValid:
          host.executionPolicy === "full-access" ||
          (approval?.kind === "approved" && approved.delete(String(approval.approvalId))),
      };
    },
    booted: async (deviceId) => {
      const device = own(deviceId);
      devices.set(deviceId, device);
      await input.ledger.add(device);
    },
    forget: async (deviceId) => {
      const device = devices.get(deviceId);
      recordings.delete(deviceId);
      if (device === undefined) return;
      devices.delete(deviceId);
      await input.ledger.remove(device);
    },
    recording: (deviceId, running) => {
      if (running) recordings.add(deviceId);
      else recordings.delete(deviceId);
    },
  });
  const unavailable = async () => {
    throw new Error("A child's device tool runs no other operation.");
  };
  const tools = createCodeAppManagedTools({
    windowId,
    thread: { ...child.thread, toolConstraints: only },
    readThread: () => threadNow(),
    uuid: input.uuid,
    executeOperation: unavailable,
    terminal: { read: unavailable },
    deviceApproval: {
      request: async (effect, signal) => {
        const thread = threadNow();
        if (thread === undefined) return { status: "unavailable" };
        const outcome = await host.ask({
          summary: input.describe(effect, thread),
          approvalClass: "child-device",
          signal,
        });
        if (outcome !== "approved") return { status: outcome };
        const approvalId = input.uuid();
        approved.add(approvalId);
        return { status: "approved", approvalId: approvalId as never };
      },
    },
    recordExternalContentIngestion: input.recordExternalContentIngestion,
    ...built.port,
  });
  return whileChildRuns({
    host,
    resources: input.resources,
    tools,
    acquire: () => {
      const release = threads.hold(host);
      return async () => {
        try {
          await built.cancelActive();
          for (const deviceId of recordings) await built.stopRecording(deviceId);
          recordings.clear();
          for (const device of devices.values()) {
            await built.stop(device);
            await input.ledger.remove(device);
          }
          devices.clear();
        } finally {
          release();
        }
      };
    },
  });
}

/** A device action as the host itself takes it, to end what a child run started. */
const hostAction = (input: Pick<ChildCodeToolInput, "uuid">, device: ChildBootedDevice) => ({
  actionId: input.uuid() as never,
  correlationId: input.uuid() as never,
  authority: device.authority,
  threadId: device.threadId as never,
  checkoutId: device.checkoutId as never,
  approval: { kind: "not-required" as const },
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
});

type Apple = Pick<
  AppleToolchainService,
  "discover" | "execute" | "cancel" | "snapshot" | "readScreenshotArtifact" | "readLogArtifact"
>;

const appleHostContext = (
  device: ChildBootedDevice,
  artifactRoot: string,
): AppleExecutionContext => ({
  authority: device.authority,
  threadId: device.threadId as never,
  checkoutId: device.checkoutId as never,
  checkoutRoot: artifactRoot,
  artifactRoot,
  sourceRevision: "0".repeat(40),
  executionPolicy: "full-access",
  approvalValid: true,
});

/** Shuts down a Simulator a child run booted, as the host. */
export async function shutDownChildSimulator(
  apple: Pick<AppleToolchainService, "execute">,
  device: ChildBootedDevice,
  input: { readonly artifactRoot: string; readonly uuid: () => string },
): Promise<void> {
  const request: AppleSimulatorRequest = {
    ...hostAction(input, device),
    kind: "shutdown",
    simulatorId: device.deviceId as never,
  };
  await apple.execute(request, appleHostContext(device, input.artifactRoot)).catch(() => undefined);
}

/** `octant_apple` for an attended Code child outside Plan, on a host that lends an Apple toolchain. */
export function childAppleTools(
  input: ChildDeviceToolInput & {
    readonly apple: Apple;
    readonly artifactRoot: string;
    readonly recordEvidence: (
      evidence: Awaited<ReturnType<Apple["execute"]>>,
      startedAt: string,
    ) => void;
  },
): AppManagedToolSet | undefined {
  const { apple, artifactRoot } = input;
  const tools = deviceTool(input, APPLE, (device) => {
    const contextFor = async (
      scope: {
        readonly authority: ToolActionAuthority;
        readonly checkoutId: CodeThread["checkoutId"];
      },
      approval?: ToolActionApproval,
    ): Promise<AppleExecutionContext | undefined> => {
      const facts = await device.context(approval);
      return facts === undefined
        ? undefined
        : {
            authority: scope.authority,
            threadId: facts.thread.id,
            checkoutId: scope.checkoutId,
            checkoutRoot: facts.folder,
            artifactRoot,
            sourceRevision: facts.head,
            executionPolicy: facts.thread.executionPolicy,
            approvalValid: approval === undefined || facts.approvalValid,
          };
    };
    const stateOf = (context: AppleExecutionContext, id: string | undefined) =>
      apple.snapshot(context).simulators.find((simulator) => String(simulator.simulatorId) === id)
        ?.state;
    const port: CodeAppleToolPort = {
      resolveAuthority: () => childCodeAuthority(input),
      discover: async (_window, request) => {
        const context = await contextFor(request);
        return context === undefined ? undefined : apple.discover(request, context);
      },
      execute: async (_window, request: AppleActionRequest) => {
        const startedAt = new Date().toISOString();
        const context = await contextFor(request, request.approval);
        if (context === undefined) return undefined;
        const before = stateOf(context, request.simulatorId);
        const boots =
          request.kind === "boot"
            ? before === "shutdown" || before === undefined
            : (request.kind === "run" || request.kind === "test") && before === "shutdown";
        const named = request.simulatorId === undefined ? undefined : String(request.simulatorId);
        // Held before it boots, so a run that ends mid-boot still shuts it down.
        if (boots && named !== undefined) await device.booted(named);
        const evidence = await apple.execute(request, context);
        const succeeded = evidence.outcome === "succeeded";
        if (named !== undefined) {
          if (request.kind === "shutdown" && succeeded) await device.forget(named);
          else if (request.kind === "start-recording") device.recording(named, succeeded);
          else if (request.kind === "stop-recording") device.recording(named, false);
          // One whose state was unknown and would not boot was running already.
          else if (
            boots &&
            !succeeded &&
            (before === undefined || stateOf(context, named) === "shutdown")
          )
            await device.forget(named);
        }
        input.recordEvidence(evidence, startedAt);
        return evidence;
      },
      snapshot: async (_window, scope) => {
        const context = await contextFor(scope);
        return context === undefined ? undefined : apple.snapshot(context);
      },
      readScreenshot: async (_window, scope, reference) => {
        const context = await contextFor(scope);
        if (context === undefined) return undefined;
        const artifact = await apple.readScreenshotArtifact(reference, context);
        return artifact.kind === "found" ? artifact.bytes : undefined;
      },
      readLog: async (_window, scope, reference) => {
        const context = await contextFor(scope);
        return context === undefined ? undefined : apple.readLogArtifact(reference, context);
      },
      // The pane belongs to the thread the person has open; a child opens none.
      requestPaneOpen: async () => undefined,
      // Every input of a child's asks for itself.
      inputGrantIsOpen: () => false,
    };
    return {
      port: { apple: port },
      stopRecording: async (deviceId) => {
        const held = device.own(deviceId);
        await apple
          .execute(
            { ...hostAction(input, held), kind: "stop-recording", simulatorId: deviceId as never },
            appleHostContext(held, artifactRoot),
          )
          .catch(() => undefined);
      },
      cancelActive: async () => {
        const context = appleHostContext(device.own(""), artifactRoot);
        for (const active of apple.snapshot(context).active)
          await apple.cancel(
            {
              actionId: active.actionId,
              correlationId: active.correlationId,
              authority: active.authority,
              reason: "authority-revoked",
            },
            context,
          );
      },
      stop: (held) => shutDownChildSimulator(apple, held, { artifactRoot, uuid: input.uuid }),
    };
  });
  return tools === undefined
    ? undefined
    : {
        ...tools,
        execute: (call) =>
          testsOnUnnamedSimulator(call.inputJson)
            ? Promise.resolve({
                result: {
                  error: "simulator-id-required",
                  message: "Name the simulatorId to test on, so it can be shut down with this run.",
                },
                isError: true,
              })
            : tools.execute(call),
      };
}

/** A test that lets the toolchain pick a Simulator boots one no run could be held to. */
function testsOnUnnamedSimulator(inputJson: string): boolean {
  try {
    const value: unknown = JSON.parse(inputJson);
    if (typeof value !== "object" || value === null) return false;
    const read = (key: string): unknown => Reflect.get(value, key);
    return (
      read("operation") === "test" &&
      read("platform") !== "macos" &&
      read("simulatorId") === undefined
    );
  } catch {
    return false;
  }
}

type Android = Pick<
  AndroidToolchainService,
  "discover" | "execute" | "cancel" | "snapshot" | "readScreenshotArtifact" | "readLogArtifact"
>;

const androidHostContext = (
  device: ChildBootedDevice,
  artifactRoot: string,
): AndroidExecutionContext => ({
  authority: device.authority,
  threadId: device.threadId as never,
  checkoutId: device.checkoutId as never,
  checkoutRoot: artifactRoot,
  artifactRoot,
  executionPolicy: "full-access",
  approvalValid: true,
});

/** Shuts down an emulator a child run booted, as the host. */
export async function shutDownChildEmulator(
  android: Pick<AndroidToolchainService, "discover" | "execute">,
  device: ChildBootedDevice,
  input: { readonly artifactRoot: string; readonly uuid: () => string },
): Promise<void> {
  const context = androidHostContext(device, input.artifactRoot);
  // A host that has just started knows no emulator until it has looked.
  const { approval: _approval, timeoutMs: _timeoutMs, ...looking } = hostAction(input, device);
  await android.discover(looking, context).catch(() => undefined);
  const request: AndroidEmulatorRequest = {
    ...hostAction(input, device),
    kind: "shutdown",
    emulatorId: device.deviceId as never,
  };
  await android.execute(request, context).catch(() => undefined);
}

/** `octant_android` for an attended Code child outside Plan, on a host that lends an Android toolchain. */
export function childAndroidTools(
  input: ChildDeviceToolInput & { readonly android: Android; readonly artifactRoot: string },
): AppManagedToolSet | undefined {
  const { android, artifactRoot } = input;
  return deviceTool(input, ANDROID, (device) => {
    const contextFor = async (
      scope: {
        readonly authority: ToolActionAuthority;
        readonly checkoutId: CodeThread["checkoutId"];
      },
      approval?: ToolActionApproval,
    ): Promise<AndroidExecutionContext | undefined> => {
      const facts = await device.context(approval);
      return facts === undefined
        ? undefined
        : {
            authority: scope.authority,
            threadId: facts.thread.id,
            checkoutId: scope.checkoutId,
            checkoutRoot: facts.folder,
            artifactRoot,
            executionPolicy: facts.thread.executionPolicy,
            approvalValid: approval === undefined || facts.approvalValid,
          };
    };
    const port: CodeAndroidToolPort = {
      resolveAuthority: () => childCodeAuthority(input),
      discover: async (_window, request) => {
        const context = await contextFor(request);
        return context === undefined ? undefined : android.discover(request, context);
      },
      execute: async (_window, request) => {
        const context = await contextFor(request, request.approval);
        if (context === undefined) return undefined;
        const id = String(request.emulatorId);
        const before = android
          .snapshot(context)
          .emulators.find((emulator) => String(emulator.emulatorId) === id)?.state;
        const boots = request.kind === "boot" && (before === "shutdown" || before === undefined);
        // Held before it boots, so a run that ends mid-boot still shuts it down.
        if (boots) await device.booted(id);
        const evidence = await android.execute(request, context);
        const succeeded = evidence.outcome === "succeeded";
        if (request.kind === "shutdown" && succeeded) await device.forget(id);
        else if (request.kind === "start-recording") device.recording(id, succeeded);
        else if (request.kind === "stop-recording") device.recording(id, false);
        else if (boots && !succeeded && before === undefined) await device.forget(id);
        return evidence;
      },
      snapshot: async (_window, scope) => {
        const context = await contextFor(scope);
        return context === undefined ? undefined : android.snapshot(context);
      },
      readScreenshot: async (_window, scope, reference) => {
        const context = await contextFor(scope);
        if (context === undefined) return undefined;
        const artifact = await android.readScreenshotArtifact(reference, context);
        return artifact.kind === "found" ? artifact.bytes : undefined;
      },
      readLog: async (_window, scope, reference) => {
        const context = await contextFor(scope);
        return context === undefined ? undefined : android.readLogArtifact(reference, context);
      },
      requestPaneOpen: async () => undefined,
      inputGrantIsOpen: () => false,
    };
    return {
      port: { android: port },
      stopRecording: async (deviceId) => {
        const held = device.own(deviceId);
        await android
          .execute(
            { ...hostAction(input, held), kind: "stop-recording", emulatorId: deviceId as never },
            androidHostContext(held, artifactRoot),
          )
          .catch(() => undefined);
      },
      cancelActive: async () => {
        const context = androidHostContext(device.own(""), artifactRoot);
        for (const active of android.snapshot(context).active)
          await android.cancel(
            {
              actionId: active.actionId,
              correlationId: active.correlationId,
              authority: active.authority,
              reason: "authority-revoked",
            },
            context,
          );
      },
      stop: (held) => shutDownChildEmulator(android, held, { artifactRoot, uuid: input.uuid }),
    };
  });
}
