import { describe, expect, it } from "vitest";

import {
  decodeAccountReadResult,
  decodeCodexServerMessage,
  decodeInitializeResult,
  decodeModelListResult,
  decodeThreadResumeResult,
  decodeThreadStartResult,
  decodeTurnInterruptResult,
  decodeTurnStartResult,
} from "./codexProtocol";

const thread = {
  id: "thread-1",
  sessionId: "session-1",
  cwd: "/tmp/project",
  turns: [],
  providerOnly: "strip-me",
};

const turn = {
  id: "turn-1",
  status: "inProgress",
  items: [],
  providerOnly: "strip-me",
};

describe("Codex stable 0.144.4 protocol", () => {
  it("decodes only the result fields consumed by Octant", () => {
    expect(
      decodeInitializeResult({
        userAgent: "codex-cli/0.144.4",
        codexHome: "/private/codex-home",
        platformFamily: "unix",
        platformOs: "macos",
        futureField: true,
      }),
    ).toEqual({ userAgent: "codex-cli/0.144.4" });

    expect(
      decodeAccountReadResult({
        account: { type: "chatgpt", email: "private@example.test", planType: "plus" },
        requiresOpenaiAuth: true,
        futureField: true,
      }),
    ).toEqual({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });

    expect(
      decodeModelListResult({
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "GPT-5.4",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Balanced", futureField: true },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
            serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
            defaultServiceTier: "fast",
            isDefault: true,
            description: "provider-only",
          },
        ],
        nextCursor: "cursor-2",
        futureField: true,
      }),
    ).toEqual({
      data: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
          serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
          defaultServiceTier: "fast",
          isDefault: true,
        },
      ],
      nextCursor: "cursor-2",
    });

    const threadResult = {
      thread,
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/tmp/project",
      instructionSources: ["/private/instructions"],
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      reasoningEffort: "medium",
      futureField: true,
    };
    const expectedThreadResult = {
      thread: { id: "thread-1" },
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/tmp/project",
    };
    expect(decodeThreadStartResult(threadResult)).toEqual(expectedThreadResult);
    expect(decodeThreadResumeResult(threadResult)).toEqual(expectedThreadResult);

    expect(decodeTurnStartResult({ turn, futureField: true })).toEqual({
      turn: { id: "turn-1", status: "inProgress" },
    });
    expect(decodeTurnInterruptResult({ futureField: true })).toEqual({});
  });

  it("decodes responses without requiring a jsonrpc member", () => {
    expect(decodeCodexServerMessage({ id: 1, result: { ok: true }, futureField: true })).toEqual({
      kind: "response",
      id: 1,
      result: { ok: true },
    });
    expect(
      decodeCodexServerMessage({
        id: "request-2",
        error: { code: -32001, message: "overloaded", data: { private: true } },
      }),
    ).toEqual({
      kind: "response",
      id: "request-2",
      error: { code: -32001, message: "overloaded" },
    });
    expect(() => decodeCodexServerMessage({ id: true, result: {} })).toThrow();
    expect(() => decodeCodexServerMessage({ id: 1.5, result: {} })).toThrow();
    expect(() =>
      decodeCodexServerMessage({ id: 2, error: { code: -32001.5, message: "invalid" } }),
    ).toThrow();
    expect(() =>
      decodeCodexServerMessage({ id: 2.5, method: "future/request", params: {} }),
    ).toThrow();
  });

  it("decodes correlated stable notification families and strips provider fields", () => {
    const fixtures = [
      {
        method: "turn/started",
        params: { threadId: "thread-1", turn, futureField: true },
      },
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
          futureField: true,
        },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-2",
          delta: "Summary",
          summaryIndex: 0,
          futureField: true,
        },
      },
      {
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-2",
          delta: "Reasoning",
          contentIndex: 0,
          futureField: true,
        },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "item-3",
            command: "pwd",
            cwd: "/tmp/project",
            status: "inProgress",
            futureField: true,
          },
          startedAtMs: 10,
          futureField: true,
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            id: "item-4",
            changes: [
              {
                path: "/tmp/project/a.ts",
                kind: { type: "update", move_path: null },
                diff: "+export const value = 1;",
              },
            ],
            status: "completed",
            futureField: true,
          },
          completedAtMs: 20,
          futureField: true,
        },
      },
      {
        method: "turn/diff/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff: "diff --git a/a.ts b/a.ts",
          futureField: true,
        },
      },
      {
        method: "turn/plan/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [{ step: "Implement", status: "inProgress", futureField: true }],
          futureField: true,
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 10,
              inputTokens: 6,
              cachedInputTokens: 2,
              outputTokens: 4,
              reasoningOutputTokens: 1,
            },
            last: {
              totalTokens: 5,
              inputTokens: 3,
              cachedInputTokens: 1,
              outputTokens: 2,
              reasoningOutputTokens: 1,
            },
            modelContextWindow: 128_000,
            futureField: true,
          },
          futureField: true,
        },
      },
    ] as const;

    for (const fixture of fixtures) {
      const decoded = decodeCodexServerMessage(fixture);
      expect(decoded).toMatchObject({ kind: "notification", method: fixture.method });
      expect(decoded).not.toHaveProperty("params.futureField");
    }
  });

  it("does not forward raw tool results through item lifecycle messages", () => {
    expect(
      decodeCodexServerMessage({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "item-5",
            server: "filesystem",
            tool: "read_file",
            status: "completed",
            result: { content: [{ type: "text", text: "private provider output" }] },
            error: null,
            durationMs: 10,
          },
          completedAtMs: 30,
        },
      }),
    ).toEqual({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "item-5",
          server: "filesystem",
          tool: "read_file",
          status: "completed",
          durationMs: 10,
        },
        completedAtMs: 30,
      },
    });
  });

  it("decodes web search lifecycle items and keeps only the query", () => {
    expect(
      decodeCodexServerMessage({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webSearch",
            id: "exec-1",
            query: "Stavanger weather tomorrow",
            action: { type: "search", query: "Stavanger weather tomorrow" },
            results: [{ title: "Forecast", url: "https://example.invalid" }],
          },
          completedAtMs: 30,
        },
      }),
    ).toEqual({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "webSearch", id: "exec-1", query: "Stavanger weather tomorrow" },
        completedAtMs: 30,
      },
    });
  });

  it("decodes item types Octant does not model as opaque items instead of failing the connection", () => {
    expect(
      decodeCodexServerMessage({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "imageView", id: "item-9", path: "/private/shot.png" },
          startedAtMs: 10,
        },
      }),
    ).toEqual({
      kind: "notification",
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "imageView", id: "item-9" },
        startedAtMs: 10,
      },
    });
    // Known item types keep their strict shape.
    expect(() =>
      decodeCodexServerMessage({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "commandExecution", id: "item-2" },
          startedAtMs: 10,
        },
      }),
    ).toThrow();
  });

  it("decodes stable user-message and compaction lifecycle metadata without content", () => {
    const items = [
      {
        input: {
          type: "userMessage",
          id: "item-user",
          clientId: "private-client-correlation",
          content: [{ type: "text", text: "private prompt" }],
        },
        expected: { type: "userMessage", id: "item-user" },
      },
      {
        input: { type: "contextCompaction", id: "item-compaction", providerOnly: true },
        expected: { type: "contextCompaction", id: "item-compaction" },
      },
    ] as const;

    for (const item of items) {
      expect(
        decodeCodexServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: item.input,
            startedAtMs: 40,
          },
        }),
      ).toEqual({
        kind: "notification",
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: item.expected,
          startedAtMs: 40,
        },
      });
      expect(
        decodeCodexServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: item.input,
            completedAtMs: 50,
          },
        }),
      ).toEqual({
        kind: "notification",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: item.expected,
          completedAtMs: 50,
        },
      });
    }
  });

  it.each(["completed", "interrupted", "failed"] as const)(
    "decodes the %s turn terminal status",
    (status) => {
      expect(
        decodeCodexServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status, providerOnly: "strip-me" },
          },
        }),
      ).toEqual({
        kind: "notification",
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status } },
      });
    },
  );

  it("decodes only the three stable approval requests", () => {
    const requests = [
      {
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 10,
          environmentId: null,
          reason: "network",
          command: "curl example.test",
          cwd: "/tmp/project",
          futureField: true,
        },
      },
      {
        id: "file-approval",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-2",
          startedAtMs: 20,
          reason: "write",
          grantRoot: null,
          futureField: true,
        },
      },
      {
        id: 3,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-3",
          environmentId: null,
          startedAtMs: 30,
          cwd: "/tmp/project",
          reason: "network",
          permissions: {
            network: { enabled: true },
            fileSystem: null,
            futureField: true,
          },
          futureField: true,
        },
      },
    ] as const;

    for (const request of requests) {
      const decoded = decodeCodexServerMessage(request);
      expect(decoded).toMatchObject({
        kind: "request",
        id: request.id,
        method: request.method,
      });
      expect(decoded).not.toHaveProperty("params.futureField");
    }

    const specialPathRequest = decodeCodexServerMessage({
      id: 4,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-4",
        environmentId: null,
        startedAtMs: 40,
        cwd: "/tmp/project",
        reason: "temporary files",
        permissions: {
          network: null,
          fileSystem: {
            read: null,
            write: null,
            entries: [
              {
                path: { type: "special", value: { kind: "tmpdir", futureField: true } },
                access: "write",
              },
            ],
          },
        },
      },
    });
    expect(specialPathRequest).not.toHaveProperty(
      "params.permissions.fileSystem.entries.0.path.value.futureField",
    );
  });

  it("classifies experimental and unknown server requests as unsupported", () => {
    expect(
      decodeCodexServerMessage({
        id: 9,
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "secret", question: "Secret?" }] },
      }),
    ).toEqual({ kind: "unsupported-request", id: 9, method: "item/tool/requestUserInput" });
    expect(
      decodeCodexServerMessage({ id: "unknown-1", method: "future/request", params: {} }),
    ).toEqual({ kind: "unsupported-request", id: "unknown-1", method: "future/request" });
    expect(
      decodeCodexServerMessage({ method: "future/notification", params: { private: true } }),
    ).toEqual({ kind: "unknown-notification", method: "future/notification" });
  });

  it.each(["toString", "constructor"])(
    "classifies prototype-chain method %s without consulting inherited properties",
    (method) => {
      expect(decodeCodexServerMessage({ id: 10, method, params: {} })).toEqual({
        kind: "unsupported-request",
        id: 10,
        method,
      });
      expect(decodeCodexServerMessage({ method, params: {} })).toEqual({
        kind: "unknown-notification",
        method,
      });
    },
  );

  it("rejects malformed correlations and token counts", () => {
    expect(() =>
      decodeCodexServerMessage({
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", itemId: "item-1", delta: "missing thread" },
      }),
    ).toThrow();
    expect(() =>
      decodeCodexServerMessage({
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 10,
          environmentId: null,
          networkApprovalContext: { host: "example.test", protocol: "ftp" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeCodexServerMessage({
        id: 1,
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 20 },
      }),
    ).toThrow();
    expect(() =>
      decodeCodexServerMessage({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { status: "completed" } },
      }),
    ).toThrow();
    expect(() =>
      decodeCodexServerMessage({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: -1,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: null,
          },
        },
      }),
    ).toThrow();
  });
});
