import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCodeCheckoutIdentity,
  decodeCodeRelativePath,
  decodeCodeThread,
  decodeEventActor,
  type CodeFileId,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import {
  CODE_LANGUAGE_SERVER_APPROVAL_AGGREGATE,
  CODE_LANGUAGE_SERVER_EGRESS_AGGREGATE,
  type CodeLanguageApprovalScope,
} from "@octant/contracts/code-language";
import type { PrincipalKind } from "@octant/domain";
import type { ExtensionCommandResult, ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH } from "@octant/plugin-api/language-server-package";
import { CodexPluginPackageResolver } from "../extensions/codexPluginResolver";
import { ExtensionApiService } from "../extensions/extensionApiService";
import {
  ExtensionLifecycleService,
  NOOP_EXTENSION_SUPERVISOR,
} from "../extensions/extensionLifecycleService";
import { ExtensionPackageStore } from "../extensions/extensionPackageStore";
import { LocalPluginFolderRegistry } from "../extensions/localPluginFolderRegistry";
import { isExtensionCompatibilityCompatible } from "../extensions/packageInspector";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import { deriveCodeFileId } from "./codeFileIdentity";
import { CodeLanguageService } from "./codeLanguageService";
import { installedLanguageServerComponents } from "./installedLanguageServers";
import { LanguageServerApprovalStore } from "./languageServerApprovals";
import { createLanguageServerEgress } from "./languageServerEgress";
import { LanguageServerProcessPort } from "./languageServerProcess";

const now = "2026-10-26T12:00:00.000Z";
const scopeId = "10000000-0000-4000-8000-000000000001" as WindowId;
const repositoryId = `repo_${"a".repeat(64)}`;
const roots: string[] = [];
const services: CodeLanguageService[] = [];
const listeners: Server[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    listeners.splice(0).map((listener) => new Promise((resolve) => listener.close(resolve))),
  );
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

/**
 * A language server written for these tests: a `#!` script on the runtime
 * that runs the tests, so it needs nothing but its own interpreter. Asked for
 * diagnostics, a hostile one tries to run another program, reach this host
 * and the internet, and write the checkout, and reports what happened to each
 * attempt as one diagnostic; a benign one reports that it served.
 */
function serverScript(input: {
  readonly hostile: boolean;
  readonly hostPort: number;
  readonly marker: string;
}): string {
  return `#!${process.execPath}
"use strict";
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { connect } = require("node:net");
const { join } = require("node:path");
const { fileURLToPath } = require("node:url");
const HOSTILE = ${JSON.stringify(input.hostile)};
const HOST_PORT = ${JSON.stringify(input.hostPort)};
const MARKER = ${JSON.stringify(input.marker)};
let root = "/";
let buffered = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}

function code(error) {
  return "refused " + (error && error.code ? error.code : "error");
}

function runAnotherProgram() {
  try {
    const result = spawnSync("/bin/sh", ["-c", "echo escaped > " + MARKER], { timeout: 3000 });
    if (result.error) return code(result.error);
    return result.status === 0 ? "ran" : "refused exit " + String(result.status ?? result.signal);
  } catch (error) {
    return code(error);
  }
}

function reach(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("refused timeout");
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(code(error));
    });
  });
}

function write(path) {
  try {
    writeFileSync(path, "escaped\\n");
    return "wrote";
  } catch (error) {
    return code(error);
  }
}

async function attempts() {
  if (!HOSTILE) return [["served", "yes"]];
  return [
    ["run-program", runAnotherProgram()],
    ["reach-host", await reach("127.0.0.1", HOST_PORT)],
    ["reach-internet", await reach("1.1.1.1", 443)],
    ["write-checkout", write(join(root, "escaped.txt"))],
    ["write-cache", write(join(process.env.HOME || "/", "probe.txt"))],
  ];
}

async function handle(message) {
  if (message.method === "initialize") {
    root = fileURLToPath(message.params.rootUri);
    send({
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
        },
      },
    });
  } else if (message.method === "textDocument/diagnostic") {
    const outcomes = await attempts();
    send({
      id: message.id,
      result: {
        kind: "full",
        items: outcomes.map(([name, outcome], line) => ({
          range: { start: { line, character: 0 }, end: { line, character: 1 } },
          severity: 3,
          message: name + ": " + outcome,
        })),
      },
    });
  } else if (message.method === "shutdown") {
    send({ id: message.id, result: null });
  } else if (message.method === "exit") {
    process.exit(0);
  } else if (message.id !== undefined && message.method !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    const end = buffered.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const match = /Content-Length: (\\d+)/i.exec(buffered.subarray(0, end).toString("ascii"));
    if (match === null) process.exit(1);
    const length = Number(match[1]);
    if (buffered.length < end + 4 + length) return;
    const body = buffered.subarray(end + 4, end + 4 + length).toString("utf8");
    buffered = buffered.subarray(end + 4 + length);
    void handle(JSON.parse(body));
  }
});
`;
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

/** A person's folder holding one `static` Lua language server. */
function packageFolder(root: string, script: string, manifest: Record<string, unknown> = {}) {
  const folder = join(root, "lua-server");
  mkdirSync(join(folder, "bin"), { recursive: true });
  writeFileSync(join(folder, "bin", "lua-language-server"), script, { mode: 0o755 });
  writeFileSync(join(folder, "README.md"), "A Lua language server.\n");
  writeFileSync(
    join(folder, LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH),
    JSON.stringify({
      manifest: {
        manifestVersion: 1,
        slug: "lua-language",
        displayName: "Lua",
        version: "1.0.0",
        provenance: { publisher: "Example Lua", canonicalUrl: "https://example.com/lua" },
        license: { kind: "spdx", identifier: "MIT" },
        compatibility: { platforms: ["macos", "linux"], modes: ["code"], providerFamilies: [] },
        declaredCapabilities: ["filesystem"],
        components: [
          {
            id: "language-server",
            kind: "language-server",
            displayName: "Lua",
            declaredCapabilities: ["filesystem"],
            entryPoint: "bin/lua-language-server",
            languageServer: { languages: ["lua"], launchClass: "static" },
          },
        ],
        ...manifest,
      },
    }),
  );
  return folder;
}

async function host(
  confinement: ProcessConfinementPort,
  options: { readonly executionPolicy?: CodeThread["executionPolicy"] } = {},
) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "octant-installed-language-server-")));
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
  mkdirSync(checkout);
  writeFileSync(join(checkout, "main.lua"), 'print("hello")\n');
  const thread = decodeCodeThread({
    id: "20000000-0000-4000-8000-000000000001",
    projectId: "40000000-0000-4000-8000-000000000001",
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "Lua",
    lifecycle: "active",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: options.executionPolicy ?? "plan",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/lua",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const checkoutIdentity = decodeCodeCheckoutIdentity({
    id: thread.checkoutId,
    repositoryId,
    kind: "plain-folder",
    availability: "available",
    head: { kind: "none" },
    observedAt: now,
  });
  const threads: CodeThread[] = [thread];
  const components = installedLanguageServerComponents({
    snapshot: () => extensions.snapshot(),
    store,
    compatible: (compatibility) =>
      isExtensionCompatibilityCompatible(compatibility, "1.0.0", process.platform),
  });
  let launches = 0;
  const approvals = () =>
    new LanguageServerApprovalStore({
      journal,
      personActor: decodeEventActor({
        kind: "local-user",
        actorId: "50000000-0000-4000-8000-000000000001",
      }),
      uuid: randomUUID,
      clock: () => now,
    });
  const egressDirectory = join(root, "egress");
  mkdirSync(egressDirectory, { mode: 0o700 });
  const processes = new LanguageServerProcessPort({
    confinement,
    receiptDirectory: join(root, "receipts"),
    egress: createLanguageServerEgress({
      journal,
      // The Project allows no host: every connection the server asks for is
      // outside its rules.
      projectRules: () => [],
      endpoint:
        process.platform === "darwin"
          ? { kind: "loopback" }
          : { kind: "unix-socket", parentDirectory: egressDirectory },
      hostActor: decodeEventActor({
        kind: "system",
        actorId: "50000000-0000-4000-8000-000000000001",
      }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    }),
  });
  const service = new CodeLanguageService({
    approvals: approvals(),
    threadTainted: () => false,
    authority: {
      readThread: (threadId) =>
        threads.find((candidate) => String(candidate.id) === String(threadId)),
      readThreads: () => threads,
      readCheckout: (checkoutId) =>
        String(checkoutId) === String(checkoutIdentity.id) ? checkoutIdentity : undefined,
      canAccessProject: () => true,
      effectiveThread: (_scope, candidate) => candidate,
      resolveRoot: (_scope, candidate, current, relativePath) => ({
        fileId: deriveCodeFileId(String(candidate.id), String(current.id), relativePath),
        rootPath: checkout,
        rootIdentity: { device: "1", inode: "1" },
      }),
    },
    components,
    processes: {
      launch: (launch) => {
        launches += 1;
        return processes.launch(launch);
      },
    },
    platform: process.platform === "darwin" ? "macos" : "linux",
    cacheRoot: join(root, "cache"),
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
  return {
    root,
    checkout,
    store,
    service,
    thread,
    threads,
    journal: {
      approvals: () => journaled(CODE_LANGUAGE_SERVER_APPROVAL_AGGREGATE),
      egress: () => journaled(CODE_LANGUAGE_SERVER_EGRESS_AGGREGATE),
    },
    /** A store rebuilt from the journal, as a restarted host builds it. */
    reloadedApprovals: approvals,
    components,
    launches: () => launches,
    inspect: async (folder: string): Promise<ExtensionCommandResult> => {
      const registered = await folders.register(folder);
      return extensions.execute({ kind: "inspect-package", source: registered.source });
    },
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
    trust: (trusted: boolean) =>
      execute({
        kind: "set-source-trust",
        commandVersion: 1,
        extensionId: installed().extensionId,
        trusted,
        expectedStateVersion: installed().stateVersion,
      } as Parameters<ExtensionApiService["execute"]>[0]),
    enablePlugin: (desired: boolean) =>
      execute({
        kind: "set-plugin-desired",
        commandVersion: 1,
        extensionId: installed().extensionId,
        desired,
        expectedStateVersion: installed().stateVersion,
      } as Parameters<ExtensionApiService["execute"]>[0]),
    enableComponent: (desired: boolean) =>
      execute({
        kind: "set-component-desired",
        commandVersion: 1,
        extensionId: installed().extensionId,
        componentId: installed().components[0]?.component.id,
        desired,
        expectedStateVersion: installed().stateVersion,
      } as Parameters<ExtensionApiService["execute"]>[0]),
    open: (
      input: { readonly principal?: PrincipalKind; readonly threadId?: CodeThread["id"] } = {},
    ) =>
      service.syncDocument(
        { scopeId, principal: input.principal ?? "local-window" },
        {
          kind: "open",
          threadId: input.threadId ?? thread.id,
          checkoutId: checkoutIdentity.id,
          path: decodeCodeRelativePath("main.lua"),
          text: 'print("hello")\n',
        },
      ),
    approve: (
      scope: CodeLanguageApprovalScope,
      input: { readonly principal?: PrincipalKind; readonly threadId?: CodeThread["id"] } = {},
    ) =>
      service.approve(
        { scopeId, principal: input.principal ?? "local-window" },
        {
          threadId: input.threadId ?? thread.id,
          checkoutId: checkoutIdentity.id,
          path: decodeCodeRelativePath("main.lua"),
          scope,
        },
      ),
    diagnostics: (fileId: CodeFileId) =>
      service.read(
        { scopeId, principal: "local-window" },
        { kind: "diagnostics", threadId: thread.id, checkoutId: checkoutIdentity.id, fileId },
      ),
  };
}

/** A person's folder holding one Lua language server that runs the repository's tooling. */
function toolingFolder(root: string, script: string) {
  const capabilities = ["filesystem", "shell", "network"];
  return packageFolder(root, script, {
    declaredCapabilities: capabilities,
    components: [
      {
        id: "language-server",
        kind: "language-server",
        displayName: "Lua",
        declaredCapabilities: capabilities,
        entryPoint: "bin/lua-language-server",
        languageServer: { languages: ["lua"], launchClass: "repo-tooling" },
      },
    ],
  });
}

const passthrough: ProcessConfinementPort = {
  prepare: (input) => ({ command: input.executable, args: input.args }),
};

const benign = serverScript({ hostile: false, hostPort: 9, marker: "/nonexistent" });

describe("language servers a person adds", () => {
  it("names the binary, its digest, the languages, and the class in review, and installs it untrusted", async () => {
    const test = await host(passthrough);
    const folder = packageFolder(test.root, benign);
    const inspected = await test.inspect(folder);
    if (inspected.kind !== "package-inspected") {
      throw new Error(`package was not inspected: ${JSON.stringify(inspected)}`);
    }
    expect(inspected.preview.entry.source.kind).toBe("local-folder");
    expect(inspected.preview.review.provenance.reviewed).toBe(false);
    expect(inspected.preview.review.components).toEqual([
      {
        id: "language-server",
        kind: "language-server",
        displayName: "Lua",
        declaredCapabilities: ["filesystem"],
        languageServer: {
          languages: ["lua"],
          launchClass: "static",
          binary: "bin/lua-language-server",
          binaryDigest: `sha256:${createHash("sha256").update(benign).digest("hex")}`,
        },
      },
    ]);

    const installed = await test.install(folder);
    expect(installed.activation).toMatchObject({ trusted: false, pluginDesired: false });
    expect(installed.components[0]?.effectiveState).toEqual({
      kind: "blocked",
      reason: "untrusted",
    });
  });

  it("reviews a server that runs the repository's tooling by its class, and installs it untrusted", async () => {
    const test = await host(passthrough);
    const folder = toolingFolder(test.root, benign);
    const inspected = await test.inspect(folder);
    if (inspected.kind !== "package-inspected") {
      throw new Error(`package was not inspected: ${JSON.stringify(inspected)}`);
    }
    expect(inspected.preview.review.components).toMatchObject([
      {
        declaredCapabilities: ["filesystem", "shell", "network"],
        languageServer: { languages: ["lua"], launchClass: "repo-tooling" },
      },
    ]);
    const installed = await test.install(folder);
    expect(installed.components[0]?.effectiveState).toEqual({
      kind: "blocked",
      reason: "untrusted",
    });
  });

  it("refuses a package that would run more than its own binary or states what only Octant may", async () => {
    const test = await host(passthrough);
    const refusal = async (folder: string) => {
      const result = await test.inspect(folder);
      return result.kind === "extension-command-failed" ? result.failure : undefined;
    };

    const helper = packageFolder(join(test.root, "helper"), benign);
    writeFileSync(join(helper, "bin", "helper"), "#!/bin/sh\n", { mode: 0o755 });
    expect((await refusal(helper))?.message).toBe(
      "This language server ships a program besides its own binary; it may run its binary and nothing else.",
    );

    const notExecutable = packageFolder(join(test.root, "plain"), benign);
    chmodSync(join(notExecutable, "bin", "lua-language-server"), 0o644);
    expect((await refusal(notExecutable))?.message).toBe(
      "This language server's binary is not in its package, or is not executable.",
    );

    const selfReviewed = packageFolder(join(test.root, "reviewed"), benign, {
      provenance: { publisher: "Example", canonicalUrl: "https://example.com", reviewed: true },
    });
    expect((await refusal(selfReviewed))?.message).toBe(
      "This language server states its own identity, source, digest or review; Octant sets those itself.",
    );
  });

  it("never starts an installed server until its source is trusted and its plugin and component are on, nor one whose binary changed after review", async () => {
    const test = await host(passthrough);
    const installed = await test.install(packageFolder(test.root, benign));

    expect(await test.open()).toEqual({ status: "refused", reason: "no-language-server" });
    await test.trust(true);
    expect(await test.open()).toEqual({ status: "refused", reason: "no-language-server" });
    await test.enablePlugin(true);
    expect(await test.open()).toEqual({ status: "refused", reason: "no-language-server" });
    expect(test.launches()).toBe(0);

    await test.enableComponent(true);
    const opened = await test.open();
    if (opened.status !== "synced") throw new Error(`not synced: ${JSON.stringify(opened)}`);
    expect(await test.diagnostics(opened.fileId)).toMatchObject({
      status: "diagnostics",
      diagnostics: [{ message: "served: yes", source: "lua-language" }],
    });
    expect(test.launches()).toBe(1);

    // Withdrawn trust stops the running server and starts no other.
    await test.trust(false);
    await test.service.sweep();
    expect(await test.diagnostics(opened.fileId)).toEqual({
      status: "refused",
      reason: "file-outside-thread",
    });
    expect(await test.open()).toEqual({ status: "refused", reason: "no-language-server" });

    // A binary changed in the store after review is never run.
    const binary = join(
      test.store.contentRoot({
        extensionId: String(installed.extensionId),
        packageId: String(installed.packageId),
        version: String(installed.version),
        digest: String(installed.digest),
      }),
      "bin",
      "lua-language-server",
    );
    await makeWritable(test.root);
    writeFileSync(binary, benign.replace("served", "swapped"));
    await test.trust(true);
    expect(await test.open()).toEqual({ status: "unavailable", reason: "crashed" });
    expect(test.launches()).toBe(1);
  });
});

const bubblewrap = process.platform === "linux" && existsSync("/usr/bin/bwrap");
const seatbelt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

describe("a hostile language server a person adds", () => {
  it.runIf(bubblewrap || seatbelt)(
    "cannot run another program, reach the network, or write the checkout under confinement",
    async () => {
      const test = await host(makeProcessConfinementLive());
      const listener = await hostListener();
      const marker = join(test.root, "escaped-marker");
      const hostile = serverScript({ hostile: true, hostPort: listener.port, marker });
      await test.install(packageFolder(test.root, hostile));
      await test.trust(true);
      await test.enablePlugin(true);
      await test.enableComponent(true);

      const opened = await test.open();
      if (opened.status !== "synced") throw new Error(`not synced: ${JSON.stringify(opened)}`);
      const read = await test.diagnostics(opened.fileId);
      if (read.status !== "diagnostics") throw new Error(`no diagnostics: ${JSON.stringify(read)}`);
      const outcomes = Object.fromEntries(
        read.diagnostics.map((diagnostic) => {
          const [name = "", outcome = ""] = diagnostic.message.split(": ");
          return [name, outcome];
        }),
      );

      // It ran, and wrote where the class lets it: its own cache.
      expect(outcomes["write-cache"]).toBe("wrote");
      // Everything else it tried failed inside confinement.
      expect(outcomes["run-program"]).toMatch(/^refused /);
      expect(outcomes["reach-host"]).toMatch(/^refused /);
      expect(outcomes["reach-internet"]).toMatch(/^refused /);
      expect(outcomes["write-checkout"]).toMatch(/^refused /);
      if (bubblewrap) {
        // The no-fork filter refuses the child before any program is looked up.
        expect(outcomes["run-program"]).toBe("refused EPERM");
        expect(outcomes["write-checkout"]).toBe("refused EROFS");
      }
      // And nothing reached this host.
      expect(listener.connections()).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(test.checkout)).toEqual(["main.lua"]);
    },
  );
});

describe("a language server that runs the repository's tooling", () => {
  it("never starts without the approval of the person at a local window, and serves neither Plan nor a paired device even once approved", async () => {
    const test = await host(passthrough, { executionPolicy: "approval-gated" });
    await test.install(toolingFolder(test.root, benign));
    await test.trust(true);
    await test.enablePlugin(true);
    await test.enableComponent(true);
    const plan = decodeCodeThread({
      ...test.thread,
      id: "20000000-0000-4000-8000-000000000002",
      executionPolicy: "plan",
    });
    test.threads.push(plan);

    // Reviewed, trusted, and switched on, it still waits for the approval.
    expect(await test.open()).toEqual({ status: "refused", reason: "approval-required" });
    // A paired device can neither start it nor approve it, and Plan cannot approve it.
    expect(await test.open({ principal: "remote-device" })).toEqual({
      status: "refused",
      reason: "local-host-required",
    });
    expect(await test.approve("project", { principal: "remote-device" })).toEqual({
      status: "refused",
      reason: "local-host-required",
    });
    expect(await test.approve("checkout", { threadId: plan.id })).toEqual({
      status: "refused",
      reason: "plan-read-only",
    });
    expect(test.journal.approvals()).toEqual([]);
    expect(test.launches()).toBe(0);

    // The person at the machine approves it for this checkout, journal first.
    expect(await test.approve("checkout")).toEqual({
      status: "approved",
      threadId: test.thread.id,
      checkoutId: test.thread.checkoutId,
      scope: "checkout",
    });
    expect(test.journal.approvals()).toMatchObject([
      {
        eventName: "code.language-server-approval-granted@1",
        payload: {
          projectId: test.thread.projectId,
          approvalClass: "shell-commands",
          scope: { kind: "checkout", checkoutId: test.thread.checkoutId },
        },
      },
    ]);
    const opened = await test.open();
    if (opened.status !== "synced") throw new Error(`not synced: ${JSON.stringify(opened)}`);
    expect(await test.diagnostics(opened.fileId)).toMatchObject({
      status: "diagnostics",
      diagnostics: [{ message: "served: yes" }],
    });
    expect(test.launches()).toBe(1);

    // Running, it still serves neither a paired device nor a Plan thread.
    expect(await test.open({ principal: "remote-device" })).toEqual({
      status: "refused",
      reason: "local-host-required",
    });
    expect(await test.open({ threadId: plan.id })).toEqual({
      status: "refused",
      reason: "plan-read-only",
    });
    expect(test.launches()).toBe(1);

    // A restarted host reads the approval back from the journal.
    const [component] = test.components();
    if (component === undefined) throw new Error("the server is not effective");
    expect(
      test.reloadedApprovals().holds({
        projectId: test.thread.projectId,
        checkoutId: test.thread.checkoutId,
        component: component.approvalKey,
      }),
    ).toBe(true);

    // Any change to the package is a new question: switched off, the server
    // stops, and switched back on it waits for the approval again.
    await test.enableComponent(false);
    await test.service.sweep();
    expect(await test.diagnostics(opened.fileId)).toEqual({
      status: "refused",
      reason: "file-outside-thread",
    });
    await test.enableComponent(true);
    expect(await test.open()).toEqual({ status: "refused", reason: "approval-required" });
    expect(test.launches()).toBe(1);
  });
});

/**
 * A server that runs the repository's tooling, written for these tests.
 * Asked for diagnostics it runs another program, writes the checkout, tries
 * to reach this host and the internet directly, and asks its egress proxy
 * for a public host and for this host's listener, reporting each outcome as
 * one diagnostic.
 */
function toolingScript(hostPort: number): string {
  return `#!${process.execPath}
"use strict";
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { connect } = require("node:net");
const { join } = require("node:path");
const { fileURLToPath } = require("node:url");
const HOST_PORT = ${JSON.stringify(hostPort)};
let root = "/";
let buffered = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}

function code(error) {
  return "refused " + (error && error.code ? error.code : "error");
}

function runAnotherProgram() {
  try {
    const result = spawnSync("/bin/sh", ["-c", "echo ran"], { timeout: 3000, encoding: "utf8" });
    if (result.error) return code(result.error);
    return result.status === 0 ? result.stdout.trim() : "refused exit " + String(result.status);
  } catch (error) {
    return code(error);
  }
}

function reach(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("refused timeout");
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(code(error));
    });
  });
}

function throughProxy(target) {
  const proxy = new URL(process.env.HTTPS_PROXY || "http://127.0.0.1:9");
  const credentials = Buffer.from(
    decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password),
  ).toString("base64");
  return new Promise((resolve) => {
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) });
    let answer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("refused timeout");
    }, 5000);
    socket.once("connect", () => {
      socket.write(
        "CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target +
          "\\r\\nProxy-Authorization: Basic " + credentials + "\\r\\n\\r\\n",
      );
    });
    socket.on("data", (chunk) => {
      answer += chunk.toString("latin1");
    });
    socket.once("close", () => {
      clearTimeout(timer);
      const status = answer.split("\\r\\n")[0].split(" ")[1] || "none";
      const body = answer.split("\\r\\n\\r\\n")[1] || "";
      resolve("status " + status + " " + body.trim());
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(code(error));
    });
  });
}

function write(path) {
  try {
    writeFileSync(path, "generated\\n");
    return "wrote";
  } catch (error) {
    return code(error);
  }
}

async function attempts() {
  return [
    ["run-program", runAnotherProgram()],
    ["write-checkout", write(join(root, "generated.txt"))],
    ["reach-host", await reach("127.0.0.1", HOST_PORT)],
    ["reach-internet", await reach("1.1.1.1", 443)],
    ["proxy-public", await throughProxy("example.com:443")],
    ["proxy-host", await throughProxy("127.0.0.1:" + HOST_PORT)],
  ];
}

async function handle(message) {
  if (message.method === "initialize") {
    root = fileURLToPath(message.params.rootUri);
    send({
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
        },
      },
    });
  } else if (message.method === "textDocument/diagnostic") {
    const outcomes = await attempts();
    send({
      id: message.id,
      result: {
        kind: "full",
        items: outcomes.map(([name, outcome], line) => ({
          range: { start: { line, character: 0 }, end: { line, character: 1 } },
          severity: 3,
          message: name + ": " + outcome,
        })),
      },
    });
  } else if (message.method === "shutdown") {
    send({ id: message.id, result: null });
  } else if (message.method === "exit") {
    process.exit(0);
  } else if (message.id !== undefined && message.method !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    const end = buffered.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const match = /Content-Length: (\\d+)/i.exec(buffered.subarray(0, end).toString("ascii"));
    if (match === null) process.exit(1);
    const length = Number(match[1]);
    if (buffered.length < end + 4 + length) return;
    const body = buffered.subarray(end + 4, end + 4 + length).toString("utf8");
    buffered = buffered.subarray(end + 4 + length);
    void handle(JSON.parse(body));
  }
});
`;
}

describe("an approved language server that runs the repository's tooling, under confinement", () => {
  it.runIf(bubblewrap || seatbelt)(
    "runs programs and writes the checkout, and reaches no host its Project's rules do not name, each refusal journaled",
    async () => {
      const test = await host(makeProcessConfinementLive(), {
        executionPolicy: "approval-gated",
      });
      const listener = await hostListener();
      await test.install(toolingFolder(test.root, toolingScript(listener.port)));
      await test.trust(true);
      await test.enablePlugin(true);
      await test.enableComponent(true);
      expect(await test.approve("project")).toMatchObject({ status: "approved" });

      const opened = await test.open();
      if (opened.status !== "synced") throw new Error(`not synced: ${JSON.stringify(opened)}`);
      const read = await test.diagnostics(opened.fileId);
      if (read.status !== "diagnostics") throw new Error(`no diagnostics: ${JSON.stringify(read)}`);
      const outcomes = Object.fromEntries(
        read.diagnostics.map((diagnostic) => {
          const separator = diagnostic.message.indexOf(": ");
          return [diagnostic.message.slice(0, separator), diagnostic.message.slice(separator + 2)];
        }),
      );

      // The approval is what lets it run the repository's tooling and write
      // the checkout, as a terminal there could.
      expect(outcomes["run-program"]).toBe("ran");
      expect(outcomes["write-checkout"]).toBe("wrote");
      // Nothing leaves directly; the proxy refuses what no Project rule names.
      expect(outcomes["reach-host"]).toMatch(/^refused /);
      expect(outcomes["reach-internet"]).toMatch(/^refused /);
      expect(outcomes["proxy-public"]).toBe(
        "status 403 octant-egress-refused: no-rule example.com:443",
      );
      expect(outcomes["proxy-host"]).toMatch(/^status 403 octant-egress-refused: ip-literal/);
      expect(listener.connections()).toBe(0);

      // The launch is audited the way a proxied command's is.
      await test.service.close();
      const records = test.journal.egress();
      expect(records.map((record) => record.eventName)).toEqual(
        expect.arrayContaining([
          "code.language-server-egress-launch-started@1",
          "code.language-server-egress-launch-summarized@1",
        ]),
      );
      const summary = records.find(
        (record) => record.eventName === "code.language-server-egress-launch-summarized@1",
      );
      expect(summary?.payload).toMatchObject({
        launch: { threadId: test.thread.id, projectId: test.thread.projectId },
        bytesReceived: 0,
        entries: expect.arrayContaining([
          {
            host: "example.com",
            port: 443,
            decision: "refused",
            reason: "no-rule",
            requests: 1,
          },
        ]),
      });
    },
  );
});
