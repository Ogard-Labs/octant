import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  statSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeCodeCheckoutIdentity,
  decodeCodeThread,
  decodeCodeProjectFilePath,
  decodeWindowId,
} from "@octant/contracts";
import { decodeCodeLanguageReadRequest } from "@octant/contracts/code-language";
import { CodeLanguageService } from "./codeLanguageService";
import { deriveCodeFileId } from "./codeFileIdentity";
const scopeId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const now = "2026-10-26T12:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture(
  options: {
    readonly capability?: unknown;
    readonly requestDeadlineMs?: number;
    readonly extraFolder?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-reference-read-")));
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  const install = join(root, "install");
  mkdirSync(checkout);
  mkdirSync(outside);
  mkdirSync(install);
  writeFileSync(join(checkout, "a.ts"), "export const value = 1;\n");
  writeFileSync(join(checkout, "b.ts"), 'import { value } from "./a";\nconsole.log(value);\n');
  writeFileSync(join(outside, "private.ts"), "private source");
  symlinkSync(join(outside, "private.ts"), join(checkout, "escape.ts"));
  const repositoryId = `repo_${"a".repeat(64)}`;
  const thread = decodeCodeThread({
    id: "20000000-0000-4000-8000-000000000001",
    projectId: "40000000-0000-4000-8000-000000000001",
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "Reference read",
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
  });
  const identity = decodeCodeCheckoutIdentity({
    id: thread.checkoutId,
    repositoryId,
    kind: "plain-folder",
    availability: "available",
    head: { kind: "none" },
    observedAt: now,
  });
  const support: { value: unknown } = {
    value: Object.hasOwn(options, "capability") ? options.capability : true,
  };
  const controls: {
    beforeReferences?: () => Promise<void>;
    result?: unknown;
    beforeRoot?: (count: number) => Promise<void>;
    root?: string;
    componentKey?: string;
  } = {};
  let rootQueries = 0;
  let notify: (method: string, params: unknown) => void = () => undefined;
  let disconnect: () => void = () => undefined;
  const state = { thread, checkout: identity, reach: true, enabled: true, support, controls };
  const received: Array<{ method: string; params: unknown }> = [];
  const launches: Array<string> = [];
  const component = {
    componentKey: "controlled-reference-server",
    approvalKey: "controlled-reference-server",
    languages: ["typescript"],
    launchClass: "static" as const,
    executable: async () => process.execPath,
    args: [],
    installRoot: install,
    sourceLabel: "fixture",
  };
  const namedPath = decodeCodeProjectFilePath(
    options.extraFolder ? join(checkout, "b.ts") : "b.ts",
  );
  const fileId = deriveCodeFileId(String(thread.id), String(identity.id), namedPath);
  const service = new CodeLanguageService({
    authority: {
      readThread: (id) => (String(id) === String(state.thread.id) ? state.thread : undefined),
      readThreads: () => [state.thread],
      readCheckout: (id) => (String(id) === String(state.checkout.id) ? state.checkout : undefined),
      readThreadFolder: () => checkout,
      canAccessProject: () => state.reach,
      effectiveThread: (_scope, current) => current,
      resolveRoot: async (_scope, current, currentCheckout, path) => {
        const query = ++rootQueries;
        await controls.beforeRoot?.(query);
        const bound = controls.root ?? checkout;
        return {
          fileId: deriveCodeFileId(String(current.id), String(currentCheckout.id), path),
          rootPath: bound,
          ...(options.extraFolder ? { relativePath: decodeCodeProjectFilePath("b.ts") } : {}),
          rootIdentity: { device: String(statSync(bound).dev), inode: String(statSync(bound).ino) },
        };
      },
    },
    components: () =>
      state.enabled
        ? [{ ...component, componentKey: controls.componentKey ?? component.componentKey }]
        : [],
    turnedOffComponents: () => (state.enabled ? [] : [component]),
    platform: "linux",
    cacheRoot: join(root, "cache"),
    limits: { requestDeadlineMs: options.requestDeadlineMs ?? 1000 },
    processes: {
      launch: async (input) => {
        launches.push(input.checkoutRoot);
        const fromServer = new PassThrough();
        const toServer = new PassThrough();
        let buffered = Buffer.alloc(0);
        let end: () => void = () => undefined;
        const exited = new Promise<void>((resolve) => {
          end = resolve;
        });
        disconnect = () => {
          toServer.end();
          fromServer.end();
          end();
        };
        notify = (method, params) => {
          const body = Buffer.from(
            JSON.stringify({ jsonrpc: "2.0", id: "server-registration", method, params }),
          );
          fromServer.write(
            Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]),
          );
        };
        const send = (id: unknown, result: unknown) => {
          if (fromServer.writableEnded || fromServer.destroyed) return;
          const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }));
          fromServer.write(
            Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]),
          );
        };
        toServer.on("data", (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk]);
          for (;;) {
            const offset = buffered.indexOf("\r\n\r\n");
            if (offset < 0) return;
            const length = Number(
              /Content-Length: (\d+)/.exec(buffered.subarray(0, offset).toString())?.[1],
            );
            if (buffered.length < offset + 4 + length) return;
            const message = JSON.parse(
              buffered.subarray(offset + 4, offset + 4 + length).toString(),
            );
            buffered = buffered.subarray(offset + 4 + length);
            received.push({ method: message.method, params: message.params });
            if (message.method === "initialize")
              send(message.id, {
                capabilities: {
                  textDocumentSync: 1,
                  definitionProvider: true,
                  referencesProvider: state.support.value,
                },
              });
            else if (message.method === "shutdown") send(message.id, null);
            else if (message.method === "exit") {
              toServer.end();
              fromServer.end();
              end();
            } else if (message.method === "textDocument/definition") send(message.id, []);
            else if (message.method === "textDocument/references")
              void (async () => {
                await controls.beforeReferences?.();
                send(
                  message.id,
                  Object.hasOwn(controls, "result")
                    ? controls.result
                    : [
                        {
                          uri: pathToFileURL(join(checkout, "a.ts")).href,
                          range: {
                            start: { line: 0, character: 13 },
                            end: { line: 0, character: 18 },
                          },
                        },
                        {
                          uri: pathToFileURL(join(checkout, "b.ts")).href,
                          range: {
                            start: { line: 1, character: 12 },
                            end: { line: 1, character: 17 },
                          },
                        },
                        {
                          uri: pathToFileURL(join(checkout, "escape.ts")).href,
                          range: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 1 },
                          },
                        },
                      ],
                );
              })();
          }
        });
        return {
          status: "launched",
          process: {
            stdin: toServer,
            stdout: fromServer,
            exited,
            kill: async () => {
              toServer.end();
              fromServer.end();
              end();
            },
          },
        };
      },
    },
  });
  cleanups.push(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const caller = { scopeId, principal: "local-window" as const };
  let acknowledgedRevision = "90000000-0000-4000-8000-000000000001";
  return {
    service,
    state,
    received,
    launches,
    root,
    checkout,
    fileId,
    caller,
    disconnect: () => disconnect(),
    notify: (method: string, params: unknown) => notify(method, params),
    open: async () => {
      const result = await service.syncDocument(caller, {
        kind: "open",
        threadId: thread.id,
        checkoutId: identity.id,
        path: namedPath,
        text: 'import { value } from "./a";\nconsole.log(value);\n',
      });
      if (result.status === "synced" && result.documentRevision !== undefined)
        acknowledgedRevision = result.documentRevision;
      return result;
    },
    capabilities: () =>
      service.read(
        caller,
        decodeCodeLanguageReadRequest({
          kind: "capabilities",
          threadId: thread.id,
          checkoutId: identity.id,
          fileId,
        }),
      ),
    references: () =>
      service.read(
        caller,
        decodeCodeLanguageReadRequest({
          kind: "references",
          threadId: thread.id,
          checkoutId: identity.id,
          fileId,
          position: { line: 1, character: 13 },
          includeDeclaration: true,
          expectedVersion: 1,
          expectedRevision: acknowledgedRevision,
        }),
      ),
  };
}
describe("current document references through real companion and controlled stdio", () => {
  it("maps cross-file references and redacts a hostile symlink without executing a server command", async () => {
    const f = fixture();
    expect(await f.open()).toMatchObject({ status: "synced" });
    const answer = await f.references();
    expect(answer).toMatchObject({
      status: "references",
      documentVersion: 1,
      truncated: false,
      targets: [
        { kind: "checkout-location", path: "a.ts" },
        { kind: "checkout-location", path: "b.ts" },
        { kind: "outside-checkout", label: "elsewhere" },
      ],
    });
    expect(
      f.received.filter((message) => message.method === "textDocument/references"),
    ).toHaveLength(1);
    expect(f.launches).toEqual([f.checkout]);
  });
  it("keeps an extra-folder read inside its authorized root and existing absolute file-open identity", async () => {
    const f = fixture({ extraFolder: true });
    await f.open();
    const result = await f.references();
    expect(result).toMatchObject({
      status: "references",
      targets: [
        { kind: "checkout-location", path: join(f.checkout, "a.ts") },
        { kind: "checkout-location", path: join(f.checkout, "b.ts") },
        { kind: "outside-checkout", label: "elsewhere" },
      ],
    });
    expect(f.launches).toEqual([f.checkout]);
  });
  it.each([false, undefined, null, "yes"])(
    "does not infer reference support from a server with capability=%s",
    async (capability) => {
      const f = fixture({ capability });
      await f.open();
      const expected = capability === false || capability === undefined ? "unsupported" : "unknown";
      expect(await f.capabilities()).toMatchObject({
        status: "capabilities",
        references: expected,
      });
      expect(await f.references()).toEqual({
        status: "unsupported",
        capability: "references",
        support: expected,
      });
      expect(f.received.some((message) => message.method === "textDocument/references")).toBe(
        false,
      );
    },
  );
  it("uses exact matching dynamic registration and removes it when the server unregisters", async () => {
    const f = fixture({ capability: false });
    await f.open();
    f.notify("client/registerCapability", {
      registrations: [
        {
          id: "refs",
          method: "textDocument/references",
          registerOptions: { documentSelector: [{ language: "typescript", scheme: "file" }] },
        },
      ],
    });
    expect(await f.capabilities()).toMatchObject({ references: "supported" });
    expect(await f.references()).toMatchObject({ status: "references" });
    f.notify("client/unregisterCapability", {
      unregisterations: [{ id: "refs", method: "textDocument/references" }],
    });
    expect(await f.capabilities()).toMatchObject({ references: "unsupported" });
    expect(await f.references()).toEqual({
      status: "unsupported",
      capability: "references",
      support: "unsupported",
    });
  });
  it("keeps unsupported selector patterns unknown rather than enabling a project-wide action", async () => {
    const f = fixture({ capability: false });
    await f.open();
    f.notify("client/registerCapability", {
      registrations: [
        {
          id: "refs",
          method: "textDocument/references",
          registerOptions: { documentSelector: [{ language: "typescript", pattern: "**/*.ts" }] },
        },
      ],
    });
    expect(await f.capabilities()).toMatchObject({ references: "unknown" });
    expect(await f.references()).toMatchObject({ status: "unsupported", support: "unknown" });
  });
  it.each(["document", "reach", "checkout", "component", "registration", "deadline"] as const)(
    "refuses results after a held response changes %s",
    async (change) => {
      const f = fixture({ capability: change === "registration" ? false : true });
      await f.open();
      if (change === "registration")
        f.notify("client/registerCapability", {
          registrations: [{ id: "refs", method: "textDocument/references" }],
        });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.state.controls.beforeReferences = () => held;
      const clock = change === "deadline" ? vi.spyOn(performance, "now") : undefined;
      const base = performance.now();
      if (clock) clock.mockReturnValue(base);
      const read = f.references();
      try {
        await vi.waitFor(() =>
          expect(f.received.some((message) => message.method === "textDocument/references")).toBe(
            true,
          ),
        );
        if (change === "document")
          await f.service.syncDocument(f.caller, {
            kind: "change",
            threadId: f.state.thread.id,
            checkoutId: f.state.checkout.id,
            fileId: f.fileId,
            text: "unsaved next version",
          });
        if (change === "reach") f.state.reach = false;
        if (change === "checkout")
          f.state.checkout = { ...f.state.checkout, availability: "unavailable" };
        if (change === "component") f.state.enabled = false;
        if (change === "registration")
          f.notify("client/unregisterCapability", {
            unregisterations: [{ id: "refs", method: "textDocument/references" }],
          });
        if (clock) clock.mockReturnValue(base + 1001);
        release();
        const answer = await read;
        if (change === "document") expect(answer).toEqual({ status: "stale" });
        if (change === "reach") expect(answer).toEqual({ status: "refused", reason: "no-reach" });
        if (change === "checkout")
          expect(answer).toEqual({ status: "refused", reason: "checkout-unavailable" });
        if (change === "component")
          expect(answer).toEqual({ status: "refused", reason: "turned-off" });
        if (change === "registration")
          expect(answer).toMatchObject({ status: "unsupported", support: "unsupported" });
        if (change === "deadline")
          expect(answer).toEqual({ status: "unavailable", reason: "timed-out" });
      } finally {
        release();
        clock?.mockRestore();
        await read;
      }
    },
  );

  it("rechecks the actual current root after mapping before publishing locations", async () => {
    const f = fixture();
    await f.open();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    f.state.controls.beforeRoot = async (count) => {
      if (count === 3) {
        waiting = true;
        await held;
      }
    };
    const read = f.references();
    try {
      await vi.waitFor(() => expect(waiting).toBe(true));
      const next = join(f.root, "rebound");
      mkdirSync(next);
      writeFileSync(join(next, "b.ts"), "another checkout body");
      f.state.controls.root = next;
      release();
      expect(await read).toEqual({ status: "stale" });
    } finally {
      release();
      await read;
    }
  });

  it.each(["component", "root", "same-path-root"] as const)(
    "never starts or retargets a server when a read sees %s replacement",
    async (change) => {
      const f = fixture();
      await f.open();
      if (change === "component") f.state.controls.componentKey = "replacement-component";
      else if (change === "root") {
        const next = join(f.root, "replacement-checkout");
        mkdirSync(next);
        writeFileSync(join(next, "b.ts"), "replacement body");
        f.state.controls.root = next;
      } else {
        renameSync(f.checkout, join(f.root, "previous-checkout"));
        mkdirSync(f.checkout);
        writeFileSync(join(f.checkout, "b.ts"), "replacement body");
      }
      expect(await f.capabilities()).toEqual({ status: "stale" });
      expect(await f.references()).toEqual({ status: "stale" });
      expect(f.launches).toEqual([f.checkout]);
      expect(f.received.some((message) => message.method === "textDocument/references")).toBe(
        false,
      );
    },
  );

  it("refuses an acknowledged numeric version reused by a replacement open document", async () => {
    const f = fixture();
    const original = await f.open();
    if (original.status !== "synced") throw new Error("Current host did not acknowledge document");
    const oldRevision = original.documentRevision ?? "90000000-0000-4000-8000-000000000001";
    await f.service.syncDocument(f.caller, {
      kind: "close",
      threadId: f.state.thread.id,
      checkoutId: f.state.checkout.id,
      fileId: f.fileId,
    });
    await f.open();
    const request = {
      kind: "references" as const,
      threadId: f.state.thread.id,
      checkoutId: f.state.checkout.id,
      fileId: f.fileId,
      position: { line: 1, character: 13 },
      includeDeclaration: true,
      expectedVersion: 1,
      expectedRevision: oldRevision,
    };
    expect(await f.service.read(f.caller, request)).toEqual({ status: "stale" });
    expect(f.received.some((message) => message.method === "textDocument/references")).toBe(false);
  });

  it("refuses an old acknowledgement after the connection reopens the same numeric document version", async () => {
    const f = fixture();
    const opened = await f.open();
    if (opened.status !== "synced") throw new Error("Current host did not acknowledge document");
    const oldRevision = opened.documentRevision ?? "90000000-0000-4000-8000-000000000001";
    f.disconnect();
    await vi.waitFor(() => expect(f.launches).toHaveLength(2));
    const request = {
      kind: "references" as const,
      threadId: f.state.thread.id,
      checkoutId: f.state.checkout.id,
      fileId: f.fileId,
      position: { line: 1, character: 13 },
      includeDeclaration: true,
      expectedVersion: 1,
      expectedRevision: oldRevision,
    };
    expect(await f.service.read(f.caller, request)).toEqual({ status: "stale" });
    expect(f.received.some((message) => message.method === "textDocument/references")).toBe(false);
  });
});
