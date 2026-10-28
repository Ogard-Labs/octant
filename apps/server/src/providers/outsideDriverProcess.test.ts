import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  decodeProviderInstanceId,
  type OutsideProviderDriverReference,
  type ProviderModelId,
} from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionProcessExit,
  ExtensionProcessHandle,
  ExtensionRuntimeStartInput,
  ExtensionSupervisor,
  OutsideDriverRuntime,
} from "../extensions/extensionSupervisor";
import { serveFixtureDriver, type InMemoryDriverEnd } from "./outsideDriverFixture.test-support";
import {
  OutsideDriverProcesses,
  resolveOutsideDriverRuntime,
  type OutsideDriverProcessesOptions,
  type OutsideDriverProcessStart,
} from "./outsideDriverProcess";
import { makeOutsideHarnessEndpointProxy } from "./outsideHarnessEndpointProxy";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceA = decodeProviderInstanceId("81000000-0000-4000-8000-000000000a01");
const instanceB = decodeProviderInstanceId("81000000-0000-4000-8000-000000000b01");
const driver = {
  extensionId: "81000000-0000-4000-8000-000000000001",
  packageId: "81000000-0000-4000-8000-000000000002",
  componentId: "driver",
  version: "0.1.0",
  digest: `sha256:${"a".repeat(64)}`,
} as OutsideProviderDriverReference;
const runtime: OutsideDriverRuntime = { kind: "bun", path: "/opt/octant/bin/bun" };
const packageRoot = "/data/extensions/versions/driver/content";
const entryPoint = `${packageRoot}/driver/main.mjs`;
const temporaryRoots: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A supervised process the test ends by hand, with stdio it can read and write. */
interface FakeProcess {
  readonly input: ExtensionRuntimeStartInput;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly exit: () => void;
  readonly exited: () => boolean;
}

function fakeSupervisor(
  options: { readonly refuse?: boolean; readonly exitAtStart?: boolean } = {},
) {
  const processes: Array<FakeProcess> = [];
  const stopped: Array<ExtensionRuntimeStartInput> = [];
  const supervisor: Pick<ExtensionSupervisor, "startInteractive" | "stopInteractive"> = {
    startInteractive: async (input) => {
      if (options.refuse === true) throw new Error("Extension component is not effective.");
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const exitListeners: Array<(exit: ExtensionProcessExit) => void> = [];
      let exited = false;
      let settleWait: (exit: ExtensionProcessExit) => void = () => undefined;
      const wait = new Promise<ExtensionProcessExit>((resolve) => {
        settleWait = resolve;
      });
      const exit = () => {
        if (exited) return;
        exited = true;
        for (const listener of exitListeners) listener({ code: 1, signal: null });
        settleWait({ code: 1, signal: null });
      };
      processes.push({ input, stdin, stdout, exit, exited: () => exited });
      if (options.exitAtStart === true) exit();
      const process: ExtensionProcessHandle = {
        pid: 4_000 + processes.length,
        ready: Promise.resolve(),
        wait,
        stop: async () => exit(),
        stdin,
        stdout,
        once: (_event, listener) => exitListeners.push(listener),
      };
      return {
        receipt: {
          extensionId: input.extensionId,
          packageId: input.packageId,
          componentId: input.componentId,
          state: "ready",
        },
        process,
      };
    },
    stopInteractive: async (input) => {
      stopped.push(input);
      const owned = processes.find((candidate) => candidate.input === input);
      owned?.exit();
    },
  };
  return { supervisor, processes, stopped };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "octant-driver-processes-"));
  temporaryRoots.push(root);
  return root;
}

async function processes(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly runtime?: OutsideDriverRuntime | undefined;
    readonly refuse?: boolean;
    readonly exitAtStart?: boolean;
    readonly now?: () => number;
    readonly messageBytes?: number;
    readonly quarantine?: OutsideDriverProcessesOptions["quarantine"];
  } = {},
) {
  const fake = fakeSupervisor({
    ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
    ...(options.exitAtStart === undefined ? {} : { exitAtStart: options.exitAtStart }),
  });
  const root = await temporaryRoot();
  const owner = new OutsideDriverProcesses({
    supervisor: fake.supervisor,
    platform: options.platform ?? "darwin",
    runtime: "runtime" in options ? options.runtime : runtime,
    temporaryRoot: root,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.messageBytes === undefined
      ? {}
      : { limits: { messageBytes: options.messageBytes } }),
    ...(options.quarantine === undefined ? {} : { quarantine: options.quarantine }),
  });
  const start = (instanceId = instanceA, reference = driver) =>
    owner.start({ instanceId, driver: reference, packageRoot, entryPoint });
  return { ...fake, owner, root, start };
}

function channelOf(start: OutsideDriverProcessStart) {
  if (start.status !== "started") throw new Error(`The driver was refused: ${start.reason}.`);
  return start.channel;
}

/** The driver's end of a fake process: lines in from stdin, lines out in seven-byte chunks. */
function driverEnd(process: FakeProcess): InMemoryDriverEnd {
  const listeners: Array<(line: string) => void> = [];
  let buffered = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      for (const listener of listeners) listener(line);
    }
  });
  return {
    write: (line) => {
      const bytes = Buffer.from(`${line}\n`, "utf8");
      for (let offset = 0; offset < bytes.byteLength; offset += 7) {
        process.stdout.write(bytes.subarray(offset, offset + 7));
      }
    },
    onLine: (listener) => listeners.push(listener),
    stopped: process.exited,
    exit: process.exit,
  };
}

describe("outside driver processes", () => {
  it.each(["linux", "win32"] as const)(
    "never starts a driver on %s, which has no confinement for it",
    async (platform) => {
      const context = await processes({ platform });

      expect(await context.start()).toEqual({ status: "refused", reason: "host-prohibited" });
      expect(context.processes).toHaveLength(0);
      expect(await readdir(context.root)).toEqual([]);
    },
  );

  it("finds a driver's runtime only in the server's own Bun or Electron run as Node", () => {
    const electron = "/Applications/Octant.app/Contents/MacOS/Octant";
    expect(
      resolveOutsideDriverRuntime({
        versions: { node: "24.3.0", bun: "1.4.4" },
        execPath: "/opt/octant/bin/bun",
      }),
    ).toEqual({ kind: "bun", path: "/opt/octant/bin/bun" });
    expect(
      resolveOutsideDriverRuntime({
        versions: { node: "24.21.0", electron: "43.7.11" },
        execPath: electron,
      }),
    ).toEqual({ kind: "electron-node", path: electron });
    // Electron's own main process is not Node; the packaged server never runs there.
    expect(
      resolveOutsideDriverRuntime({
        versions: { node: "24.21.0", electron: "43.7.11" },
        type: "browser",
        execPath: electron,
      }),
    ).toBeUndefined();
    expect(
      resolveOutsideDriverRuntime({
        versions: { node: "24.21.0" },
        execPath: "/usr/local/bin/node",
      }),
    ).toBeUndefined();
    expect(
      resolveOutsideDriverRuntime({ versions: { node: "24.3.0", bun: "1.4.4" }, execPath: "bun" }),
    ).toBeUndefined();
  });

  it("launches a driver on Electron's Node as that runtime, so the process port sets its environment", async () => {
    const electron: OutsideDriverRuntime = {
      kind: "electron-node",
      path: "/Applications/Octant.app/Contents/MacOS/Octant",
    };
    const context = await processes({ runtime: electron });
    channelOf(await context.start());

    expect(context.processes[0]?.input).toMatchObject({
      command: electron.path,
      args: [entryPoint],
      cwd: packageRoot,
      sandbox: { kind: "outside-driver", runtime: "electron-node", packageRoot },
    });
  });

  it("starts no driver when the server runs on neither Bun nor Electron's Node", async () => {
    const context = await processes({ runtime: undefined });

    expect(await context.start()).toEqual({ status: "refused", reason: "runtime-unavailable" });
    expect(context.processes).toHaveLength(0);
  });

  it("runs each instance's driver as its own supervised process on the host's runtime, in its package", async () => {
    const context = await processes();
    channelOf(await context.start(instanceA));
    channelOf(await context.start(instanceB));

    expect(await context.start(instanceA)).toEqual({
      status: "refused",
      reason: "already-running",
    });
    const [first, second] = context.processes;
    expect(first?.input).toMatchObject({
      ...driver,
      entryPoint,
      command: runtime.path,
      args: [entryPoint],
      cwd: packageRoot,
      env: {},
      sandbox: {
        kind: "outside-driver",
        runtime: "bun",
        instanceId: String(instanceA),
        packageRoot,
      },
    });
    expect(second?.input.sandbox).toMatchObject({ instanceId: String(instanceB) });
    const folders = [first, second].map((process) =>
      process?.input.sandbox?.kind === "outside-driver"
        ? process.input.sandbox.temporaryDirectory
        : "",
    );
    expect(new Set(folders).size).toBe(2);
    expect((await readdir(context.root)).sort()).toEqual(
      folders.map((folder) => folder.slice(context.root.length + 1)).sort(),
    );

    await context.owner.stop(instanceA);
    expect(context.stopped).toEqual([first?.input]);
    expect(await readdir(context.root)).toHaveLength(1);
    channelOf(await context.start(instanceA));
  });

  it("starts no process and leaves no folder when the instance is stopped while its start is still under way", async () => {
    const context = await processes();
    const starting = context.start();
    await context.owner.stop(instanceA);

    expect(await starting).toEqual({ status: "refused", reason: "start-failed" });
    expect(context.processes.filter((process) => !process.exited())).toEqual([]);
    expect(await readdir(context.root)).toEqual([]);
    channelOf(await context.start());
  });

  it("refuses an entry module outside the package before anything starts", async () => {
    const context = await processes();
    const start = await context.owner.start({
      instanceId: instanceA,
      driver,
      packageRoot,
      entryPoint: `${packageRoot}/../other/main.mjs`,
    });

    expect(start).toEqual({ status: "refused", reason: "start-failed" });
    expect(context.processes).toHaveLength(0);
  });

  it("leaves no folder behind when the supervisor refuses the launch", async () => {
    const context = await processes({ refuse: true });

    expect(await context.start()).toEqual({ status: "refused", reason: "start-failed" });
    expect(await readdir(context.root)).toEqual([]);
    channelOf(await (await processes()).start());
  });

  it("allows two restarts a minute and quarantines the driver at that digest on the third crash", async () => {
    let now = 0;
    const record = vi.fn();
    const context = await processes({
      now: () => now,
      quarantine: { holds: () => false, record },
    });
    for (let crash = 1; crash <= 3; crash += 1) {
      const closed = vi.fn();
      channelOf(await context.start()).onClosed(closed);
      now += 1_000;
      context.processes.at(-1)?.exit();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect(await readdir(context.root)).toEqual([]));
      // The hold is journaled the moment the limit is crossed, and only then.
      expect(record).toHaveBeenCalledTimes(crash === 3 ? 1 : 0);
    }
    expect(record).toHaveBeenCalledWith(instanceA, driver);

    expect(await context.start()).toEqual({ status: "refused", reason: "quarantined" });
    expect(context.processes).toHaveLength(3);
    const updated = {
      ...driver,
      digest: `sha256:${"b".repeat(64)}`,
    } as OutsideProviderDriverReference;
    channelOf(await context.start(instanceA, updated));
    channelOf(await context.start(instanceB));
  });

  it("refuses a driver the journal holds at that digest, as after a restart, before any folder or process exists", async () => {
    const context = await processes({
      quarantine: {
        holds: (instanceId, digest) =>
          String(instanceId) === String(instanceA) && String(digest) === String(driver.digest),
        record: () => undefined,
      },
    });

    expect(await context.start()).toEqual({ status: "refused", reason: "quarantined" });
    expect(context.processes).toHaveLength(0);
    expect(await readdir(context.root)).toEqual([]);
    // The hold is the instance's at that digest, not the driver's everywhere.
    channelOf(
      await context.start(instanceA, {
        ...driver,
        digest: `sha256:${"b".repeat(64)}`,
      } as OutsideProviderDriverReference),
    );
    channelOf(await context.start(instanceB));
  });

  it("counts a driver that exits before its start returns as a crash, and frees the instance", async () => {
    const context = await processes({ exitAtStart: true });
    for (let crash = 1; crash <= 3; crash += 1) {
      const closed = vi.fn();
      channelOf(await context.start()).onClosed(closed);
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    }

    expect(await context.start()).toEqual({ status: "refused", reason: "quarantined" });
  });

  it("forgets crashes older than a minute, and never counts a stop the host asked for", async () => {
    let now = 0;
    const context = await processes({ now: () => now });
    for (const at of [0, 1_000, 70_000, 71_000]) {
      now = at;
      channelOf(await context.start());
      context.processes.at(-1)?.exit();
      await vi.waitFor(async () => expect(await readdir(context.root)).toEqual([]));
    }
    for (let stop = 0; stop < 5; stop += 1) {
      channelOf(await context.start());
      await context.owner.stop(instanceA);
    }

    channelOf(await context.start());
  });

  it("carries the wire protocol over the process's stdio, with characters split across chunks", async () => {
    const context = await processes();
    const channel = channelOf(await context.start());
    const fake = context.processes[0];
    if (fake === undefined) throw new Error("expected a process");
    const listed = "modèle-✓" as ProviderModelId;
    serveFixtureDriver(driverEnd(fake), {
      probe: () => ({ models: [{ id: listed, contextWindowTokens: 8192 }] }),
    });
    const registry = new ProviderRuntimeRegistry();
    const proxy = makeOutsideHarnessEndpointProxy({
      instanceId: instanceA,
      channel,
      baseUrl: "http://127.0.0.1:11434",
      key: undefined,
      modelIds: [listed],
      runtimeRegistry: registry,
      limits: { callTimeoutMs: 2_000 },
    });

    const probe = await Effect.runPromise(Effect.scoped(proxy.probe({ instanceId: instanceA })));
    expect(probe.models.map((model) => String(model.id))).toEqual([listed]);
  });

  it("hands an unfinished line past the cap to the proxy, which stops the driver without counting a crash", async () => {
    const context = await processes({ messageBytes: 64 });
    const channel = channelOf(await context.start());
    const fake = context.processes[0];
    if (fake === undefined) throw new Error("expected a process");
    const registry = new ProviderRuntimeRegistry();
    const proxy = makeOutsideHarnessEndpointProxy({
      instanceId: instanceA,
      channel,
      baseUrl: "http://127.0.0.1:11434",
      key: undefined,
      modelIds: ["local-model" as ProviderModelId],
      runtimeRegistry: registry,
      limits: { callTimeoutMs: 2_000, messageBytes: 64 },
    });
    const probe = Effect.runPromiseExit(Effect.scoped(proxy.probe({ instanceId: instanceA })));
    fake.stdout.write("x".repeat(100));

    expect((await probe)._tag).toBe("Failure");
    expect(registry.observedState(instanceA)).toMatchObject({
      readiness: "incompatible",
      reason: "driver-incompatible",
    });
    await vi.waitFor(() => expect(context.stopped).toEqual([fake.input]));
    for (let start = 0; start < 4; start += 1) {
      channelOf(await context.start());
      await context.owner.stop(instanceA);
    }
  });
});
