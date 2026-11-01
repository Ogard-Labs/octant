import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCodeCheckoutIdentity,
  decodeCodeFileChangeNotice,
  decodeCodeProjectFilePath,
  decodeCodeRelativePath,
  decodeCodeThread,
  type CodeCheckoutIdentity,
  type CodeFileId,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import type {
  CodeLanguageDocumentResult,
  CodeLanguageReadResult,
} from "@octant/contracts/code-language";
import type { LanguageServerHostPlatform, PrincipalKind } from "@octant/domain";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
  type ProcessConfinementPrepareInput,
} from "../process/seatbeltProfile";
import { deriveCodeFileId } from "./codeFileIdentity";
import { withProjectExtraFolders } from "./codeProjectFolderRoot";
import {
  CodeLanguageService,
  type CodeLanguageAgentReadResult,
  type CodeLanguageServerComponent,
  type CodeLanguageServiceOptions,
} from "./codeLanguageService";
import type { LanguageServerEgress, LanguageServerEgressScope } from "./languageServerEgress";
import { LanguageServerProcessPort } from "./languageServerProcess";

const scopeId = "10000000-0000-4000-8000-000000000001" as WindowId;
const now = "2026-10-26T12:00:00.000Z";
const fakeServer = fileURLToPath(new URL("./fakeLanguageServer.ts", import.meta.url));
const repositoryId = `repo_${"a".repeat(64)}`;
const roots: string[] = [];
const services: CodeLanguageService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function codeThread(overrides: Record<string, unknown> = {}): CodeThread {
  return decodeCodeThread({
    id: "20000000-0000-4000-8000-000000000001",
    projectId: "40000000-0000-4000-8000-000000000001",
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "Language services",
    lifecycle: "active",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "plan",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/language",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function plainCheckout(availability: "available" | "unavailable" = "available") {
  return decodeCodeCheckoutIdentity({
    id: "30000000-0000-4000-8000-000000000001",
    repositoryId,
    kind: "plain-folder",
    availability,
    head: { kind: "none" },
    observedAt: now,
  });
}

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-language-service-")));
  roots.push(root);
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  mkdirSync(checkout);
  mkdirSync(outside);
  writeFileSync(
    join(checkout, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "es2022", module: "nodenext", noEmit: true },
      include: ["*.ts"],
    }),
  );
  writeFileSync(
    join(checkout, "a.ts"),
    'export function greet(name: string): string {\n  return "hi " + name;\n}\n',
  );
  writeFileSync(
    join(checkout, "b.ts"),
    'import { greet } from "./a.js";\nexport const count: number = greet("x");\nexport const most = Math.max(1, 2);\n',
  );
  writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n");
  symlinkSync(join(outside, "secret.ts"), join(checkout, "escape.ts"));
  return {
    root,
    checkout,
    outside,
    cacheRoot: join(root, "cache"),
    receipts: join(root, "receipts"),
  };
}

interface Harness {
  readonly service: CodeLanguageService;
  readonly launches: () => number;
  readonly state: {
    thread: CodeThread;
    threads: CodeThread[];
    checkout: CodeCheckoutIdentity;
    /** Each thread's folder, by thread id; a thread on the harness's checkout is at its root. */
    folders: Map<string, string>;
    reach: boolean;
    turnedOff: boolean;
    /** The Project's extra folders, by absolute path. */
    extraFolders: string[];
  };
  open(
    path: string,
    options?: { principal?: PrincipalKind; text?: string },
  ): Promise<CodeLanguageDocumentResult>;
  diagnostics(fileId: CodeFileId, threadId?: CodeThread["id"]): Promise<CodeLanguageReadResult>;
  definition(fileId: CodeFileId, line: number, character: number): Promise<CodeLanguageReadResult>;
  /** An agent's read of the saved file, by path. */
  agent(
    path: string,
    position?: { readonly line: number; readonly character: number },
  ): Promise<CodeLanguageAgentReadResult>;
}

function harness(input: {
  readonly checkout: string;
  readonly cacheRoot: string;
  readonly component: CodeLanguageServerComponent;
  readonly confinement: ProcessConfinementPort;
  readonly receipts?: string;
  readonly platform?: LanguageServerHostPlatform;
  readonly now?: () => number;
  readonly limits?: CodeLanguageServiceOptions["limits"];
  readonly watcher?: CodeLanguageServiceOptions["watcher"];
  readonly approvals?: CodeLanguageServiceOptions["approvals"];
  readonly egress?: LanguageServerEgress;
  readonly threadTainted?: CodeLanguageServiceOptions["threadTainted"];
}): Harness {
  const state = {
    thread: codeThread(),
    threads: [] as CodeThread[],
    checkout: plainCheckout(),
    folders: new Map<string, string>(),
    reach: true,
    turnedOff: false,
    extraFolders: [] as string[],
  };
  state.threads = [state.thread];
  let launches = 0;
  const processes = new LanguageServerProcessPort({
    confinement: input.confinement,
    ...(input.receipts === undefined ? {} : { receiptDirectory: input.receipts }),
    ...(input.egress === undefined ? {} : { egress: input.egress }),
  });
  const service = new CodeLanguageService({
    authority: {
      readThread: (threadId) =>
        state.threads.find((thread) => String(thread.id) === String(threadId)),
      readThreads: () => state.threads,
      readCheckout: (checkoutId) =>
        String(checkoutId) === String(state.checkout.id) ? state.checkout : undefined,
      readThreadFolder: (thread) =>
        String(thread.checkoutId) === String(state.checkout.id)
          ? input.checkout
          : state.folders.get(String(thread.id)),
      canAccessProject: () => state.reach,
      effectiveThread: (_scope, thread) => thread,
      resolveRoot: withProjectExtraFolders({
        resolve: (_scope, thread, checkout, relativePath) => ({
          fileId: deriveCodeFileId(String(thread.id), String(checkout.id), relativePath),
          rootPath: input.checkout,
          rootIdentity: { device: "1", inode: "1" },
        }),
        extraFolders: () => state.extraFolders,
        probePath: decodeCodeRelativePath("package.json"),
        fileId: (threadId, checkoutId, path) =>
          deriveCodeFileId(threadId, checkoutId, path as never),
        statIdentity: async () => ({ device: "2", inode: "2" }),
      }),
    },
    components: () => (state.turnedOff ? [] : [input.component]),
    turnedOffComponents: () => (state.turnedOff ? [input.component] : []),
    processes: {
      launch: (launch) => {
        launches += 1;
        return processes.launch(launch);
      },
    },
    platform: input.platform ?? (process.platform === "darwin" ? "macos" : "linux"),
    cacheRoot: input.cacheRoot,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    ...(input.watcher === undefined ? {} : { watcher: input.watcher }),
    ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
    ...(input.threadTainted === undefined ? {} : { threadTainted: input.threadTainted }),
  });
  services.push(service);
  const scope = () => ({ threadId: state.thread.id, checkoutId: state.checkout.id });
  return {
    service,
    launches: () => launches,
    state,
    open: (path, options = {}) =>
      service.syncDocument(
        { scopeId, principal: options.principal ?? "local-window" },
        {
          kind: "open",
          ...scope(),
          path: decodeCodeRelativePath(path),
          text: options.text ?? readFileSync(join(input.checkout, path), "utf8"),
        },
      ),
    diagnostics: (fileId, threadId) =>
      service.read(
        { scopeId, principal: "local-window" },
        {
          kind: "diagnostics",
          ...scope(),
          ...(threadId === undefined ? {} : { threadId }),
          fileId,
        },
      ),
    definition: (fileId, line, character) =>
      service.read(
        { scopeId, principal: "local-window" },
        { kind: "definition", ...scope(), fileId, position: { line, character } },
      ),
    agent: (path, position) =>
      service.readForAgent(
        scopeId,
        position === undefined
          ? { kind: "diagnostics", ...scope(), path: decodeCodeProjectFilePath(path) }
          : { kind: "definition", ...scope(), path: decodeCodeProjectFilePath(path), position },
      ),
  };
}

const passthrough: ProcessConfinementPort = {
  prepare: (input) => ({ command: input.executable, args: input.args }),
};

function fakeComponent(mode: string, log: string): CodeLanguageServerComponent {
  return {
    componentKey: `fake-${mode}`,
    approvalKey: `fake-${mode}`,
    languages: ["typescript"],
    launchClass: "static",
    executable: async () => process.execPath,
    args: [fakeServer, mode, log],
    installRoot: dirname(fakeServer),
    sourceLabel: "fake",
  };
}

function logged(log: string): ReadonlyArray<Record<string, unknown>> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function syncedFileId(result: CodeLanguageDocumentResult): CodeFileId {
  if (result.status !== "synced")
    throw new Error(`document was not synced: ${JSON.stringify(result)}`);
  return result.fileId;
}

function bundledTypeScriptBinary(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(
      `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
    );
    const binary = join(dirname(manifest), "lib", "tsc");
    return existsSync(binary) ? realpathSync(binary) : undefined;
  } catch {
    return undefined;
  }
}

const typeScriptBinary = bundledTypeScriptBinary();
const confinementRuntime =
  process.platform === "linux"
    ? existsSync("/usr/bin/bwrap")
    : process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

describe("Code language service with the bundled TypeScript server", () => {
  it.runIf(typeScriptBinary !== undefined && confinementRuntime)(
    "returns a two-file fixture's type error and cross-file definition from the confined real binary",
    async () => {
      const paths = workspace();
      const binary = typeScriptBinary ?? "";
      const live = makeProcessConfinementLive();
      const prepared: Array<{
        readonly input: ProcessConfinementPrepareInput;
        readonly args: ReadonlyArray<string>;
      }> = [];
      const test = harness({
        ...paths,
        receipts: paths.receipts,
        component: {
          componentKey: "bundled-typescript",
          approvalKey: "bundled-typescript",
          languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
          launchClass: "static",
          executable: async () => binary,
          args: ["--lsp", "--stdio"],
          installRoot: dirname(binary),
          sourceLabel: "typescript",
        },
        confinement: {
          prepare: (input) => {
            const launch = live.prepare(input);
            prepared.push({ input, args: launch.args });
            return launch;
          },
        },
      });

      const fileId = syncedFileId(await test.open("b.ts"));
      const diagnostics = await test.diagnostics(fileId);
      expect(diagnostics).toMatchObject({
        status: "diagnostics",
        truncated: false,
        diagnostics: [
          {
            path: "b.ts",
            severity: "error",
            range: { start: { line: 1, character: 13 }, end: { line: 1, character: 18 } },
            message: "Type 'string' is not assignable to type 'number'.",
          },
        ],
      });
      expect(await test.definition(fileId, 1, 30)).toEqual({
        status: "definition",
        threadId: test.state.thread.id,
        checkoutId: test.state.checkout.id,
        fileId,
        targets: [
          {
            kind: "checkout-location",
            path: "a.ts",
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
          },
        ],
      });
      const library = await test.definition(fileId, 2, 25);
      expect(library.status === "definition" ? library.targets[0] : undefined).toEqual({
        kind: "outside-checkout",
        label: "bundled-library",
      });

      // The thread is in Plan, and the launch was the static class's whole grant.
      expect(prepared).toHaveLength(1);
      const launch = prepared[0];
      expect(launch?.input).toMatchObject({
        boundRoot: paths.checkout,
        writeBoundRoot: false,
        networkEgress: "none",
        allowProcessExec: false,
        allowProcessFork: false,
        readRoots: [dirname(binary)],
      });
      if (process.platform === "linux") {
        const args = launch?.args ?? [];
        expect(args).toContain("--unshare-all");
        expect(args).not.toContain("--share-net");
        expect(args.join(" ")).toContain("--seccomp");
        expect(args.join(" ")).toContain(`--ro-bind ${paths.checkout} ${paths.checkout}`);
        expect(args.join(" ")).not.toContain(`--bind ${paths.checkout} `);
      }
      // A cache was the only place it could write, and the checkout is unchanged.
      expect(readdirSync(paths.checkout).sort()).toEqual([
        "a.ts",
        "b.ts",
        "escape.ts",
        "tsconfig.json",
      ]);
    },
  );

  it.runIf(typeScriptBinary !== undefined && confinementRuntime)(
    "answers an agent's reads of a saved file in a Plan thread from the confined real binary",
    async () => {
      const paths = workspace();
      const binary = typeScriptBinary ?? "";
      const prepared: ProcessConfinementPrepareInput[] = [];
      const live = makeProcessConfinementLive();
      const test = harness({
        ...paths,
        receipts: paths.receipts,
        component: {
          componentKey: "bundled-typescript",
          approvalKey: "bundled-typescript",
          languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
          launchClass: "static",
          executable: async () => binary,
          args: ["--lsp", "--stdio"],
          installRoot: dirname(binary),
          sourceLabel: "typescript",
        },
        confinement: {
          prepare: (input) => {
            prepared.push(input);
            return live.prepare(input);
          },
        },
      });
      expect(test.state.thread.executionPolicy).toBe("plan");

      // No editor holds the file: the agent's read opens it from disk.
      expect(await test.agent("b.ts")).toMatchObject({
        status: "diagnostics",
        diagnostics: [
          {
            path: "b.ts",
            severity: "error",
            range: { start: { line: 1, character: 13 }, end: { line: 1, character: 18 } },
            message: "Type 'string' is not assignable to type 'number'.",
          },
        ],
      });
      expect(await test.agent("b.ts", { line: 1, character: 30 })).toMatchObject({
        status: "definition",
        targets: [
          {
            kind: "checkout-location",
            path: "a.ts",
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
          },
        ],
      });

      // A saved fix is what the next read sees.
      writeFileSync(
        join(paths.checkout, "b.ts"),
        'import { greet } from "./a.js";\nexport const count: string = greet("x");\n',
      );
      expect(await test.agent("b.ts")).toMatchObject({ status: "diagnostics", diagnostics: [] });
      expect(prepared).toHaveLength(1);
      expect(prepared[0]).toMatchObject({
        writeBoundRoot: false,
        networkEgress: "none",
        allowProcessExec: false,
        allowProcessFork: false,
      });
    },
  );
});

describe("Code language service authority", () => {
  function fake(mode = "normal", overrides: Partial<Parameters<typeof harness>[0]> = {}) {
    const paths = workspace();
    const log = join(paths.root, "server.log");
    return {
      paths,
      log,
      test: harness({
        ...paths,
        component: fakeComponent(mode, log),
        confinement: passthrough,
        ...overrides,
      }),
    };
  }

  it("refuses an archived or completed thread, a checkout mismatch, and an unavailable checkout without starting a server", async () => {
    const { test } = fake();
    test.state.thread = codeThread({ lifecycle: "archived" });
    test.state.threads = [test.state.thread];
    expect(await test.open("b.ts")).toEqual({ status: "refused", reason: "thread-inactive" });
    test.state.thread = codeThread({ completedAt: now });
    test.state.threads = [test.state.thread];
    expect(await test.open("b.ts")).toEqual({ status: "refused", reason: "thread-inactive" });

    test.state.thread = codeThread({ checkoutId: "30000000-0000-4000-8000-000000000009" });
    test.state.threads = [test.state.thread];
    expect(
      await test.service.syncDocument(
        { scopeId, principal: "local-window" },
        {
          kind: "open",
          threadId: test.state.thread.id,
          checkoutId: plainCheckout().id,
          path: decodeCodeRelativePath("b.ts"),
          text: "",
        },
      ),
    ).toEqual({ status: "refused", reason: "checkout-mismatch" });

    test.state.thread = codeThread();
    test.state.threads = [test.state.thread];
    test.state.checkout = plainCheckout("unavailable");
    expect(await test.open("b.ts")).toEqual({ status: "refused", reason: "checkout-unavailable" });
    expect(test.launches()).toBe(0);
  });

  it("refuses a device without reach, and lets a device with reach start a static server", async () => {
    const { test } = fake();
    test.state.reach = false;
    expect(await test.open("b.ts", { principal: "remote-device" })).toEqual({
      status: "refused",
      reason: "no-reach",
    });
    expect(test.launches()).toBe(0);

    test.state.reach = true;
    expect((await test.open("b.ts", { principal: "remote-device" })).status).toBe("synced");
    expect(test.launches()).toBe(1);
  });

  it("refuses a path that escapes through a symlink, an unserved language, and another platform before any launch", async () => {
    const { test, paths } = fake();
    expect(await test.open("escape.ts")).toEqual({
      status: "refused",
      reason: "path-outside-checkout",
    });
    writeFileSync(join(paths.checkout, "tool.py"), "print(1)\n");
    expect(await test.open("tool.py")).toEqual({ status: "refused", reason: "no-language-server" });
    expect(test.launches()).toBe(0);

    const other = fake("normal", { platform: "windows" });
    expect(await other.test.open("b.ts")).toEqual({
      status: "refused",
      reason: "unsupported-platform",
    });
    expect(other.test.launches()).toBe(0);
  });

  it("answers turned-off once the person turns the server off, and stops the one running", async () => {
    const { test, paths } = fake();
    const fileId = syncedFileId(await test.open("b.ts"));
    expect(test.launches()).toBe(1);

    test.state.turnedOff = true;
    await test.service.sweep();
    expect(await test.diagnostics(fileId)).toEqual({
      status: "refused",
      reason: "file-outside-thread",
    });
    expect(await test.open("b.ts")).toEqual({ status: "refused", reason: "turned-off" });
    // A language no component declares is still not a switch the person holds.
    writeFileSync(join(paths.checkout, "tool.py"), "print(1)\n");
    expect(await test.open("tool.py")).toEqual({ status: "refused", reason: "no-language-server" });
    expect(test.launches()).toBe(1);

    test.state.turnedOff = false;
    expect((await test.open("b.ts")).status).toBe("synced");
    expect(test.launches()).toBe(2);
  });

  it("refuses a missing Bubblewrap as unavailable confinement and starts nothing", async () => {
    const { test } = fake("normal", {
      confinement: makeProcessConfinementLive({
        platform: "linux",
        sandboxPath: "/nonexistent/octant/bwrap",
      }),
      platform: "linux",
    });
    expect(await test.open("b.ts")).toEqual({
      status: "refused",
      reason: "confinement-unavailable",
    });
  });

  it("suspends a repository-tooling server's Project rules while a tainted thread of any Project can write its folder", async () => {
    const scopes: LanguageServerEgressScope[] = [];
    const tainted = new Set<string>();
    const paths = workspace();
    const test = harness({
      ...paths,
      component: {
        ...fakeComponent("normal", join(paths.root, "server.log")),
        launchClass: "repo-tooling",
      },
      confinement: passthrough,
      approvals: { holds: () => true, record: () => "recorded" },
      threadTainted: (threadId) => tainted.has(String(threadId)),
      egress: {
        start: async (scope) => {
          scopes.push(scope);
          return {
            status: "listening",
            endpoint: { kind: "loopback", port: 9 },
            token: "language-server-egress",
            close: async () => undefined,
          };
        },
      },
    });
    test.state.thread = codeThread({ executionPolicy: "full-access" });
    // Two other Projects: one bound to the same folder, which gives its
    // thread a checkout id of its own, and one bound to a folder beside it.
    const sameFolder = codeThread({
      id: "20000000-0000-4000-8000-000000000003",
      projectId: "40000000-0000-4000-8000-000000000003",
      checkoutId: "30000000-0000-4000-8000-000000000003",
    });
    const beside = codeThread({
      id: "20000000-0000-4000-8000-000000000004",
      projectId: "40000000-0000-4000-8000-000000000004",
      checkoutId: "30000000-0000-4000-8000-000000000004",
    });
    test.state.threads = [test.state.thread, sameFolder, beside];
    test.state.folders.set(String(sameFolder.id), paths.checkout);
    test.state.folders.set(String(beside.id), paths.outside);
    expect((await test.open("a.ts")).status).toBe("synced");
    const [scope] = scopes;
    if (scope === undefined) throw new Error("the server started with no egress");

    expect(scope.checkoutTainted()).toBe(false);
    tainted.add(String(beside.id));
    expect(scope.checkoutTainted()).toBe(false);
    tainted.add(String(sameFolder.id));
    expect(scope.checkoutTainted()).toBe(true);

    // A Project bound to a folder that holds the checkout can write it too.
    test.state.folders.set(String(sameFolder.id), paths.root);
    expect(scope.checkoutTainted()).toBe(true);
    // So can one bound to a folder inside it, whatever that folder is named.
    test.state.folders.set(String(sameFolder.id), join(paths.checkout, "..cache"));
    expect(scope.checkoutTainted()).toBe(true);
    // A folder that cannot be told counts as the server's.
    test.state.folders.delete(String(sameFolder.id));
    expect(scope.checkoutTainted()).toBe(true);
    test.state.threads = [test.state.thread, beside];
    expect(scope.checkoutTainted()).toBe(false);
  });

  it("answers a read only for a document this thread opened", async () => {
    const { test } = fake();
    const unopened = deriveCodeFileId(
      String(test.state.thread.id),
      String(plainCheckout().id),
      "b.ts",
    );
    expect(await test.diagnostics(unopened)).toEqual({
      status: "refused",
      reason: "file-outside-thread",
    });
    const fileId = syncedFileId(await test.open("b.ts"));
    const sibling = codeThread({ id: "20000000-0000-4000-8000-000000000002" });
    test.state.threads = [test.state.thread, sibling];
    expect(await test.diagnostics(fileId, sibling.id)).toEqual({
      status: "refused",
      reason: "file-outside-thread",
    });
    expect((await test.diagnostics(fileId)).status).toBe("diagnostics");
  });
});

describe("Code language service reads for an agent", () => {
  function fake(
    component?: Partial<CodeLanguageServerComponent>,
    options: Pick<Parameters<typeof harness>[0], "approvals" | "egress"> = {},
  ) {
    const paths = workspace();
    const log = join(paths.root, "server.log");
    const test = harness({
      ...paths,
      ...options,
      component: { ...fakeComponent("normal", log), ...component },
      confinement: passthrough,
    });
    return { paths, log, test };
  }
  const changes = (log: string) =>
    logged(log)
      .filter((entry) => entry.method === "textDocument/didChange")
      .map(
        (entry) =>
          (entry.params as { contentChanges: ReadonlyArray<{ text: string }> }).contentChanges[0]
            ?.text,
      );

  it("refuses before any launch as the editor's reads are refused, and by path", async () => {
    const { test } = fake();
    test.state.reach = false;
    expect(await test.agent("b.ts")).toEqual({ status: "refused", reason: "no-reach" });
    test.state.reach = true;
    test.state.thread = codeThread({ lifecycle: "archived" });
    test.state.threads = [test.state.thread];
    expect(await test.agent("b.ts")).toEqual({ status: "refused", reason: "thread-inactive" });
    test.state.thread = codeThread();
    test.state.threads = [test.state.thread];
    expect(await test.agent("escape.ts")).toEqual({
      status: "refused",
      reason: "path-outside-checkout",
    });
    expect(await test.agent("missing.ts")).toEqual({
      status: "refused",
      reason: "path-outside-checkout",
    });
    expect(test.launches()).toBe(0);
  });

  it("reads a file in an extra folder by absolute path, in a server of its own, and refuses a folder beside it", async () => {
    const { paths, test, log } = fake();
    const extra = join(paths.root, "extra");
    const beside = join(paths.root, "beside");
    mkdirSync(extra);
    mkdirSync(beside);
    writeFileSync(join(extra, "c.ts"), "export const c = 1;\n");
    writeFileSync(join(beside, "d.ts"), "export const d = 1;\n");
    test.state.extraFolders = [extra];

    const read = await test.agent(join(extra, "c.ts"));
    expect(read).toMatchObject({ status: "diagnostics" });
    const opened = logged(log).filter((entry) => entry.method === "textDocument/didOpen");
    expect(opened).toHaveLength(1);

    expect(await test.agent(join(beside, "d.ts"))).toEqual({
      status: "refused",
      reason: "checkout-unavailable",
    });
    expect(await test.agent(join(extra, "..", "beside", "d.ts"))).toMatchObject({
      status: "refused",
    });
  });

  it("sends a change to a document in an extra folder to that folder's server and to no other", async () => {
    const { paths, test, log } = fake();
    const extra = join(paths.root, "extra");
    mkdirSync(extra);
    writeFileSync(join(extra, "c.ts"), "export const c = 1;\n");
    test.state.extraFolders = [extra];
    const scope = { threadId: test.state.thread.id, checkoutId: plainCheckout().id };
    const caller = { scopeId, principal: "local-window" } as const;

    const mainFile = syncedFileId(await test.open("a.ts"));
    const extraOpened = await test.service.syncDocument(caller, {
      kind: "open",
      ...scope,
      path: decodeCodeProjectFilePath(join(extra, "c.ts")),
      text: "export const c = 1;\n",
    });
    const extraFile = syncedFileId(extraOpened);
    expect(test.launches()).toBe(2);

    await test.service.syncDocument(caller, {
      kind: "change",
      ...scope,
      fileId: extraFile,
      text: "export const c = 2;\n",
    });
    await eventually(() => logged(log).some((entry) => entry.method === "textDocument/didChange"));

    const received = logged(log).filter((entry) => entry.event === "received");
    const serverOf = (root: string) =>
      received.find(
        (entry) =>
          entry.method === "initialize" &&
          (entry.params as { rootUri: string }).rootUri === pathToFileURL(root).href,
      )?.pid;
    const extraServer = serverOf(extra);
    const mainServer = serverOf(paths.checkout);
    expect(extraServer).toBeDefined();
    expect(mainServer).toBeDefined();
    expect(extraServer).not.toBe(mainServer);

    const changed = received.filter((entry) => entry.method === "textDocument/didChange");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      pid: extraServer,
      params: { textDocument: { uri: pathToFileURL(join(extra, "c.ts")).href } },
    });

    // A change to the checkout's own document goes to the checkout's server.
    await test.service.syncDocument(caller, {
      kind: "change",
      ...scope,
      fileId: mainFile,
      text: "export const a = 2;\n",
    });
    await eventually(
      () => logged(log).filter((entry) => entry.method === "textDocument/didChange").length === 2,
    );
    const second = logged(log).filter((entry) => entry.method === "textDocument/didChange")[1];
    expect(second).toMatchObject({ pid: mainServer });
  });

  it("names a definition found from an extra folder by that folder's absolute path", async () => {
    const { paths, test } = fake();
    const extra = join(paths.root, "extra");
    mkdirSync(extra);
    writeFileSync(join(extra, "c.ts"), "export const c = 1;\n");
    writeFileSync(join(extra, "a.ts"), "export const a = 1;\n");
    test.state.extraFolders = [extra];

    const read = await test.agent(join(extra, "c.ts"), { line: 0, character: 16 });

    expect(read).toMatchObject({
      status: "definition",
      targets: expect.arrayContaining([
        expect.objectContaining({ kind: "checkout-location", path: join(extra, "a.ts") }),
      ]),
    });
  });

  it("never starts or reads through a server that runs repository tooling, even one a local approval covers", async () => {
    const { test, log } = fake(
      { launchClass: "repo-tooling" },
      {
        approvals: { holds: () => true, record: () => "recorded" },
        egress: {
          start: async () => ({
            status: "listening",
            endpoint: { kind: "loopback", port: 9 },
            token: "language-server-egress",
            close: async () => undefined,
          }),
        },
      },
    );
    test.state.thread = codeThread({ executionPolicy: "full-access" });
    test.state.threads = [test.state.thread];
    const refused = { status: "refused", reason: "local-host-required" };
    expect(await test.agent("b.ts")).toEqual(refused);
    expect(test.launches()).toBe(0);

    // The person at the machine opens a file, so the approved server runs;
    // the agent is still refused it, and its read sends the server nothing.
    const fileId = syncedFileId(await test.open("a.ts"));
    expect(test.launches()).toBe(1);
    expect(await test.agent("b.ts")).toEqual(refused);
    expect(await test.agent("a.ts", { line: 0, character: 16 })).toEqual(refused);
    // The editor's own read goes through, and answers after everything sent before it.
    expect((await test.definition(fileId, 0, 16)).status).toBe("definition");
    expect(test.launches()).toBe(1);
    expect(logged(log).filter((entry) => entry.method === "textDocument/didOpen")).toHaveLength(1);
  });

  it("reads the saved file and never replaces the text an editor holds", async () => {
    const { test, log, paths } = fake();
    const saved = readFileSync(join(paths.checkout, "b.ts"), "utf8");
    const fileId = syncedFileId(await test.open("b.ts", { text: `${saved}// draft\n` }));
    expect(await test.agent("b.ts")).toEqual({ status: "unsaved-edits" });
    expect(changes(log)).toEqual([]);

    // Once the editor holds the saved text, the agent reads beside it.
    expect(
      (
        await test.service.syncDocument(
          { scopeId, principal: "local-window" },
          {
            kind: "change",
            threadId: test.state.thread.id,
            checkoutId: plainCheckout().id,
            fileId,
            text: saved,
          },
        )
      ).status,
    ).toBe("synced");
    expect((await test.agent("b.ts")).status).toBe("diagnostics");

    // With the editor gone, a file saved since is sent as saved.
    await test.service.syncDocument(
      { scopeId, principal: "local-window" },
      { kind: "close", threadId: test.state.thread.id, checkoutId: plainCheckout().id, fileId },
    );
    expect((await test.agent("b.ts")).status).toBe("diagnostics");
    writeFileSync(join(paths.checkout, "b.ts"), "export const fixed = 1;\n");
    expect((await test.agent("b.ts")).status).toBe("diagnostics");
    expect(changes(log).at(-1)).toBe("export const fixed = 1;\n");
    expect(test.launches()).toBe(1);
  });

  it("closes a draft the person discards even when an agent read the file first", async () => {
    const { test, log, paths } = fake();
    const saved = readFileSync(join(paths.checkout, "b.ts"), "utf8");
    expect((await test.agent("b.ts")).status).toBe("diagnostics");
    const fileId = syncedFileId(await test.open("b.ts", { text: saved }));
    const scope = { threadId: test.state.thread.id, checkoutId: plainCheckout().id, fileId };
    await test.service.syncDocument(
      { scopeId, principal: "local-window" },
      { kind: "change", ...scope, text: `${saved}export const draftOnly = 1;\n` },
    );
    await test.service.syncDocument(
      { scopeId, principal: "local-window" },
      { kind: "close", ...scope },
    );
    // The server must not go on reading the discarded draft for the agent's
    // later reads of other files.
    await eventually(() => logged(log).some((entry) => entry.method === "textDocument/didClose"));
    expect((await test.agent("b.ts")).status).toBe("diagnostics");
  });

  it("answers too-large for a file past the server's frame", async () => {
    const { test, paths } = fake();
    writeFileSync(join(paths.checkout, "huge.ts"), "x".repeat(5 * 1024 * 1024));
    expect(await test.agent("huge.ts")).toEqual({ status: "too-large" });
    expect(test.launches()).toBe(0);
  });
});

describe("Code language service against a hostile server", () => {
  function fake(mode: string, limits?: CodeLanguageServiceOptions["limits"], clock?: () => number) {
    const paths = workspace();
    const log = join(paths.root, "server.log");
    const test = harness({
      ...paths,
      component: fakeComponent(mode, log),
      confinement: passthrough,
      receipts: paths.receipts,
      ...(limits === undefined ? {} : { limits }),
      ...(clock === undefined ? {} : { now: clock }),
    });
    return { paths, log, test };
  }

  it("refuses a server's edits, commands, and documents, and hides host paths in what it says", async () => {
    const { test, log, paths } = fake("normal");
    const fileId = syncedFileId(await test.open("b.ts"));
    const diagnostics = await test.diagnostics(fileId);
    expect(diagnostics.status === "diagnostics" ? diagnostics.diagnostics[0]?.message : "").toBe(
      "Cannot read file '<outside checkout>' from src/a.ts",
    );
    const refusals = () =>
      logged(log).filter((entry) => entry.event === "answer" && entry.id !== 1000);
    await eventually(() => refusals().length === 3);
    expect(
      refusals().map((entry) => [
        entry.result,
        (entry.error as { code?: number } | undefined)?.code,
      ]),
    ).toEqual([
      [undefined, -32601],
      [undefined, -32601],
      [undefined, -32601],
    ]);
    expect(readFileSync(join(paths.checkout, "a.ts"), "utf8")).toContain("export function greet");

    expect(await test.definition(fileId, 0, 0)).toMatchObject({
      status: "definition",
      targets: [
        { kind: "checkout-location", path: "a.ts" },
        { kind: "outside-checkout", label: "elsewhere" },
        { kind: "outside-checkout", label: "elsewhere" },
      ],
    });
  });

  it("tells a server that registered for file changes which checkout files changed", async () => {
    const paths = workspace();
    const log = join(paths.root, "server.log");
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({
      ...paths,
      component: fakeComponent("normal", log),
      confinement: passthrough,
      watcher: {
        watch: async function* (request) {
          // The first notice waits until the server has registered.
          await released;
          yield decodeCodeFileChangeNotice({
            kind: "code-file-change",
            threadId: request.threadId,
            checkoutId: request.checkoutId,
            paths: ["a.ts"],
            truncated: false,
            observedAt: now,
          });
        },
      },
    });
    syncedFileId(await test.open("b.ts"));
    await eventually(() =>
      logged(log).some((entry) => entry.event === "answer" && entry.id === 1000),
    );
    release();
    await eventually(() =>
      logged(log).some((entry) => entry.method === "workspace/didChangeWatchedFiles"),
    );
    expect(
      logged(log).find((entry) => entry.method === "workspace/didChangeWatchedFiles")?.params,
    ).toEqual({ changes: [{ uri: pathToFileURL(join(paths.checkout, "a.ts")).href, type: 2 }] });
  });

  it("answers too-large for a document whose escaped text would not fit a frame, and does not send it", async () => {
    const { test, log } = fake("normal");
    // 2.5 MB of text, past 4 MiB once each quote is escaped for the frame.
    expect((await test.open("b.ts", { text: '"'.repeat(2_500_000) })).status).toBe("too-large");
    expect(logged(log).some((entry) => entry.method === "textDocument/didOpen")).toBe(false);
  });

  it("stops a server that sends a frame past the cap", async () => {
    const { test, paths } = fake("oversize", { maxCrashRestarts: 0 });
    const fileId = syncedFileId(await test.open("b.ts"));
    expect(await test.diagnostics(fileId)).toEqual({ status: "unavailable", reason: "crashed" });
    await eventually(() => readdirSync(paths.receipts).length === 0);
    expect(await test.diagnostics(fileId)).toEqual({ status: "unavailable", reason: "crashed" });
    expect(test.launches()).toBe(1);
  });

  it("times a read out at its deadline and cancels it at the server", async () => {
    // The deadline also bounds `initialize`; a shorter one let a loaded runner
    // count a slow start as a crash before the read was ever sent.
    const { test, log } = fake("silent", { requestDeadlineMs: 2_000 });
    const fileId = syncedFileId(await test.open("b.ts"));
    expect(await test.definition(fileId, 0, 0)).toEqual({
      status: "unavailable",
      reason: "timed-out",
    });
    await eventually(() => logged(log).some((entry) => entry.method === "$/cancelRequest"));
  });

  it("restarts within the crash budget, then reports crashed until the editor opens the file again", async () => {
    const { test } = fake("crash-on-read");
    const fileId = syncedFileId(await test.open("b.ts"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await test.diagnostics(fileId)).toEqual({ status: "unavailable", reason: "crashed" });
    }
    await eventually(() => test.launches() === 3);
    expect(await test.diagnostics(fileId)).toEqual({ status: "unavailable", reason: "crashed" });
    expect(test.launches()).toBe(3);
    // An agent's read is not the person's retry: it never restarts a server
    // past its budget, however often it asks.
    expect(await test.agent("b.ts")).toEqual({ status: "unavailable", reason: "crashed" });
    expect(test.launches()).toBe(3);

    expect((await test.open("b.ts")).status).toBe("synced");
    expect(test.launches()).toBe(4);
  });

  it("stops a server once its documents and the server itself sit idle, and when its last thread is archived", async () => {
    let clock = 1_000_000;
    const { test, log } = fake("normal", { idleMs: 1_000 }, () => clock);
    const fileId = syncedFileId(await test.open("b.ts"));
    clock += 999;
    await test.service.sweep();
    expect((await test.diagnostics(fileId)).status).toBe("diagnostics");
    clock += 1_000;
    await test.service.sweep();
    await eventually(() => logged(log).some((entry) => entry.method === "exit"));
    expect(await test.diagnostics(fileId)).toEqual({
      status: "refused",
      reason: "file-outside-thread",
    });

    syncedFileId(await test.open("b.ts"));
    expect(test.launches()).toBe(2);
    test.state.thread = codeThread({ lifecycle: "archived" });
    test.state.threads = [test.state.thread];
    await test.service.sweep();
    await eventually(() => logged(log).filter((entry) => entry.method === "exit").length === 2);
  });

  it("gives a restarted server a fresh temporary directory, never the target of a link it left there", async () => {
    const paths = workspace();
    const prepared: ProcessConfinementPrepareInput[] = [];
    const processes = new LanguageServerProcessPort({
      confinement: {
        prepare: (input) => {
          prepared.push(input);
          return passthrough.prepare(input);
        },
      },
    });
    const cacheDirectory = join(paths.cacheRoot, "server");
    const launch = () =>
      processes.launch({
        ownerId: "server",
        launchClass: "static",
        executable: process.execPath,
        args: ["-e", ""],
        installRoot: dirname(process.execPath),
        checkoutRoot: paths.checkout,
        cacheDirectory,
        cacheRoot: paths.cacheRoot,
      });
    const first = await launch();
    if (first.status === "launched") await first.process.kill();
    // What a compromised server can do inside the cache it may write.
    rmSync(join(cacheDirectory, "tmp"), { recursive: true, force: true });
    symlinkSync(paths.outside, join(cacheDirectory, "tmp"));

    const second = await launch();
    if (second.status === "launched") await second.process.kill();
    expect(second.status).toBe("launched");
    const temporaryDirectory = prepared.at(-1)?.temporaryDirectory ?? "";
    expect(lstatSync(temporaryDirectory).isSymbolicLink()).toBe(false);
    expect(realpathSync(temporaryDirectory)).toBe(join(cacheDirectory, "tmp"));
    expect(readdirSync(paths.outside)).toEqual(["secret.ts"]);
  });

  it("reaps a server a previous run of the host left behind", async () => {
    // The first host is still alive in this test; with no restarts it stands
    // in for a host that is gone and cannot start the server again.
    const { test, paths } = fake("normal", { maxCrashRestarts: 0 });
    syncedFileId(await test.open("b.ts"));
    const [receiptName] = readdirSync(paths.receipts);
    const receipt = JSON.parse(readFileSync(join(paths.receipts, receiptName ?? ""), "utf8")) as {
      readonly pid: number;
    };
    expect(() => process.kill(receipt.pid, 0)).not.toThrow();

    await new LanguageServerProcessPort({ receiptDirectory: paths.receipts }).reconcile();
    await eventually(() => readdirSync(paths.receipts).length === 0);
    // In this test the server is the runner's own child, so it lingers until
    // the runner collects its exit; after a real restart nobody waits on it.
    await eventually(() => {
      try {
        process.kill(receipt.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});
