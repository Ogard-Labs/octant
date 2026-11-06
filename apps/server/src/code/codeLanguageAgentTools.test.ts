import {
  CODE_LANGUAGE_TOOL_NAME,
  MAX_CODE_LANGUAGE_AGENT_REFERENCES,
  decodeCodeThread,
  decodeToolActionAuthority,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { createCodeLanguageAgentTools } from "./codeLanguageAgentTools";
import type { CodeLanguageAgentRead, CodeLanguageAgentReadResult } from "./codeLanguageService";

const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const now = "2026-10-27T12:00:00.000Z";

function codeThread(overrides: Record<string, unknown> = {}): CodeThread {
  return decodeCodeThread({
    id: "20000000-0000-4000-8000-000000000001",
    projectId: "40000000-0000-4000-8000-000000000001",
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "Language reads",
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

const authority = decodeToolActionAuthority({
  hostId: "11111111-1111-4111-8111-111111111111",
  mode: "code",
  projectId: "40000000-0000-4000-8000-000000000001",
  rootId: "70000000-0000-4000-8000-000000000001",
  worktreeId: "30000000-0000-4000-8000-000000000001",
  providerInstanceId: "60000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
});

function tools(
  input: {
    readonly thread?: CodeThread;
    readonly current?: () => CodeThread | undefined;
    readonly authority?: () => typeof authority | undefined;
    readonly answer?: CodeLanguageAgentReadResult;
    readonly served?: boolean;
  } = {},
) {
  const thread = input.thread ?? codeThread();
  let uuid = 0;
  const readForAgent = vi.fn(
    async (
      _scopeId: WindowId,
      request: CodeLanguageAgentRead,
    ): Promise<CodeLanguageAgentReadResult> =>
      input.answer ??
      (request.kind === "references"
        ? {
            status: "references",
            threadId: thread.id,
            checkoutId: thread.checkoutId,
            fileId: "50000000-0000-4000-8000-000000000001" as never,
            documentVersion: 1,
            documentRevision: "90000000-0000-4000-8000-000000000001",
            targets: Array.from({ length: MAX_CODE_LANGUAGE_AGENT_REFERENCES + 1 }, (_, line) => ({
              kind: "checkout-location" as const,
              path: "b.ts" as never,
              range: { start: { line, character: 2 }, end: { line, character: 7 } },
            })),
            truncated: false,
          }
        : request.kind === "diagnostics"
          ? {
              status: "diagnostics",
              threadId: thread.id,
              checkoutId: thread.checkoutId,
              fileId: "50000000-0000-4000-8000-000000000001" as never,
              diagnostics: [
                {
                  path: request.path,
                  range: { start: { line: 1, character: 13 }, end: { line: 1, character: 18 } },
                  severity: "error",
                  message: "Type 'string' is not assignable to type 'number'.",
                  source: "typescript",
                },
              ],
              truncated: false,
            }
          : {
              status: "definition",
              threadId: thread.id,
              checkoutId: thread.checkoutId,
              fileId: "50000000-0000-4000-8000-000000000001" as never,
              targets: [
                {
                  kind: "checkout-location",
                  path: "a.ts" as never,
                  range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
                },
                { kind: "outside-checkout", label: "bundled-library" },
              ],
            }),
  );
  const servesAgentsIn = vi.fn(() => input.served ?? true);
  const offered = createCodeLanguageAgentTools({
    windowId,
    thread,
    folders: ["/checkout"],
    readThread: input.current ?? (() => thread),
    authority: input.authority ?? (() => authority),
    externalContentIngested: () => false,
    language: { readForAgent, servesAgentsIn },
    uuid: () => `80000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  const set: AppManagedToolSet = offered ?? {
    definitions: [],
    execute: async () => ({ result: {} }),
  };
  const call = async (value: unknown, name: string = CODE_LANGUAGE_TOOL_NAME) =>
    set.execute({ name, inputJson: JSON.stringify(value) });
  return { offered, set, call, readForAgent, servesAgentsIn };
}

describe("Code language agent tools", () => {
  it("offers one octant_code tool to a Plan thread whose checkout a server an agent may start covers", () => {
    const covered = tools();
    expect(covered.offered?.definitions.map((definition) => definition.name)).toEqual([
      CODE_LANGUAGE_TOOL_NAME,
    ]);
    expect(covered.servesAgentsIn).toHaveBeenCalledWith(["/checkout"]);
  });

  it("offers nothing where no server an agent may start covers the checkout, or a profile leaves the tool out", () => {
    expect(tools({ served: false }).offered).toBeUndefined();
    expect(
      tools({ thread: codeThread({ toolConstraints: ["octant_terminal"] }) }).offered,
    ).toBeUndefined();
  });

  it("reads a Plan thread's saved file through the language service and numbers lines from one", async () => {
    const { call, readForAgent } = tools();
    await expect(call({ operation: "diagnostics", path: "src/b.ts" })).resolves.toEqual({
      result: {
        path: "src/b.ts",
        diagnostics: [
          {
            line: 2,
            column: 14,
            endLine: 2,
            endColumn: 19,
            severity: "error",
            message: "Type 'string' is not assignable to type 'number'.",
            source: "typescript",
          },
        ],
        truncated: false,
      },
      isError: false,
    });
    expect(readForAgent).toHaveBeenCalledWith(windowId, {
      kind: "diagnostics",
      threadId: codeThread().id,
      checkoutId: codeThread().checkoutId,
      path: "src/b.ts",
    });

    await expect(
      call({ operation: "definition", path: "src/b.ts", line: 2, column: 31 }),
    ).resolves.toEqual({
      result: {
        path: "src/b.ts",
        line: 2,
        column: 31,
        definitions: [
          { path: "a.ts", line: 1, column: 17, endLine: 1, endColumn: 22 },
          { outsideCheckout: "bundled-library" },
        ],
      },
      isError: false,
    });
    expect(readForAgent).toHaveBeenLastCalledWith(windowId, {
      kind: "definition",
      threadId: codeThread().id,
      checkoutId: codeThread().checkoutId,
      path: "src/b.ts",
      position: { line: 1, character: 30 },
    });
  });

  it("refuses a path out of the checkout, a stale thread, and a profile that leaves the read out, before reading", async () => {
    const outside = tools();
    // An absolute path is a valid name here: the service places it in an extra folder or refuses it.
    for (const path of ["//etc/passwd", "../secret.ts", "a/../../b.ts"]) {
      await expect(outside.call({ operation: "diagnostics", path })).resolves.toMatchObject({
        result: { error: "invalid-tool-input" },
        isError: true,
      });
    }
    await expect(
      outside.call({ operation: "definition", path: "a.ts", line: 0, column: 1 }),
    ).resolves.toMatchObject({ result: { error: "invalid-tool-input" }, isError: true });
    expect(outside.readForAgent).not.toHaveBeenCalled();

    const stale = tools({ authority: () => undefined });
    await expect(stale.call({ operation: "diagnostics", path: "a.ts" })).resolves.toMatchObject({
      result: { error: "tool-authority-stale" },
      isError: true,
    });
    const gone = tools({ current: () => undefined });
    await expect(gone.call({ operation: "diagnostics", path: "a.ts" })).resolves.toMatchObject({
      result: { error: "tool-authority-stale" },
      isError: true,
    });
    // A profile narrowed after the turn began is honoured on the next call.
    const narrowed = tools({
      current: () => codeThread({ toolConstraints: ["octant_terminal"] }),
    });
    await expect(narrowed.call({ operation: "diagnostics", path: "a.ts" })).resolves.toMatchObject({
      result: { error: "tool-refused" },
      isError: true,
    });
    expect(stale.readForAgent).not.toHaveBeenCalled();
    expect(gone.readForAgent).not.toHaveBeenCalled();
    expect(narrowed.readForAgent).not.toHaveBeenCalled();
  });

  it("says what to do when the server cannot answer, and never answers from an editor's draft", async () => {
    const cases: ReadonlyArray<readonly [CodeLanguageAgentReadResult, string]> = [
      [{ status: "unavailable", reason: "starting" }, "language-server-starting"],
      [{ status: "unavailable", reason: "crashed" }, "language-server-crashed"],
      [{ status: "unavailable", reason: "timed-out" }, "language-server-timed-out"],
      [{ status: "refused", reason: "no-language-server" }, "no-language-server"],
      [{ status: "refused", reason: "turned-off" }, "turned-off"],
      [{ status: "refused", reason: "local-host-required" }, "local-host-required"],
      [{ status: "too-large" }, "too-large"],
      [{ status: "unsaved-edits" }, "unsaved-edits"],
      [{ status: "stale" }, "file-changed"],
      [
        { status: "unsupported", capability: "references", support: "unsupported" },
        "references-unsupported",
      ],
      [
        { status: "unsupported", capability: "references", support: "unknown" },
        "language-server-starting",
      ],
    ];
    for (const [answer, error] of cases) {
      const outcome = await tools({ answer }).call({ operation: "diagnostics", path: "a.ts" });
      expect(outcome).toMatchObject({ result: { error }, isError: true });
      expect((outcome.result as { readonly message?: string }).message).toMatch(/\S/u);
    }
  });

  it("lists where a name is used in a Plan thread, numbered from one and bounded", async () => {
    const { call, readForAgent } = tools();
    const outcome = await call({
      operation: "references",
      path: "src/b.ts",
      line: 2,
      column: 31,
      includeDeclaration: true,
    });
    expect(outcome.isError).toBe(false);
    const result = outcome.result as {
      readonly references: ReadonlyArray<unknown>;
      readonly truncated: boolean;
    };
    expect(result.references).toHaveLength(MAX_CODE_LANGUAGE_AGENT_REFERENCES);
    expect(result.references[0]).toEqual({
      path: "b.ts",
      line: 1,
      column: 3,
      endLine: 1,
      endColumn: 8,
    });
    expect(result.truncated).toBe(true);
    expect(readForAgent).toHaveBeenLastCalledWith(windowId, {
      kind: "references",
      threadId: codeThread().id,
      checkoutId: codeThread().checkoutId,
      path: "src/b.ts",
      position: { line: 1, character: 30 },
      includeDeclaration: true,
    });
  });

  it("stops listing places before the result outgrows the provider's tool result budget, and says so", async () => {
    const thread = codeThread();
    const deepPath = `${"deep/".repeat(60)}name.ts`;
    const { call } = tools({
      thread,
      answer: {
        status: "references",
        threadId: thread.id,
        checkoutId: thread.checkoutId,
        fileId: "50000000-0000-4000-8000-000000000001" as never,
        documentVersion: 1,
        documentRevision: "90000000-0000-4000-8000-000000000001",
        targets: Array.from({ length: MAX_CODE_LANGUAGE_AGENT_REFERENCES }, (_, line) => ({
          kind: "checkout-location" as const,
          path: deepPath as never,
          range: { start: { line, character: 2 }, end: { line, character: 7 } },
        })),
        truncated: false,
      },
    });
    const outcome = await call({ operation: "references", path: "src/b.ts", line: 2, column: 31 });
    expect(outcome.isError).toBe(false);
    const result = outcome.result as {
      readonly references: ReadonlyArray<unknown>;
      readonly truncated: boolean;
    };
    expect(Buffer.byteLength(JSON.stringify(outcome.result), "utf8")).toBeLessThan(64 * 1024);
    expect(result.references.length).toBeGreaterThan(0);
    expect(result.references.length).toBeLessThan(MAX_CODE_LANGUAGE_AGENT_REFERENCES);
    expect(result.truncated).toBe(true);
  });

  it("returns every place when there are exactly as many as the bound, without calling the list truncated", async () => {
    const thread = codeThread();
    const { call } = tools({
      thread,
      answer: {
        status: "references",
        threadId: thread.id,
        checkoutId: thread.checkoutId,
        fileId: "50000000-0000-4000-8000-000000000001" as never,
        documentVersion: 1,
        documentRevision: "90000000-0000-4000-8000-000000000001",
        targets: Array.from({ length: MAX_CODE_LANGUAGE_AGENT_REFERENCES }, (_, line) => ({
          kind: "checkout-location" as const,
          path: "b.ts" as never,
          range: { start: { line, character: 2 }, end: { line, character: 7 } },
        })),
        truncated: false,
      },
    });
    const outcome = await call({ operation: "references", path: "src/b.ts", line: 2, column: 31 });
    expect(outcome.result).toMatchObject({ truncated: false });
    expect(
      (outcome.result as { readonly references: ReadonlyArray<unknown> }).references,
    ).toHaveLength(MAX_CODE_LANGUAGE_AGENT_REFERENCES);
  });

  it("stops listing diagnostics before the result outgrows the provider's tool result budget, and says so", async () => {
    const thread = codeThread();
    const { call } = tools({
      thread,
      answer: {
        status: "diagnostics",
        threadId: thread.id,
        checkoutId: thread.checkoutId,
        fileId: "50000000-0000-4000-8000-000000000001" as never,
        diagnostics: Array.from({ length: 1_000 }, (_, line) => ({
          path: "src/b.ts" as never,
          range: { start: { line, character: 0 }, end: { line, character: 4 } },
          severity: "error" as const,
          message: "x".repeat(2_048),
          source: "typescript",
        })),
        truncated: false,
      },
    });
    const outcome = await call({ operation: "diagnostics", path: "src/b.ts" });
    expect(outcome.isError).toBe(false);
    const result = outcome.result as {
      readonly diagnostics: ReadonlyArray<unknown>;
      readonly truncated: boolean;
    };
    expect(Buffer.byteLength(JSON.stringify(outcome.result), "utf8")).toBeLessThan(64 * 1024);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });

  it("answers no tool it does not offer", async () => {
    await expect(tools().call({}, "octant_terminal")).resolves.toMatchObject({
      result: { error: "tool-unavailable" },
      isError: true,
    });
  });
});
