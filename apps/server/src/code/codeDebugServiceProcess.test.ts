import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TOOL_EGRESS_THREAD_AGGREGATE,
  decodeCodeCheckoutIdentity,
  decodeCodeRelativePath,
  decodeCodeThread,
  decodeEventActor,
  decodeToolActionAuthority,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import {
  CODE_DEBUG_CONFIGURATION_AGGREGATE,
  CODE_DEBUG_EGRESS_AGGREGATE,
  CODE_DEBUG_SESSION_AGGREGATE,
  decodeCodeDebugChildId,
  decodeCodeDebugConfiguration,
  decodeCodeDebugConfigurationDigest,
  decodeCodeDebugSessionId,
  type CodeDebugConfiguration,
  type CodeDebugSessionId,
  type CodeDebugSessionRequest,
  type CodeDebugSessionResult,
} from "@octant/contracts/code-debug";
import type { ExtensionCommandResult, ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { PrincipalKind } from "@octant/domain";
import { DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH } from "@octant/plugin-api/debug-adapter-package";
import { CodexPluginPackageResolver } from "../extensions/codexPluginResolver";
import { ExtensionApiService } from "../extensions/extensionApiService";
import {
  ExtensionLifecycleService,
  NOOP_EXTENSION_SUPERVISOR,
} from "../extensions/extensionLifecycleService";
import { ExtensionPackageStore } from "../extensions/extensionPackageStore";
import { LocalPluginFolderRegistry } from "../extensions/localPluginFolderRegistry";
import { isExtensionCompatibilityCompatible } from "../extensions/packageInspector";
import { ToolEgressRules } from "../harness/nativeHarnessEgressRules";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import type { RecordExternalContentIngestionInput } from "../context/externalContentIngestionStore";
import {
  createCodeDebugAgentSessionApprovals,
  createCodeDebugAgentTools,
} from "./codeDebugAgentTools";
import { deriveCodeFileId } from "./codeFileIdentity";
import { withProjectExtraFolders } from "./codeProjectFolderRoot";
import { CodeDebugService } from "./codeDebugService";
import { DebugAdapterProcessPort, type DebugAdapterProcess } from "./debugAdapterProcess";
import { DebugConfigurationApprovalStore } from "./debugConfigurationApprovals";
import { createDebugSessionEgress } from "./debugSessionEgress";
import { DebugSessionRecords } from "./debugSessionRecords";
import {
  fakeDebugAdapterScript,
  fakeDebugProgram,
  type FakeDebugAdapterMode,
} from "./fakeDebugAdapter";
import { installedDebugAdapterComponents } from "./installedDebugAdapters";

const now = "2026-10-27T12:00:00.000Z";
const scopeId = "10000000-0000-4000-8000-000000000001" as WindowId;
const repositoryId = `repo_${"a".repeat(64)}`;
const roots: string[] = [];
const markers: string[] = [];
const services: CodeDebugService[] = [];
const listeners: Server[] = [];
const actor = decodeEventActor({
  kind: "local-user",
  actorId: "50000000-0000-4000-8000-000000000001",
});
const hostActor = decodeEventActor({
  kind: "system",
  actorId: "50000000-0000-4000-8000-000000000001",
});
const bubblewrap = process.platform === "linux" && existsSync("/usr/bin/bwrap");
const seatbelt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    listeners.splice(0).map((listener) => new Promise((resolve) => listener.close(resolve))),
  );
  for (const marker of markers.splice(0)) await rm(marker, { force: true });
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

/** The package store hardens what it keeps; a test must loosen it to clean up. */
async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
    else if (entry.isFile()) await chmod(join(directory, entry.name), 0o700).catch(() => undefined);
  }
}

async function hostListener(): Promise<{
  readonly port: number;
  readonly connections: () => number;
}> {
  let connections = 0;
  const listener = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  listeners.push(listener);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  return { port: address.port, connections: () => connections };
}

/**
 * A person's folder holding one debug adapter for the fixture program. The
 * children modes declare children, announced as each mode announces them,
 * unless `declareChildren` is false.
 */
function adapterFolder(
  root: string,
  mode: FakeDebugAdapterMode = "normal",
  options: { readonly declareChildren?: boolean } = {},
): string {
  const children =
    options.declareChildren === false
      ? {}
      : mode === "children-event"
        ? { childSessions: 1, childAnnouncement: { kind: "event", event: "fixtureAttach" } }
        : mode === "children-start-debugging"
          ? { childSessions: 1, childAnnouncement: { kind: "start-debugging" } }
          : {};
  const folder = join(root, `fixture-adapter-${mode}`);
  mkdirSync(join(folder, "bin"), { recursive: true });
  writeFileSync(join(folder, "bin", "adapter"), fakeDebugAdapterScript(mode), { mode: 0o755 });
  const capabilities = ["filesystem", "shell", "network"];
  writeFileSync(
    join(folder, DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH),
    JSON.stringify({
      manifest: {
        manifestVersion: 1,
        slug: `fixture-adapter-${mode}`,
        displayName: "Fixture adapter",
        version: "1.0.0",
        provenance: { publisher: "Example", canonicalUrl: "https://example.com/adapter" },
        license: { kind: "spdx", identifier: "MIT" },
        compatibility: { platforms: ["macos", "linux"], modes: ["code"], providerFamilies: [] },
        declaredCapabilities: capabilities,
        components: [
          {
            id: "adapter",
            kind: "debug-adapter",
            displayName: "Fixture adapter",
            declaredCapabilities: capabilities,
            entryPoint: "bin/adapter",
            debugAdapter: {
              runtimes: ["node"],
              launchArguments: {
                type: "fixture",
                program: "{{program}}",
                args: "{{args}}",
                cwd: "{{cwd}}",
                env: "{{env}}",
                stopOnEntry: "{{stopOnEntry}}",
              },
              importTypes: ["fixture"],
              debugPorts: 0,
              ...children,
            },
          },
        ],
      },
    }),
  );
  return folder;
}

const passthrough: ProcessConfinementPort = {
  prepare: (input) => ({ command: input.executable, args: input.args }),
};

async function host(
  confinement: ProcessConfinementPort,
  options: { readonly hostPort?: number } = {},
) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "octant-debug-session-")));
  roots.push(root);
  const dataDirectory = join(root, "data");
  mkdirSync(dataDirectory);
  const connection = openSqlite(join(dataDirectory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const store = new ExtensionPackageStore({ dataDirectory, uuid: randomUUID });
  await store.initialize();
  const lifecycle = new ExtensionLifecycleService({
    connection,
    journal,
    store,
    supervisor: NOOP_EXTENSION_SUPERVISOR,
    uuid: randomUUID,
    clock: () => now,
  });
  const folders = new LocalPluginFolderRegistry();
  const extensions = new ExtensionApiService({
    lifecycle,
    resolver: new CodexPluginPackageResolver({ localFolderRegistry: folders }),
  });

  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  // Outside the checkout and outside the temporary folder, whose capsule
  // copy is a private one: a write that lands here escaped.
  const outsideMarker = join(homedir(), `.octant-debug-escape-${randomUUID()}`);
  markers.push(outsideMarker);
  writeFileSync(
    join(checkout, "src", "main.js"),
    fakeDebugProgram({ outsideMarker, hostPort: options.hostPort ?? 9 }),
  );
  const threads: CodeThread[] = [
    decodeCodeThread({
      id: "20000000-0000-4000-8000-000000000001",
      projectId: "40000000-0000-4000-8000-000000000001",
      bindingRevisionId: "70000000-0000-4000-8000-000000000001",
      repositoryId,
      checkoutId: "30000000-0000-4000-8000-000000000001",
      title: "Debug",
      lifecycle: "active",
      providerInstanceId: "60000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "feature/debug",
        remoteName: "origin",
        proposedBaseRepository: "octant/octant",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  const thread = () => {
    const found = threads[0];
    if (found === undefined) throw new Error("no thread");
    return found;
  };
  const checkoutIdentity = decodeCodeCheckoutIdentity({
    id: thread().checkoutId,
    repositoryId,
    kind: "plain-folder",
    availability: "available",
    head: { kind: "none" },
    observedAt: now,
  });
  const egressRules = new ToolEgressRules({
    journal,
    readThread: (threadId) =>
      threadId === String(thread().id) ? { projectId: String(thread().projectId) } : undefined,
    readThreadTaint: () => false,
    recordLaunchTaint: () => {
      throw new Error("a debug session marks no thread");
    },
    hostActor,
    personActor: actor,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const egressDirectory = join(root, "egress");
  mkdirSync(egressDirectory, { mode: 0o700 });
  const receiptDirectory = join(root, "receipts");
  let running: DebugAdapterProcess | undefined;
  let launches = 0;
  const processPort = () =>
    new DebugAdapterProcessPort({
      confinement,
      receiptDirectory,
      egress: createDebugSessionEgress({
        journal,
        rules: egressRules,
        endpoint:
          process.platform === "darwin"
            ? { kind: "loopback" }
            : { kind: "unix-socket", parentDirectory: egressDirectory },
        hostActor,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      }),
    });
  const processes = processPort();
  const records = new DebugSessionRecords({
    journal,
    personActor: actor,
    hostActor,
    uuid: randomUUID,
    clock: () => now,
  });
  const approvals = () =>
    new DebugConfigurationApprovalStore({
      journal,
      personActor: actor,
      uuid: randomUUID,
      clock: () => now,
    });
  const approvalStore = approvals();
  const windowGrant = { fullAccess: false };
  const extraFolders: string[] = [];
  const service = new CodeDebugService({
    authority: {
      readThread: (threadId) =>
        threads.find((candidate) => String(candidate.id) === String(threadId)),
      readCheckout: (checkoutId) =>
        String(checkoutId) === String(checkoutIdentity.id) ? checkoutIdentity : undefined,
      canAccessProject: () => true,
      // Full access granted for this window's session only, as a person
      // grants it without remembering it.
      effectiveThread: (_scope, candidate) =>
        windowGrant.fullAccess ? { ...candidate, executionPolicy: "full-access" } : candidate,
      resolveRoot: withProjectExtraFolders({
        resolve: (_scope, candidate, current, relativePath) => ({
          fileId: deriveCodeFileId(String(candidate.id), String(current.id), relativePath),
          rootPath: checkout,
          rootIdentity: { device: "1", inode: "1" },
        }),
        extraFolders: () => extraFolders,
        probePath: decodeCodeRelativePath("package.json"),
        fileId: (threadId, checkoutId, path) =>
          deriveCodeFileId(threadId, checkoutId, path as never),
        statIdentity: async () => ({ device: "2", inode: "2" }),
      }),
    },
    approvals: approvalStore,
    adapters: installedDebugAdapterComponents({
      snapshot: () => extensions.snapshot(),
      store,
      compatible: (compatibility) =>
        isExtensionCompatibilityCompatible(compatibility, "1.0.0", process.platform),
    }),
    processes: {
      launch: async (input) => {
        launches += 1;
        const outcome = await processes.launch(input);
        if (outcome.status === "launched") running = outcome.process;
        return outcome;
      },
      proxies: processes.proxies,
    },
    records,
    platform: process.platform === "darwin" ? "macos" : "linux",
    stateRoot: join(root, "state"),
    uuid: randomUUID,
  });
  services.push(service);

  const execute = async (command: Parameters<ExtensionApiService["execute"]>[0]) => {
    const result = await extensions.execute(command);
    if (result.kind === "extension-command-failed") {
      throw new Error(`extension command failed: ${result.failure.message}`);
    }
    return result;
  };
  const installed = (): ExtensionSnapshot["packages"][number] => {
    const found = extensions.snapshot().packages[0];
    if (found === undefined) throw new Error("no package is installed");
    return found;
  };
  const journaled = (aggregateType: string) =>
    journal
      .replayAggregateType({ aggregateType, afterSequence: 0, limit: 1_000 })
      .map((event) => ({ eventName: String(event.eventName), payload: event.payload }));
  const caller = (principal: PrincipalKind = "local-window") => ({ scopeId, principal });
  const configuration = (
    overrides: Partial<Record<string, unknown>> = {},
  ): CodeDebugConfiguration =>
    decodeCodeDebugConfiguration({
      name: "Run the fixture",
      adapter: `${String(installed().extensionId)}/adapter`,
      program: "src/main.js",
      args: ["--verbose"],
      env: [{ key: "FIXTURE_MODE", value: "debug" }],
      stopOnEntry: false,
      ...overrides,
    });
  const scope = () => ({ threadId: thread().id, checkoutId: checkoutIdentity.id });
  return {
    root,
    checkout,
    outsideMarker,
    store,
    service,
    threads,
    thread,
    windowGrant,
    extraFolders,
    journal: {
      approvals: () => journaled(CODE_DEBUG_CONFIGURATION_AGGREGATE),
      sessions: () => journaled(CODE_DEBUG_SESSION_AGGREGATE),
      egress: () => journaled(CODE_DEBUG_EGRESS_AGGREGATE),
      threadEgress: () => journaled(TOOL_EGRESS_THREAD_AGGREGATE),
      /** Every payload the journal holds, whatever its aggregate. */
      all: () => connection.prepare("SELECT payload_json FROM event_journal").all(),
    },
    records,
    approvalStore,
    journalStore: journal,
    reloadedApprovals: approvals,
    processPort,
    launches: () => launches,
    running: () => running,
    configuration,
    install: async (folder: string) => {
      const registered = await folders.register(folder);
      const inspected = await execute({ kind: "inspect-package", source: registered.source });
      if (inspected.kind !== "package-inspected") throw new Error("package was not inspected");
      const { entry } = inspected.preview;
      await execute({
        kind: "install-package",
        extensionId: entry.extensionId,
        packageId: entry.packageId,
        version: entry.version,
        digest: entry.digest,
      });
      return installed();
    },
    inspect: async (folder: string): Promise<ExtensionCommandResult> => {
      const registered = await folders.register(folder);
      return extensions.execute({ kind: "inspect-package", source: registered.source });
    },
    /** Trusts the package and switches it on, as a person does in Settings. */
    enable: async () => {
      await execute({
        kind: "set-source-trust",
        commandVersion: 1,
        extensionId: installed().extensionId,
        trusted: true,
        expectedStateVersion: installed().stateVersion,
      } as Parameters<ExtensionApiService["execute"]>[0]);
      for (const kind of ["set-plugin-desired", "set-component-desired"] as const) {
        await execute({
          kind,
          commandVersion: 1,
          extensionId: installed().extensionId,
          ...(kind === "set-component-desired"
            ? { componentId: installed().components[0]?.component.id }
            : {}),
          desired: true,
          expectedStateVersion: installed().stateVersion,
        } as Parameters<ExtensionApiService["execute"]>[0]);
      }
    },
    switchComponent: (desired: boolean) =>
      execute({
        kind: "set-component-desired",
        commandVersion: 1,
        extensionId: installed().extensionId,
        componentId: installed().components[0]?.component.id,
        desired,
        expectedStateVersion: installed().stateVersion,
      } as Parameters<ExtensionApiService["execute"]>[0]),
    configurations: (principal?: PrincipalKind) =>
      service.configurations(caller(principal), scope()),
    approve: (
      value: CodeDebugConfiguration,
      approvalScope: "checkout" | "project" = "checkout",
      principal?: PrincipalKind,
    ) =>
      service.approve(caller(principal), {
        ...scope(),
        configuration: value,
        scope: approvalScope,
      }),
    start: (value: CodeDebugConfiguration, principal?: PrincipalKind, lines = [42]) =>
      service.start(caller(principal), {
        ...scope(),
        configuration: value,
        breakpoints: [
          {
            path: value.program,
            breakpoints: lines.map((line) => ({ line })),
          },
        ],
      }),
    ask: (
      sessionId: CodeDebugSessionId,
      request: CodeDebugSessionRequest,
      principal?: PrincipalKind,
      child?: number,
    ): Promise<CodeDebugSessionResult> =>
      service.session(caller(principal), {
        ...scope(),
        sessionId,
        ...(child === undefined ? {} : { child: decodeCodeDebugChildId(child) }),
        request,
      }),
    /** Waits until the session, or one of its children, reports a state that `matches`. */
    waitFor: async (
      sessionId: CodeDebugSessionId,
      matches: (result: CodeDebugSessionResult) => boolean,
      child?: number,
    ): Promise<CodeDebugSessionResult> => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const result = await service.session(caller(), {
          ...scope(),
          sessionId,
          ...(child === undefined ? {} : { child: decodeCodeDebugChildId(child) }),
          request: { kind: "state" },
        });
        if (matches(result)) return result;
        if (Date.now() > deadline)
          throw new Error(`state never matched: ${JSON.stringify(result)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

type Host = Awaited<ReturnType<typeof host>>;

const stoppedAt = (line: number) => async (test: Host, sessionId: CodeDebugSessionId) => {
  await test.waitFor(
    sessionId,
    (result) => result.status === "state" && result.state.status === "stopped",
  );
  const stack = await test.ask(sessionId, { kind: "stack-trace", programThreadId: 1 });
  if (stack.status !== "stack") throw new Error(`no stack: ${JSON.stringify(stack)}`);
  expect(stack.frames[0]?.location).toMatchObject({ kind: "checkout", path: "src/main.js", line });
  return stack;
};

async function startedSession(test: Host, value = test.configuration()) {
  expect(await test.approve(value)).toMatchObject({ status: "approved" });
  const started = await test.start(value);
  if (started.status !== "started") throw new Error(`not started: ${JSON.stringify(started)}`);
  return started.sessionId;
}

describe("debug adapters a person adds", () => {
  it("names the binary, its digest, the runtimes, the launch body, and the port in review, and installs it untrusted", async () => {
    const test = await host(passthrough);
    const folder = adapterFolder(test.root);
    const inspected = await test.inspect(folder);
    if (inspected.kind !== "package-inspected") {
      throw new Error(`package was not inspected: ${JSON.stringify(inspected)}`);
    }
    expect(inspected.preview.review.components[0]?.debugAdapter).toEqual({
      runtimes: ["node"],
      launchArguments: {
        type: "fixture",
        program: "{{program}}",
        args: "{{args}}",
        cwd: "{{cwd}}",
        env: "{{env}}",
        stopOnEntry: "{{stopOnEntry}}",
      },
      importTypes: ["fixture"],
      debugPorts: 0,
      binary: "bin/adapter",
      binaryDigest: `sha256:${createHash("sha256")
        .update(readFileSync(join(folder, "bin", "adapter")))
        .digest("hex")}`,
    });
    const installed = await test.install(folder);
    expect(installed.components[0]?.effectiveState).toEqual({
      kind: "blocked",
      reason: "untrusted",
    });
    // Installed but not reviewed and switched on, it is offered nowhere.
    expect(await test.configurations()).toMatchObject({ status: "listed", adapters: [] });
  });

  it("says in review that an adapter also debugs the program's children, and how it announces one", async () => {
    const test = await host(passthrough);
    const inspected = await test.inspect(adapterFolder(test.root, "children-event"));
    if (inspected.kind !== "package-inspected") throw new Error(JSON.stringify(inspected));
    expect(inspected.preview.review.components[0]?.debugAdapter).toMatchObject({
      childSessions: 1,
      childAnnouncement: { kind: "event", event: "fixtureAttach" },
    });
  });

  it("refuses a package that ships another program besides its binary", async () => {
    const test = await host(passthrough);
    const folder = adapterFolder(test.root);
    writeFileSync(join(folder, "bin", "helper"), "#!/bin/sh\n", { mode: 0o755 });
    const result = await test.inspect(folder);
    expect(result.kind === "extension-command-failed" ? result.failure.message : undefined).toBe(
      "This debug adapter ships a program besides its own binary.",
    );
  });
});

describe("starting a debug session", () => {
  it("launches nothing without a configuration the person confirmed, and refuses Plan, a paired device, and a changed configuration or package", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const value = test.configuration();

    expect(await test.start(value)).toEqual({ status: "refused", reason: "approval-required" });
    // A paired device can neither confirm, start, nor read the panel's list.
    expect(await test.approve(value, "checkout", "remote-device")).toEqual({
      status: "refused",
      reason: "local-host-required",
    });
    expect(await test.start(value, "remote-device")).toEqual({
      status: "refused",
      reason: "local-host-required",
    });
    expect(await test.configurations("remote-device")).toEqual({
      status: "refused",
      reason: "local-host-required",
    });
    expect(test.launches()).toBe(0);

    expect(await test.approve(value)).toMatchObject({ status: "approved", scope: "checkout" });
    expect(test.journal.approvals()).toHaveLength(1);
    // Confirmed, it still never starts for a paired device.
    expect(await test.start(value, "remote-device")).toEqual({
      status: "refused",
      reason: "local-host-required",
    });
    // An edited configuration is a new one the person confirms again.
    expect(await test.start(test.configuration({ args: ["--other"] }))).toEqual({
      status: "refused",
      reason: "approval-required",
    });
    expect(await test.configurations()).toMatchObject({
      status: "listed",
      approved: [{ configuration: value, scope: "checkout" }],
      launchFile: { status: "absent" },
    });

    // Plan refuses before anything launches, and nothing is confirmed there.
    test.threads[0] = { ...test.thread(), executionPolicy: "plan" };
    expect(await test.start(value)).toEqual({ status: "refused", reason: "plan-read-only" });
    expect(await test.approve(value)).toEqual({ status: "refused", reason: "plan-read-only" });
    test.threads[0] = { ...test.thread(), executionPolicy: "approval-gated" };
    expect(test.launches()).toBe(0);

    // A switch turned off and on again changes the package state the
    // confirmation covered.
    await test.switchComponent(false);
    expect(await test.start(value)).toEqual({ status: "refused", reason: "no-debug-adapter" });
    await test.switchComponent(true);
    expect(await test.start(value)).toEqual({ status: "refused", reason: "approval-required" });
    expect(test.launches()).toBe(0);

    // A configuration whose program is gone, or outside the checkout, is refused.
    expect(await test.approve(test.configuration({ program: "src/missing.js" }))).toEqual({
      status: "refused",
      reason: "configuration-invalid",
    });
    // A restarted host still holds the confirmation the journal holds.
    expect(test.reloadedApprovals().approvals(test.thread().projectId)).toHaveLength(1);
  });

  it("starts a program that lives in an extra folder, and refuses one in a folder beside it", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const extra = join(test.root, "extra");
    const beside = join(test.root, "beside");
    for (const folder of [extra, beside]) {
      mkdirSync(folder);
      writeFileSync(join(folder, "main.js"), "// program\n");
    }
    test.extraFolders.push(extra);

    const inExtra = test.configuration({ program: join(extra, "main.js"), cwd: extra });
    expect(await test.approve(inExtra)).toMatchObject({ status: "approved" });
    expect(await test.start(inExtra)).toMatchObject({ status: "started" });

    expect(await test.approve(test.configuration({ program: join(beside, "main.js") }))).toEqual({
      status: "refused",
      reason: "configuration-invalid",
    });
    // Traversal out of the folder never decodes into a configuration.
    expect(() => test.configuration({ program: `${extra}/../beside/main.js` })).toThrow();
    // A working folder outside the folder the program lives in is refused too.
    expect(
      await test.approve(test.configuration({ program: join(extra, "main.js"), cwd: beside })),
    ).toEqual({ status: "refused", reason: "configuration-invalid" });
  });

  it("proposes configurations from the repository's launch file without running anything", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    mkdirSync(join(test.checkout, ".vscode"));
    writeFileSync(
      join(test.checkout, ".vscode", "launch.json"),
      `{
  // Comments and trailing commas, as editors write them.
  "version": "0.2.0",
  "configurations": [
    { "type": "fixture", "request": "launch", "name": "Fixture", "program": "\${workspaceFolder}/src/main.js", "preLaunchTask": "build", },
    { "type": "fixture", "request": "attach", "name": "Attach" },
    { "type": "fixture", "request": "launch", "name": "Command", "program": "\${command:pickFile}" },
  ],
}`,
    );
    const listed = await test.configurations();
    if (listed.status !== "listed") throw new Error(`not listed: ${JSON.stringify(listed)}`);
    // The panel names the package and version, as Settings does, beside the adapter.
    expect(listed.adapters).toMatchObject([
      { displayName: "Fixture adapter", packageName: "Fixture adapter", packageVersion: "1.0.0" },
    ]);
    expect(listed.launchFile).toMatchObject({
      status: "read",
      proposals: [
        {
          status: "proposed",
          configuration: { name: "Fixture", program: "src/main.js" },
          unusedFields: ["preLaunchTask"],
        },
        { status: "unmappable", reason: "not-launch" },
        { status: "unmappable", reason: "unsupported-variable" },
      ],
    });
    expect(test.launches()).toBe(0);
  });
});

describe("a running debug session", () => {
  it("refuses the adapter's requests to run a terminal or start another session", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root, "reverse-requests"));
    await test.enable();
    const sessionId = await startedSession(test);
    await stoppedAt(42)(test, sessionId);
    expect(Object.fromEntries(test.service.refusedAdapterRequests(sessionId))).toEqual({
      runInTerminal: 1,
      startDebugging: 1,
    });
    const state = await test.ask(sessionId, { kind: "state" });
    const output = state.status === "state" ? state.output.map((entry) => entry.text) : [];
    expect(output).toContain("host answered runInTerminal: false\n");
    expect(output).toContain("host answered startDebugging: false\n");
    // Telemetry never reaches the session's output.
    expect(output.join("")).not.toContain("adapter telemetry");
    expect(existsSync("/tmp/ran-in-terminal")).toBe(false);
  });

  it("ends when the adapter sends a frame past the cap", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root, "oversize"));
    await test.enable();
    const sessionId = await startedSession(test);
    await test.waitFor(
      sessionId,
      (result) => result.status === "state" && result.state.status === "stopped",
    );
    await test.ask(sessionId, { kind: "threads" });
    expect(await test.ask(sessionId, { kind: "state" })).toMatchObject({
      status: "state",
      state: { status: "ended", endReason: "protocol-violation" },
    });
    expect(test.service.running).toBe(0);
  });

  it("ends at once when the thread moves to Plan, its posture changes its network, or the adapter's package changes", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();

    const sessionId = await startedSession(test);
    test.threads[0] = { ...test.thread(), executionPolicy: "plan" };
    await test.service.sweep();
    expect(await test.ask(sessionId, { kind: "state" })).toMatchObject({
      state: { status: "ended", endReason: "plan-read-only" },
    });

    test.threads[0] = { ...test.thread(), executionPolicy: "approval-gated" };
    const second = await test.start(test.configuration());
    if (second.status !== "started") throw new Error(`not started: ${JSON.stringify(second)}`);
    // One session per thread: a second Start waits for the first to stop.
    expect(await test.start(test.configuration())).toEqual({
      status: "busy",
      reason: "thread-has-session",
    });
    test.threads[0] = { ...test.thread(), executionPolicy: "full-access" };
    await test.service.sweep();
    expect(await test.ask(second.sessionId, { kind: "state" })).toMatchObject({
      state: { status: "ended", endReason: "network-changed" },
    });

    // Full access the window holds for its session keeps the open network
    // while the grant stands, and ends the session when it goes.
    test.threads[0] = { ...test.thread(), executionPolicy: "approval-gated" };
    test.windowGrant.fullAccess = true;
    const granted = await test.start(test.configuration());
    if (granted.status !== "started") throw new Error(`not started: ${JSON.stringify(granted)}`);
    await test.service.sweep();
    expect(test.service.running).toBe(1);
    test.windowGrant.fullAccess = false;
    await test.service.sweep();
    expect(await test.ask(granted.sessionId, { kind: "state" })).toMatchObject({
      state: { status: "ended", endReason: "network-changed" },
    });

    const third = await test.start(test.configuration());
    if (third.status !== "started") throw new Error(`not started: ${JSON.stringify(third)}`);
    await test.switchComponent(false);
    await test.service.sweep();
    expect(await test.ask(third.sessionId, { kind: "state" })).toMatchObject({
      state: { status: "ended", endReason: "approval-ended" },
    });
    expect(test.journal.sessions().map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endReason: "plan-read-only" }),
        expect.objectContaining({ endReason: "network-changed" }),
        expect.objectContaining({ endReason: "approval-ended" }),
      ]),
    );
  });

  it("starts an unconfirmed configuration at Full access, keeps it running, and ends it when the thread leaves Full access", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const value = test.configuration();

    test.threads[0] = { ...test.thread(), executionPolicy: "full-access" };
    const started = await test.start(value);
    if (started.status !== "started") throw new Error(`not started: ${JSON.stringify(started)}`);
    expect(test.journal.approvals()).toHaveLength(0);
    // Nothing confirmed the configuration, and at Full access nothing has to.
    await test.service.sweep();
    expect(test.service.running).toBe(1);
    expect(await test.ask(started.sessionId, { kind: "state" })).not.toMatchObject({
      state: { status: "ended" },
    });
    // A paired device still starts nothing, whatever the level.
    expect(await test.start(value, "remote-device")).toEqual({
      status: "refused",
      reason: "local-host-required",
    });

    test.threads[0] = { ...test.thread(), executionPolicy: "approval-gated" };
    await test.service.sweep();
    expect(await test.ask(started.sessionId, { kind: "state" })).toMatchObject({
      state: { status: "ended", endReason: "network-changed" },
    });
    // Below Full access the same configuration is a proposal again.
    expect(await test.start(value)).toEqual({ status: "refused", reason: "approval-required" });
  });

  it("ends at once when the window whose own Full access it ran under moves the thread to Plan", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const unsubscribe = test.service.endOnAuthorityChanges(test.journalStore);
    try {
      test.windowGrant.fullAccess = true;
      const sessionId = await startedSession(test);
      const confirmed = test.approvalStore.approvals(test.thread().projectId)[0];
      if (confirmed === undefined) throw new Error("no confirmation");
      // As the access command does it: the thread's event is committed first,
      // and only then does the window lose its session grant.
      test.threads[0] = { ...test.thread(), executionPolicy: "plan" };
      expect(
        test.approvalStore.record({
          projectId: test.thread().projectId,
          checkoutId: test.thread().checkoutId,
          configuration: test.configuration({ name: "Another" }),
          configurationDigest: decodeCodeDebugConfigurationDigest(`sha256:${"f".repeat(64)}`),
          adapter: confirmed.adapter,
          scope: "checkout",
        }),
      ).toBe("recorded");
      test.windowGrant.fullAccess = false;
      const deadline = Date.now() + 10_000;
      while (test.service.running > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(test.service.running).toBe(0);
      expect(test.journal.sessions().at(-1)?.payload).toMatchObject({
        sessionId,
        endReason: "plan-read-only",
      });
    } finally {
      unsubscribe();
    }
  });

  it("launches nothing for a Start that the host's stop overtook", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const value = test.configuration();
    expect(await test.approve(value)).toMatchObject({ status: "approved" });
    const pending = test.start(value);
    await test.service.close();
    expect(await pending).toEqual({ status: "failed", reason: "launch-failed" });
    expect(test.launches()).toBe(0);
    expect(test.journal.sessions()).toEqual([]);
  });

  it("ends when the thread stops being active or is purged, its Project is erased, or the host stops, and never restarts on its own", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();

    const first = await startedSession(test);
    test.threads[0] = { ...test.thread(), lifecycle: "archived" };
    await test.service.sweep();
    test.threads[0] = { ...test.thread(), lifecycle: "active" };
    expect(await test.ask(first, { kind: "state" })).toMatchObject({
      state: { status: "ended", endReason: "thread-inactive" },
    });

    // A thread purge ends the session before it takes the session's records.
    const purged = await test.start(test.configuration());
    if (purged.status !== "started") throw new Error(`not started: ${JSON.stringify(purged)}`);
    await test.service.endThread(test.thread().id);
    expect(test.service.running).toBe(0);
    expect(test.journal.sessions().at(-1)?.payload).toMatchObject({
      sessionId: purged.sessionId,
      endReason: "thread-inactive",
    });

    const second = await test.start(test.configuration());
    if (second.status !== "started") throw new Error(`not started: ${JSON.stringify(second)}`);
    await test.service.endProject(test.thread().projectId);
    expect(await test.ask(second.sessionId, { kind: "stop" })).toEqual({
      status: "ended",
      endReason: "project-erased",
    });

    const third = await test.start(test.configuration());
    if (third.status !== "started") throw new Error(`not started: ${JSON.stringify(third)}`);
    // The person's Stop ends it; a session that ended is not started again.
    expect(await test.ask(third.sessionId, { kind: "stop" })).toEqual({
      status: "ended",
      endReason: "stopped",
    });
    expect(await test.ask(third.sessionId, { kind: "threads" })).toEqual({
      status: "ended",
      endReason: "stopped",
    });

    const fourth = await test.start(test.configuration());
    if (fourth.status !== "started") throw new Error(`not started: ${JSON.stringify(fourth)}`);
    await test.service.close();
    expect(test.service.running).toBe(0);
    expect(test.journal.sessions().at(-1)?.payload).toMatchObject({ endReason: "host-shutdown" });
    expect(test.launches()).toBe(5);
  });

  it("is reaped, and its record closed, by a restarted host", async () => {
    const test = await host(passthrough);
    // A capsule a host left running when it stopped without ending it.
    const adapter = join(test.root, "lingering-adapter");
    writeFileSync(adapter, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const sessionId = randomUUID();
    const launched = await test.processPort().launch({
      sessionId,
      executable: adapter,
      installRoot: test.root,
      checkoutRoot: test.checkout,
      stateRoot: join(test.root, "state"),
      network: { kind: "allow" },
      environment: [],
    });
    if (launched.status !== "launched") throw new Error(`not launched: ${launched.status}`);
    expect(
      test.records.started({
        sessionId: decodeCodeDebugSessionId(sessionId),
        projectId: test.thread().projectId,
        threadId: test.thread().id,
        checkoutId: test.thread().checkoutId,
        configurationDigest: decodeCodeDebugConfigurationDigest(`sha256:${"c".repeat(64)}`),
        network: "allow",
      }),
    ).toBe("recorded");
    let exited = false;
    void launched.process.exited.then(() => {
      exited = true;
    });
    // The next host's port over the same receipts reaps the capsule, and its
    // record is closed before any session starts.
    await test.processPort().reconcile();
    await launched.process.exited;
    expect(exited).toBe(true);
    expect(test.records.endLeftOpen()).toBe(1);
    expect(test.journal.sessions().at(-1)?.payload).toMatchObject({
      sessionId,
      endReason: "host-restarted",
    });
    expect(test.records.endLeftOpen()).toBe(0);
  });
});

/** What the fixture adapter did with its children, in order. */
function adapterLog(test: Host): ReadonlyArray<string> {
  const path = join(test.checkout, "adapter-log.txt");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

/**
 * Starts a children fixture under Full access, where the capsule shares the
 * host's loopback on Linux too, so the passthrough launch reaches the child
 * port on either platform. `env` is the configuration's environment, which
 * tells the fixture what to announce.
 */
async function childrenSession(
  test: Host,
  env: Readonly<Record<string, string>> = {},
): Promise<CodeDebugSessionId> {
  test.windowGrant.fullAccess = true;
  return startedSession(
    test,
    test.configuration({
      env: Object.entries(env).map(([key, value]) => ({ key, value })),
    }),
  );
}

const childList = (result: CodeDebugSessionResult) =>
  result.status === "state" ? (result.children ?? []) : [];

describe("a debug session's child processes", () => {
  it("attaches a child the adapter announces by its declared event, stops it at the window's breakpoint, and ends it before the session", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root, "children-event"));
    await test.enable();
    const sessionId = await childrenSession(test);
    await test.waitFor(sessionId, (result) => childList(result).length === 1);
    await test.waitFor(
      sessionId,
      (result) => result.status === "state" && result.state.status === "stopped",
      1,
    );
    expect(childList(await test.ask(sessionId, { kind: "state" }))).toEqual([
      { child: 1, name: "Child process 1", status: "stopped" },
    ]);
    const stack = await test.ask(
      sessionId,
      { kind: "stack-trace", programThreadId: 1 },
      undefined,
      1,
    );
    if (stack.status !== "stack") throw new Error(JSON.stringify(stack));
    expect(stack.frames[0]).toMatchObject({
      name: "child (src/main.js)",
      location: { kind: "checkout", path: "src/main.js", line: 42 },
    });
    // The host sent `attach` with the announced configuration, its `connect` removed.
    expect(adapterLog(test)).toContain("child 1 attached");

    expect(await test.ask(sessionId, { kind: "stop" })).toEqual({
      status: "ended",
      endReason: "stopped",
    });
    const log = adapterLog(test);
    expect(log.indexOf("child 1 disconnected")).toBeGreaterThan(-1);
    expect(log.indexOf("child 1 disconnected")).toBeLessThan(log.indexOf("session disconnected"));
    const ended = test.journal.sessions().at(-1);
    expect(ended).toMatchObject({
      eventName: "code.debug-session-ended@1",
      payload: { endReason: "stopped", childSessions: 1 },
    });
    // Nothing of the child is journaled: no name, no value, no output.
    const everything = JSON.stringify(test.journal.all());
    expect(everything).not.toContain("Child process 1");
    expect(everything).not.toContain("hunter2-session-value");
  });

  it("attaches a child announced by the standard startDebugging request, and stopping the child leaves the session running", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root, "children-start-debugging"));
    await test.enable();
    const sessionId = await childrenSession(test);
    await test.waitFor(
      sessionId,
      (result) => result.status === "state" && result.state.status === "stopped",
      1,
    );
    expect(Object.fromEntries(test.service.refusedAdapterRequests(sessionId))).toEqual({});
    expect(await test.ask(sessionId, { kind: "stop" }, undefined, 1)).toEqual({
      status: "ended",
      endReason: "stopped",
    });
    expect(adapterLog(test)).toContain("child 1 disconnected");
    expect(adapterLog(test)).not.toContain("session disconnected");
    const state = await test.ask(sessionId, { kind: "state" });
    expect(state).toMatchObject({ status: "state", children: [] });
    expect(state.status === "state" && state.state.status).not.toBe("ended");
    // A child that has ended reads as no session; the panel goes back to the program.
    expect(await test.ask(sessionId, { kind: "threads" }, undefined, 1)).toEqual({
      status: "refused",
      reason: "no-session",
    });
  });

  it("refuses an announcement that names another port or a host off loopback, and connects nowhere", async () => {
    const listener = await hostListener();
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root, "children-event"));
    await test.enable();
    const sessionId = await childrenSession(test, { FIXTURE_ANNOUNCE_PORT: String(listener.port) });
    await stoppedAt(42)(test, sessionId);
    expect(await test.ask(sessionId, { kind: "state" })).toMatchObject({
      children: [],
      undebuggedChildren: 1,
    });
    expect(listener.connections()).toBe(0);
    expect(adapterLog(test)).not.toContain("child 1 attached");
    await test.ask(sessionId, { kind: "stop" });

    const offLoopback = await childrenSession(test, { FIXTURE_ANNOUNCE_HOST: "example.com" });
    await stoppedAt(42)(test, offLoopback);
    expect(await test.ask(offLoopback, { kind: "state" })).toMatchObject({
      children: [],
      undebuggedChildren: 1,
    });
    expect(adapterLog(test)).not.toContain("child 1 attached");
  });

  it("debugs at most eight children at once and thirty-two over a session, and the rest run undebugged", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root, "children-event"));
    await test.enable();
    const burst = await childrenSession(test, { FIXTURE_CHILDREN: "10" });
    await test.waitFor(
      burst,
      (result) =>
        childList(result).length === 8 &&
        result.status === "state" &&
        result.undebuggedChildren === 2,
    );
    await test.ask(burst, { kind: "stop" });

    const serial = await childrenSession(test, {
      FIXTURE_CHILDREN: "40",
      FIXTURE_CHILD_GAP_MS: "300",
      FIXTURE_CHILD_EXITS: "1",
    });
    await test.waitFor(
      serial,
      (result) => result.status === "state" && result.undebuggedChildren === 8,
    );
    await test.ask(serial, { kind: "stop" });
    expect(test.journal.sessions().at(-1)).toMatchObject({
      payload: { endReason: "stopped", childSessions: 32 },
    });
  }, 60_000);

  it("drops an announcement from an adapter that declared no children", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root, "children-event", { declareChildren: false }));
    await test.enable();
    const undeclared = await childrenSession(test);
    await stoppedAt(42)(test, undeclared);
    const state = await test.ask(undeclared, { kind: "state" });
    expect(state.status === "state" && state.children).toBeUndefined();
    expect(adapterLog(test)).toContain("child 1 announced");
    expect(adapterLog(test)).not.toContain("child 1 attached");
    await test.ask(undeclared, { kind: "stop" });
    expect(test.journal.sessions().at(-1)?.payload).not.toHaveProperty("childSessions");
  });

  it("drops an announcement the adapter makes while the session ends", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root, "children-event"));
    await test.enable();
    const sessionId = await childrenSession(test, {
      FIXTURE_CHILDREN: "0",
      FIXTURE_ANNOUNCE_ON_DISCONNECT: "1",
    });
    await stoppedAt(42)(test, sessionId);
    await test.ask(sessionId, { kind: "stop" });
    expect(adapterLog(test)).toContain("child 99 announced");
    expect(adapterLog(test)).not.toContain("child 99 attached");
    expect(test.journal.sessions().at(-1)).toMatchObject({ payload: { childSessions: 0 } });
  });
});

describe("a debug session under confinement", () => {
  it.runIf(bubblewrap || seatbelt)(
    "stops at a breakpoint, shows its stack and variables, steps, continues, and exits, while its program cannot write outside the checkout or reach a host no rule allows",
    async () => {
      const listener = await hostListener();
      const test = await host(makeProcessConfinementLive(), { hostPort: listener.port });
      await test.install(adapterFolder(test.root));
      await test.enable();
      const value = test.configuration();
      expect(await test.start(value)).toEqual({ status: "refused", reason: "approval-required" });
      expect(test.launches()).toBe(0);

      const sessionId = await startedSession(test, value);
      const stack = await stoppedAt(42)(test, sessionId);
      expect(stack.frames.slice(1).map((frame) => frame.location)).toEqual([
        { kind: "outside-checkout", label: "elsewhere", line: 10 },
        { kind: "outside-checkout", label: "adapter-source", sourceReference: 7, line: 1 },
      ]);
      // A host path in a frame's name never leaves the host.
      expect(stack.frames[0]?.name).toBe("main (src/main.js)");

      const scopes = await test.ask(sessionId, { kind: "scopes", frameId: 1 });
      expect(scopes).toMatchObject({ status: "scopes", scopes: [{ name: "Locals" }] });
      const variables = await test.ask(sessionId, { kind: "variables", variablesReference: 1000 });
      expect(variables).toMatchObject({
        status: "variables",
        variables: [
          { name: "count", value: "42", truncated: false },
          { name: "secret", value: "hunter2-session-value" },
          { name: "nested", variablesReference: 1003 },
        ],
      });
      expect(
        await test.ask(sessionId, { kind: "evaluate", expression: "count", context: "repl" }),
      ).toMatchObject({
        status: "evaluated",
        result: { name: "count", value: "42" },
      });
      expect(
        await test.ask(sessionId, { kind: "evaluate", expression: "missing", context: "repl" }),
      ).toEqual({
        status: "unavailable",
        reason: "failed",
        message: "name 'missing' is not defined in src/main.js",
      });
      expect(await test.ask(sessionId, { kind: "source", sourceReference: 7 })).toEqual({
        status: "source",
        text: "// generated by the adapter\n",
        truncated: false,
      });

      // Step to the program's last checkpoint, which reports what it tried.
      expect(await test.ask(sessionId, { kind: "next", programThreadId: 1 })).toEqual({
        status: "done",
      });
      await test.waitFor(
        sessionId,
        (result) =>
          result.status === "state" &&
          result.state.status === "stopped" &&
          result.state.reason === "step",
      );
      const attempts = await test.ask(sessionId, { kind: "variables", variablesReference: 1001 });
      if (attempts.status !== "variables") throw new Error(JSON.stringify(attempts));
      const outcome = Object.fromEntries(
        attempts.variables.map((entry) => [entry.name, entry.value]),
      );
      expect(outcome.writeCheckout).toBe("wrote");
      expect(outcome.writeOutside).toMatch(/^refused /);
      expect(outcome.reachHost).toMatch(/^refused /);
      expect(outcome.proxyPublic).toBe("status 403");
      expect(existsSync(test.outsideMarker)).toBe(false);
      expect(existsSync(join(test.checkout, "written-by-program.txt"))).toBe(true);
      expect(listener.connections()).toBe(0);

      expect(await test.ask(sessionId, { kind: "continue", programThreadId: 1 })).toEqual({
        status: "done",
      });
      const ended = await test.waitFor(
        sessionId,
        (result) => result.status === "state" && result.state.status === "ended",
      );
      expect(ended).toMatchObject({ state: { endReason: "program-exited", exitCode: 0 } });

      // The program's output reached the session with host paths rewritten.
      // The refused connection is journaled on the session's own egress
      // aggregate and proposed on the thread's Network access list.
      expect(test.journal.egress().map((event) => event.eventName)).toEqual(
        expect.arrayContaining([
          "code.debug-egress-launch-started@1",
          "code.debug-egress-launch-summarized@1",
        ]),
      );
      expect(JSON.stringify(test.journal.egress())).toContain("example.com");
      expect(
        test.journal
          .threadEgress()
          .filter((event) => event.eventName === "thread.egress-proposal-raised@1")
          .map((event) => event.payload),
      ).toEqual([expect.objectContaining({ host: "example.com", port: 443 })]);
      expect(test.journal.sessions().map((event) => event.eventName)).toEqual([
        "code.debug-session-started@1",
        "code.debug-session-ended@1",
      ]);
      // No value the program held, and none of its output, is journaled.
      const everything = JSON.stringify(test.journal.all());
      expect(everything).not.toContain("hunter2-session-value");
      expect(everything).not.toContain("counted 42");
    },
    60_000,
  );

  it.runIf(bubblewrap)(
    "connects a child through the relay socket it held before the adapter ran, not one the capsule swapped in",
    async () => {
      const outside = join(realpathSync(tmpdir()), `octant-outside-${randomUUID()}.sock`);
      let reached = 0;
      const listener = createServer((socket) => {
        reached += 1;
        socket.destroy();
      });
      listeners.push(listener);
      markers.push(outside);
      await new Promise<void>((resolve) => listener.listen(outside, resolve));
      const test = await host(makeProcessConfinementLive());
      await test.install(adapterFolder(test.root, "children-event"));
      await test.enable();
      const sessionId = await startedSession(
        test,
        test.configuration({ env: [{ key: "FIXTURE_SWAP_RELAY", value: outside }] }),
      );
      await test.waitFor(
        sessionId,
        (result) => result.status === "state" && result.state.status === "stopped",
        1,
      );
      expect(adapterLog(test)).toEqual(
        expect.arrayContaining(["relay swapped", "child 1 attached"]),
      );
      expect(reached).toBe(0);
    },
    60_000,
  );

  it.runIf(bubblewrap || seatbelt)(
    "attaches a child in the session's capsule, which stops at a breakpoint, cannot write outside the checkout, and reaches no host its rules refuse",
    async () => {
      const listener = await hostListener();
      const test = await host(makeProcessConfinementLive(), { hostPort: listener.port });
      await test.install(adapterFolder(test.root, "children-event"));
      await test.enable();
      const sessionId = await startedSession(test);
      await test.waitFor(
        sessionId,
        (result) =>
          result.status === "state" &&
          result.state.status === "stopped" &&
          result.state.reason === "breakpoint",
        1,
      );
      const stack = await test.ask(
        sessionId,
        { kind: "stack-trace", programThreadId: 1 },
        undefined,
        1,
      );
      if (stack.status !== "stack") throw new Error(JSON.stringify(stack));
      expect(stack.frames[0]?.location).toMatchObject({
        kind: "checkout",
        path: "src/main.js",
        line: 42,
      });
      expect(await test.ask(sessionId, { kind: "next", programThreadId: 1 }, undefined, 1)).toEqual(
        {
          status: "done",
        },
      );
      await test.waitFor(
        sessionId,
        (result) =>
          result.status === "state" &&
          result.state.status === "stopped" &&
          result.state.reason === "step",
        1,
      );
      const attempts = await test.ask(
        sessionId,
        { kind: "variables", variablesReference: 1001 },
        undefined,
        1,
      );
      if (attempts.status !== "variables") throw new Error(JSON.stringify(attempts));
      const outcome = Object.fromEntries(
        attempts.variables.map((entry) => [entry.name, entry.value]),
      );
      expect(outcome.writeOutside).toMatch(/^refused /);
      expect(outcome.reachHost).toMatch(/^refused /);
      expect(outcome.proxyPublic).toBe("status 403");
      expect(existsSync(test.outsideMarker)).toBe(false);
      expect(listener.connections()).toBe(0);

      await test.ask(sessionId, { kind: "stop" });
      const log = adapterLog(test);
      expect(log.indexOf("child 1 disconnected")).toBeLessThan(log.indexOf("session disconnected"));
      expect(test.journal.sessions().at(-1)).toMatchObject({ payload: { childSessions: 1 } });
    },
    60_000,
  );
});

const agentAuthority = decodeToolActionAuthority({
  hostId: "11111111-1111-4111-8111-111111111111",
  mode: "code",
  projectId: "40000000-0000-4000-8000-000000000001",
  rootId: "70000000-0000-4000-8000-000000000001",
  worktreeId: "30000000-0000-4000-8000-000000000001",
  providerInstanceId: "60000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
});

/**
 * The agent's tool for one turn of the fixture thread, with the person's
 * answers scripted. `turn` is the posture the turn runs at when it is
 * narrower than the thread's.
 */
function agentTools(
  test: Host,
  options: {
    readonly answer?: "approved" | "denied";
    readonly turn?: CodeThread["executionPolicy"];
    readonly approvals?: ReturnType<typeof createCodeDebugAgentSessionApprovals>;
  } = {},
) {
  const asked: string[] = [];
  const marks: RecordExternalContentIngestionInput[] = [];
  const turnThread = (): CodeThread => {
    const effective = test.windowGrant.fullAccess
      ? { ...test.thread(), executionPolicy: "full-access" as const }
      : test.thread();
    return options.turn === undefined ? effective : { ...effective, executionPolicy: options.turn };
  };
  const set = createCodeDebugAgentTools({
    windowId: scopeId,
    thread: turnThread(),
    readThread: turnThread,
    authority: () => agentAuthority,
    externalContentIngested: () => marks.length > 0,
    recordExternalContentIngestion: (mark) => {
      marks.push(mark);
      return { kind: "ignored", reason: "not-tainting" };
    },
    debug: test.service,
    approvals: options.approvals ?? createCodeDebugAgentSessionApprovals(),
    askPerson: async (summary) => {
      asked.push(summary);
      return options.answer ?? "approved";
    },
    uuid: randomUUID,
  });
  const call = async (value: unknown) => {
    if (set === undefined) throw new Error("the debug tool is not offered");
    const outcome = await set.execute({ name: "octant_debug", inputJson: JSON.stringify(value) });
    return { ...outcome, result: outcome.result as Record<string, unknown> };
  };
  return { set, call, asked, marks };
}

/** The digest the tool lists for the configuration named `name`. */
async function listedDigest(
  tools: ReturnType<typeof agentTools>,
  name = "Run the fixture",
): Promise<string> {
  const listed = await tools.call({ operation: "configurations" });
  const found = (
    listed.result.configurations as ReadonlyArray<{ name: string; configuration: string }>
  ).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`not listed: ${JSON.stringify(listed.result)}`);
  return found.configuration;
}

describe("the agent's debug tool", () => {
  it("is offered only outside Plan, where an adapter is effective and a profile allows it", async () => {
    const test = await host(passthrough);
    // No adapter is installed: nothing could start, so nothing is offered.
    expect(agentTools(test).set).toBeUndefined();
    await test.install(adapterFolder(test.root));
    // Installed but not trusted or switched on.
    expect(agentTools(test).set).toBeUndefined();
    await test.enable();
    expect(agentTools(test).set?.definitions.map((definition) => definition.name)).toEqual([
      "octant_debug",
    ]);
    // A turn narrowed to Plan on a thread that is not in Plan.
    expect(agentTools(test, { turn: "plan" }).set).toBeUndefined();
    test.threads[0] = { ...test.thread(), toolConstraints: ["octant_code"] };
    expect(agentTools(test).set).toBeUndefined();
    test.threads[0] = { ...test.thread(), toolConstraints: ["octant_debug"] };
    expect(agentTools(test).set).toBeDefined();
  });

  it("refuses every operation once the turn's thread is in Plan, and launches nothing", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    expect(await test.approve(test.configuration())).toMatchObject({ status: "approved" });
    const tools = agentTools(test);
    const digest = await listedDigest(tools);
    test.threads[0] = { ...test.thread(), executionPolicy: "plan" };
    for (const operation of [
      { operation: "configurations" },
      { operation: "start", configuration: digest },
      { operation: "state" },
      { operation: "evaluate", expression: "count" },
    ]) {
      expect(await tools.call(operation)).toMatchObject({
        isError: true,
        result: { error: "plan-read-only" },
      });
    }
    expect(tools.asked).toEqual([]);
    expect(test.launches()).toBe(0);
  });

  it("below Full access starts a configuration nobody confirmed on one answer, whose card shows the program, arguments, folder and environment names", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    mkdirSync(join(test.checkout, ".vscode"));
    writeFileSync(
      join(test.checkout, ".vscode", "launch.json"),
      JSON.stringify({
        configurations: [
          {
            type: "fixture",
            request: "launch",
            name: "From the repository",
            program: `\${workspaceFolder}/src/main.js`,
            args: ["--verbose", "--key", "AKIAIOSFODNN7EXAMPLE"],
            cwd: `\${workspaceFolder}/src`,
            env: { FIXTURE_MODE: "value-the-card-never-shows", API_TOKEN: "another-value" },
          },
        ],
      }),
    );
    // Nothing is confirmed, and the repository's proposal is listed all the same.
    const denied = agentTools(test, { answer: "denied" });
    expect((await denied.call({ operation: "configurations" })).result).toMatchObject({
      configurations: [
        {
          name: "From the repository",
          program: "src/main.js",
          cwd: "src",
          // The listing names the environment's keys and never its values.
          env: ["FIXTURE_MODE", "API_TOKEN"],
          source: "launch-file",
        },
      ],
    });
    const digest = await listedDigest(denied, "From the repository");
    expect(await denied.call({ operation: "start", configuration: digest })).toMatchObject({
      isError: true,
      result: { error: "approval-denied" },
    });
    expect(denied.asked).toHaveLength(1);
    const card = denied.asked[0] ?? "";
    expect(card).toContain('"From the repository"');
    expect(card).toContain("Program: src/main.js");
    expect(card).toContain("Arguments: --verbose --key");
    expect(card).toContain("Working directory: src");
    expect(card).toContain("Environment variables (values not shown): FIXTURE_MODE, API_TOKEN");
    expect(card).toContain("the repository's launch file");
    expect(card).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(card).not.toContain("value-the-card-never-shows");
    expect(card).not.toContain("another-value");
    expect(test.launches()).toBe(0);
    // A turn narrowed below a Full-access thread asks the same way.
    test.windowGrant.fullAccess = true;
    const narrowed = agentTools(test, { turn: "approval-gated", answer: "denied" });
    expect(await narrowed.call({ operation: "start", configuration: digest })).toMatchObject({
      isError: true,
      result: { error: "approval-denied" },
    });
    expect(narrowed.asked).toHaveLength(1);
    test.windowGrant.fullAccess = false;
    expect(test.launches()).toBe(0);
    // A window's own Start still needs its confirmation.
    const proposal = await test.configurations();
    if (proposal.status !== "listed" || proposal.launchFile.status !== "read") {
      throw new Error(`no launch file read: ${JSON.stringify(proposal)}`);
    }
    const [proposed] = proposal.launchFile.proposals;
    if (proposed?.status !== "proposed") throw new Error("no proposal");
    expect(await test.start(proposed.configuration)).toEqual({
      status: "refused",
      reason: "approval-required",
    });

    const tools = agentTools(test);
    const started = await tools.call({
      operation: "start",
      configuration: digest,
      breakpoints: [{ path: "src/main.js", lines: [42] }],
    });
    // The breakpoint is hit before the start answers.
    expect(started).toMatchObject({
      isError: false,
      result: { started: "From the repository", session: "stopped", reason: "breakpoint" },
    });
    expect(tools.asked).toHaveLength(1);
    expect(test.launches()).toBe(1);
    // Control and reads of the answered session ask nothing more, and it goes
    // on with no confirmation on record.
    const stack = await tools.call({ operation: "stack" });
    expect((stack.result.frames as ReadonlyArray<unknown>)[0]).toMatchObject({
      path: "src/main.js",
      line: 42,
    });
    expect(
      await tools.call({ operation: "breakpoints", path: "src/main.js", lines: [] }),
    ).toMatchObject({ isError: false, result: { breakpoints: [] } });
    expect((await tools.call({ operation: "step-over" })).result).toMatchObject({
      session: "stopped",
      reason: "step",
    });
    // The reads above marked the thread; the one answer covers an expression too.
    expect(tools.marks.length).toBeGreaterThan(0);
    expect((await tools.call({ operation: "evaluate", expression: "count" })).isError).toBe(false);
    expect(tools.asked).toHaveLength(1);
    // A second start is refused while the thread holds a session, unasked.
    expect(await tools.call({ operation: "start", configuration: digest })).toMatchObject({
      isError: true,
      result: { error: "thread-has-session" },
    });
    expect(tools.asked).toHaveLength(1);

    // The person's window lists the session the agent started, and stops it.
    const listed = await test.configurations();
    if (listed.status !== "listed" || listed.session === undefined) {
      throw new Error(`no session listed: ${JSON.stringify(listed)}`);
    }
    expect(listed.session.name).toBe("From the repository");
    expect(await test.ask(listed.session.sessionId, { kind: "stop" })).toEqual({
      status: "ended",
      endReason: "stopped",
    });
    // The agent learns the person stopped it, and can do nothing more with it.
    expect(await tools.call({ operation: "state" })).toMatchObject({
      isError: false,
      result: { session: "ended", endReason: "stopped" },
    });
    expect(await tools.call({ operation: "threads" })).toMatchObject({
      isError: true,
      result: { error: "no-session" },
    });
    expect((await test.configurations()) as { session?: unknown }).not.toHaveProperty("session");
  });

  it("at Full access starts the repository's proposal unasked, reads bounded variables as outside content, and stops", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const program = readFileSync(join(test.checkout, "src", "main.js"), "utf8");
    const locals = 'nested: { inner: "deep" } }';
    expect(program).toContain(locals);
    // More locals than one read lists, one longer than a value may be, and a key.
    writeFileSync(
      join(test.checkout, "src", "main.js"),
      program.replace(
        locals,
        'nested: { inner: "deep" }, long: "x".repeat(5000), key: "AKIAIOSFODNN7EXAMPLE", ...Object.fromEntries(Array.from({ length: 80 }, (_, index) => ["v" + index, index])) }',
      ),
    );
    mkdirSync(join(test.checkout, ".vscode"));
    writeFileSync(
      join(test.checkout, ".vscode", "launch.json"),
      JSON.stringify({
        configurations: [
          {
            type: "fixture",
            request: "launch",
            name: "From the repository",
            program: `\${workspaceFolder}/src/main.js`,
          },
        ],
      }),
    );
    test.threads[0] = { ...test.thread(), executionPolicy: "full-access" };
    const tools = agentTools(test);
    const digest = await listedDigest(tools, "From the repository");
    const started = await tools.call({
      operation: "start",
      configuration: digest,
      breakpoints: [{ path: "src/main.js", lines: [42, 50] }],
    });
    expect(started).toMatchObject({
      isError: false,
      result: { session: "stopped", reason: "breakpoint" },
    });
    expect(started.outsideContent).toBeDefined();
    expect(test.journal.approvals()).toHaveLength(0);

    const scopes = await tools.call({ operation: "scopes", frame: 1 });
    expect(scopes.result).toMatchObject({ scopes: [{ name: "Locals", reference: 1000 }] });
    const marksBefore = tools.marks.length;
    const variables = await tools.call({ operation: "variables", reference: 1000 });
    expect(variables.isError).toBe(false);
    expect(variables.outsideContent).toBeDefined();
    expect(tools.marks.length).toBeGreaterThan(marksBefore);
    expect(tools.marks.at(-1)).toMatchObject({
      threadId: test.thread().id,
      provenance: { origin: "tool-result", sourceLabel: "octant_debug" },
    });
    const listed = variables.result.variables as ReadonlyArray<{
      name: string;
      value: string;
      truncated?: boolean;
      reference?: number;
    }>;
    expect(listed).toHaveLength(50);
    expect(variables.result).toMatchObject({ truncated: true, next: 50 });
    const long = listed.find((entry) => entry.name === "long");
    expect(long?.value).toHaveLength(1024);
    expect(long?.truncated).toBe(true);
    // One level per read: a nested value is a reference, not its contents.
    expect(listed.find((entry) => entry.name === "nested")).toMatchObject({ reference: 1003 });
    expect(JSON.stringify(variables.result)).not.toContain("deep");
    // A key in a variable is redacted as it is in a command's output.
    expect(JSON.stringify(variables.result)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(Buffer.byteLength(JSON.stringify(variables.result))).toBeLessThan(64 * 1024);

    expect((await tools.call({ operation: "evaluate", expression: "count" })).result).toMatchObject(
      {
        result: { value: "42" },
      },
    );
    const continued = await tools.call({ operation: "continue" });
    expect(continued.result).toMatchObject({ session: "stopped", reason: "breakpoint" });
    const stack = await tools.call({ operation: "stack" });
    expect((stack.result.frames as ReadonlyArray<unknown>)[0]).toMatchObject({
      path: "src/main.js",
      line: 50,
    });
    // The program's output is read as the session's state, marked like the rest.
    const output = await tools.call({ operation: "state" });
    expect(JSON.stringify(output.result.output)).toContain("counted 42");
    expect(output.outsideContent).toBeDefined();
    expect(await tools.call({ operation: "stop" })).toMatchObject({
      isError: false,
      result: { session: "ended", endReason: "stopped" },
    });
    expect(tools.asked).toEqual([]);
    expect(test.service.running).toBe(0);
    // The journal names the thread's agent, not the person, for both acts.
    const actors = test.journalStore
      .replayAggregateType({
        aggregateType: CODE_DEBUG_SESSION_AGGREGATE,
        afterSequence: 0,
        limit: 10,
      })
      .map((event) => [String(event.eventName), event.actor.kind]);
    expect(actors).toEqual([
      ["code.debug-session-started@1", "agent"],
      ["code.debug-session-ended@1", "agent"],
    ]);
    // Nothing the session showed was journaled.
    const everything = JSON.stringify(test.journal.all());
    expect(everything).not.toContain("hunter2-session-value");
    expect(everything).not.toContain("counted 42");
  });

  it("asks once before touching a session the person started, and that answer covers expressions after the thread read outside content", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const sessionId = await startedSession(test);
    await stoppedAt(42)(test, sessionId);

    const approvals = createCodeDebugAgentSessionApprovals();
    const tools = agentTools(test, { approvals });
    expect((await tools.call({ operation: "state" })).result).toMatchObject({ session: "stopped" });
    expect(tools.asked).toHaveLength(1);
    expect(tools.asked[0]).toContain("Run the fixture");
    // The answer holds for the session on the thread's next turn too.
    const next = agentTools(test, { approvals });
    expect((await next.call({ operation: "threads" })).isError).toBe(false);
    expect(next.asked).toEqual([]);
    // That read marked the thread, and the session's answer still covers an expression.
    expect(next.marks.length).toBeGreaterThan(0);
    for (const expression of ["count", "secret"]) {
      expect((await next.call({ operation: "evaluate", expression })).isError).toBe(false);
    }
    expect((await next.call({ operation: "stack" })).isError).toBe(false);
    expect(next.asked).toEqual([]);

    // A session nobody answered for asks before an expression, and a refusal runs nothing.
    const declined = agentTools(test, {
      approvals: createCodeDebugAgentSessionApprovals(),
      answer: "denied",
    });
    expect(await declined.call({ operation: "evaluate", expression: "count" })).toMatchObject({
      isError: true,
      result: { error: "approval-denied" },
    });
    expect(declined.asked).toHaveLength(1);
  });

  it("asks a turn narrowed below Full access before it touches a session a Full access turn started unasked", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    expect(await test.approve(test.configuration())).toMatchObject({ status: "approved" });
    test.threads[0] = { ...test.thread(), executionPolicy: "full-access" };
    const approvals = createCodeDebugAgentSessionApprovals();
    const full = agentTools(test, { approvals });
    const started = await full.call({
      operation: "start",
      configuration: await listedDigest(full),
      breakpoints: [{ path: "src/main.js", lines: [42] }],
    });
    expect(started.result).toMatchObject({ session: "stopped" });
    expect(full.asked).toEqual([]);

    // Nobody answered for this session, so the narrower turn's first act asks.
    const narrowed = agentTools(test, { approvals, turn: "approval-gated" });
    expect((await narrowed.call({ operation: "stack" })).isError).toBe(false);
    expect(narrowed.asked).toHaveLength(1);
    expect((await narrowed.call({ operation: "threads" })).isError).toBe(false);
    expect(narrowed.asked).toHaveLength(1);
  });

  it("redacts a key held in a configuration's arguments from the listing", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const value = test.configuration({ args: ["--key", "AKIAIOSFODNN7EXAMPLE"] });
    expect(await test.approve(value)).toMatchObject({ status: "approved" });
    const listed = await agentTools(test).call({ operation: "configurations" });
    expect(listed.result).toMatchObject({ configurations: [{ name: "Run the fixture" }] });
    const text = JSON.stringify(listed.result);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("--key");
  });

  it("reads how the thread's last session ended after the program exits, until another starts", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    expect(await test.approve(test.configuration())).toMatchObject({ status: "approved" });
    const approvals = createCodeDebugAgentSessionApprovals();
    const tools = agentTools(test, { approvals });
    const digest = await listedDigest(tools);
    const start = {
      operation: "start",
      configuration: digest,
      breakpoints: [{ path: "src/main.js", lines: [42] }],
    };
    await tools.call(start);
    expect((await tools.call({ operation: "continue" })).result).toMatchObject({
      session: "ended",
    });
    // The session is gone; a later turn still learns how it ended.
    const later = agentTools(test, { approvals });
    expect(await later.call({ operation: "state" })).toMatchObject({
      isError: false,
      result: { session: "ended", endReason: "program-exited", exitCode: 0 },
    });
    expect(later.asked).toEqual([]);
    // A turn nobody answered for learns nothing of a session it never held.
    expect(await agentTools(test).call({ operation: "state" })).toMatchObject({
      isError: true,
      result: { error: "no-session" },
    });
    // Nothing but its state is read from a session that ended.
    expect(await later.call({ operation: "stack" })).toMatchObject({
      isError: true,
      result: { error: "no-session" },
    });
    await later.call(start);
    expect((await later.call({ operation: "state" })).result).toMatchObject({
      session: "stopped",
    });
  });

  it("refuses input outside its closed operations before anything is read or asked", async () => {
    const test = await host(passthrough);
    await test.install(adapterFolder(test.root));
    await test.enable();
    const tools = agentTools(test);
    for (const input of [
      { operation: "attach", pid: 1 },
      { operation: "start", configuration: { program: "/bin/sh", args: ["-c", "id"] } },
      { operation: "start", configuration: `sha256:${"a".repeat(64)}`, command: "id" },
      { operation: "variables", reference: 1000, depth: 9 },
      { operation: "evaluate" },
    ]) {
      expect(await tools.call(input)).toMatchObject({
        isError: true,
        result: { error: "invalid-tool-input" },
      });
    }
    expect(tools.asked).toEqual([]);
    expect(test.launches()).toBe(0);
  });
});
