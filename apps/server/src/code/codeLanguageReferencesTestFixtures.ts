import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach } from "vitest";
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
export function codeLanguageReferencesFixture(
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
  const caller = { scopeId, principal: "local-window" as const, isCurrent: () => true };
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
