import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  decodeAccountReadResult,
  decodeModelListResult,
  type CodexServerNotification,
  type CodexServerRequest,
} from "./codexProtocol";
import {
  CodexRpcClientFailure,
  makeCodexRpcClient,
  type CodexRpcClientOptions,
} from "./codexRpcClient";

const accountResult = { account: { type: "chatgpt" }, requiresOpenaiAuth: true } as const;
const modelResult = {
  data: [
    {
      id: "gpt-5.4",
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: true,
    },
  ],
  nextCursor: null,
} as const;

function transport(overrides: Partial<CodexRpcClientOptions> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = makeCodexRpcClient({ stdin, stdout, stderr, ...overrides });
  void client.exited.catch(() => undefined);
  return { client, stdin, stdout, stderr };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function failureOf(promise: Promise<unknown>): Promise<CodexRpcClientFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CodexRpcClientFailure);
    return error as CodexRpcClientFailure;
  }
  throw new Error("Expected CodexRpcClientFailure");
}

function lines(stream: PassThrough): { readonly values: unknown[]; dispose(): void } {
  let buffered = "";
  const values: unknown[] = [];
  const onData = (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const split = buffered.split("\n");
    buffered = split.pop() ?? "";
    for (const line of split) values.push(JSON.parse(line));
  };
  stream.on("data", onData);
  return { values, dispose: () => stream.off("data", onData) };
}

describe("CodexRpcClient", () => {
  it("frames fragmented CRLF and multiple lines in one chunk", async () => {
    const { client, stdout } = transport();
    const notifications: CodexServerNotification[] = [];
    client.onNotification((message) => notifications.push(message));

    const first = JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "A" },
    });
    const second = JSON.stringify({
      method: "item/plan/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2", delta: "B" },
    });
    stdout.write(first.slice(0, 17));
    stdout.write(`${first.slice(17)}\r\n${second}\n`);
    await tick();

    expect(notifications.map(({ method }) => method)).toEqual([
      "item/agentMessage/delta",
      "item/plan/delta",
    ]);
    await client.close();
  });

  it("correlates concurrent requests whose responses arrive out of order", async () => {
    const { client, stdin, stdout } = transport();
    const written = lines(stdin);
    const first = client.request("model/list", { limit: 100 }, decodeModelListResult);
    const second = client.request("account/read", { refreshToken: false }, decodeAccountReadResult);
    await tick();
    expect(written.values).toEqual([
      { id: 1, method: "model/list", params: { limit: 100 } },
      { id: 2, method: "account/read", params: { refreshToken: false } },
    ]);

    stdout.write(`${JSON.stringify({ id: 2, result: accountResult })}\n`);
    stdout.write(`${JSON.stringify({ id: 1, result: modelResult })}\n`);
    await expect(Promise.all([first, second])).resolves.toEqual([modelResult, accountResult]);
    written.dispose();
    await client.close();
  });

  it("delivers validated server requests", async () => {
    const { client, stdout } = transport();
    const requests: CodexServerRequest[] = [];
    client.onRequest((message) => requests.push(message));

    stdout.write(
      `${JSON.stringify({
        id: "approval-1",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 1,
          reason: "needed",
          grantRoot: null,
        },
      })}\n`,
    );
    await tick();
    expect(requests).toEqual([
      expect.objectContaining({
        kind: "request",
        id: "approval-1",
        method: "item/fileChange/requestApproval",
      }),
    ]);
    await client.close();
  });

  it("rejects unsupported server requests without dispatching them", async () => {
    const { client, stdin, stdout } = transport();
    const written = lines(stdin);
    const requests: CodexServerRequest[] = [];
    client.onRequest((message) => requests.push(message));

    stdout.write(
      `${JSON.stringify({ id: 9, method: "item/tool/requestUserInput", params: {} })}\n`,
    );
    await tick();
    expect(requests).toEqual([]);
    expect(written.values).toEqual([
      { id: 9, error: { code: -32601, message: "Method not found" } },
    ]);
    written.dispose();
    await client.close();
  });

  it("writes notifications, results, and errors as complete serialized lines", async () => {
    const { client, stdin } = transport();
    const written = lines(stdin);
    await Promise.all([
      client.notify("initialized"),
      client.respond("approval-1", { decision: "accept" }),
      client.reject("approval-2", -32601, "Method not found"),
    ]);
    expect(written.values).toEqual([
      { method: "initialized" },
      { id: "approval-1", result: { decision: "accept" } },
      { id: "approval-2", error: { code: -32601, message: "Method not found" } },
    ]);
    written.dispose();
    await client.close();
  });

  it("fails the transport on an unknown response ID", async () => {
    const { client, stdout } = transport();
    const exited = client.exited;
    stdout.write(`${JSON.stringify({ id: 404, result: {} })}\n`);
    expect((await failureOf(exited)).kind).toBe("protocol");
  });

  it("fails the transport on a duplicate response", async () => {
    const { client, stdout } = transport();
    const pending = client.request("account/read", {}, decodeAccountReadResult);
    stdout.write(`${JSON.stringify({ id: 1, result: accountResult })}\n`);
    await expect(pending).resolves.toEqual(accountResult);
    const exited = client.exited;
    stdout.write(`${JSON.stringify({ id: 1, result: accountResult })}\n`);
    expect((await failureOf(exited)).kind).toBe("protocol");
  });

  it("fails malformed input without exposing it", async () => {
    const { client, stdout } = transport();
    const exited = client.exited;
    stdout.write('{"private":"prompt-text"\n');
    const failure = await failureOf(exited);
    expect(failure).toMatchObject({ kind: "protocol", message: "Codex sent malformed JSON-RPC." });
    expect(failure.message).not.toContain("prompt-text");
  });

  it("fails a line that exceeds the configured byte bound", async () => {
    const { client, stdout } = transport({ limits: { lineBytes: 32 } });
    const exited = client.exited;
    stdout.write("x".repeat(33));
    const failure = await failureOf(exited);
    expect(failure).toMatchObject({
      kind: "protocol",
      message: "Codex message exceeded the line limit.",
    });
    expect(failure.message).not.toContain("xxx");
  });

  it.each(["\n", "\r\n"])("accepts an exact-size payload with %j framing", async (framing) => {
    const line = JSON.stringify({ method: "future/notification" });
    const { client, stdout } = transport({
      limits: { lineBytes: Buffer.byteLength(line) },
    });
    stdout.write(`${line}${framing}`);

    await expect(client.notify("initialized")).resolves.toBeUndefined();
    await client.close();
  });

  it("rejects requests beyond the pending-request bound", async () => {
    const { client } = transport();
    const accepted = Array.from({ length: 64 }, (_, index) =>
      client.request(`request-${index}`, {}, (value) => value),
    );
    const settled = accepted.map((request) => request.catch((error: unknown) => error));
    const failure = await failureOf(client.request("request-65", {}, (value) => value));
    expect(failure.kind).toBe("capacity");
    await client.close();
    await Promise.all(settled);
  });

  it("fails when more notifications are queued than the bound", async () => {
    const { client, stdout } = transport();
    client.onNotification(() => undefined);
    const exited = client.exited;
    const notification = (itemId: string) =>
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId, delta: "x" },
      });
    stdout.write(
      `${Array.from({ length: 257 }, (_, index) => notification(String(index))).join("\n")}\n`,
    );
    expect((await failureOf(exited)).kind).toBe("capacity");
  });

  it("captures at most the configured stderr bytes and never exposes stderr in failures", async () => {
    const onStderr = vi.fn();
    const { client, stderr, stdout } = transport({ onStderr });
    stderr.end(`private-${"x".repeat(65_536)}`);
    await tick();
    expect(onStderr).toHaveBeenCalledWith({ capturedBytes: 65_536, truncated: true });

    const exited = client.exited;
    stdout.write("invalid\n");
    const failure = await failureOf(exited);
    expect(failure.message).not.toContain("private");
  });

  it("times out a request and removes it from correlation", async () => {
    vi.useFakeTimers();
    try {
      const { client } = transport({ limits: { requestTimeoutMs: 50 } });
      const pending = client.request(
        "model/list",
        { private: "do-not-log" },
        decodeModelListResult,
      );
      const observedFailure = failureOf(pending);
      await vi.advanceTimersByTimeAsync(50);
      const failure = await observedFailure;
      expect(failure).toMatchObject({ kind: "timeout", message: "Codex request timed out." });
      expect(failure.message).not.toContain("model/list");
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies -32001 as saturation without retrying", async () => {
    const { client, stdin, stdout } = transport();
    const written = lines(stdin);
    const pending = client.request("model/list", {}, decodeModelListResult);
    stdout.write(
      `${JSON.stringify({ id: 1, error: { code: -32001, message: "private-overload-detail" } })}\n`,
    );
    const failure = await failureOf(pending);
    expect(failure).toMatchObject({ kind: "saturated", message: "Codex request was saturated." });
    expect(failure.message).not.toContain("private-overload-detail");
    await tick();
    expect(written.values).toHaveLength(1);
    written.dispose();
    await client.close();
  });

  it("fully cleans up pending work, listeners, and stderr diagnostics when stdout ends", async () => {
    const onStderr = vi.fn();
    const { client, stdin, stdout, stderr } = transport({ onStderr });
    const pending = client.request("model/list", {}, decodeModelListResult);
    stderr.write("bounded-stderr");
    stdout.end();
    const failure = await failureOf(pending);
    expect(failure).toMatchObject({ kind: "closed", message: "Codex transport closed." });
    await expect(client.exited).resolves.toBeUndefined();
    expect(onStderr).toHaveBeenCalledOnce();
    expect(onStderr).toHaveBeenCalledWith({ capturedBytes: 14, truncated: false });
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("end")).toBe(0);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("data")).toBe(0);
    expect(stderr.listenerCount("end")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
  });

  it("fully cleans up exactly once after a protocol failure", async () => {
    const onStderr = vi.fn();
    const { client, stdin, stdout, stderr } = transport({ onStderr });
    const pendingFailure = failureOf(client.request("model/list", {}, decodeModelListResult));
    const exitFailure = failureOf(client.exited);
    stderr.write("private");
    stdout.write("invalid\n");

    expect(await pendingFailure).toMatchObject({ kind: "protocol" });
    expect(await exitFailure).toMatchObject({ kind: "protocol" });
    expect(onStderr).toHaveBeenCalledOnce();
    expect(onStderr).toHaveBeenCalledWith({ capturedBytes: 7, truncated: false });
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("end")).toBe(0);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("data")).toBe(0);
    expect(stderr.listenerCount("end")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);

    stderr.end("ignored-after-finish");
    stdout.end();
    await tick();
    expect(onStderr).toHaveBeenCalledOnce();
  });

  it("settles a pending request exactly once and removes every listener after stdin fails", async () => {
    const controller = new AbortController();
    const onStderr = vi.fn();
    const onNotification = vi.fn();
    const onRequest = vi.fn();
    const { client, stdin, stdout, stderr } = transport({
      onStderr,
      signal: controller.signal,
    });
    client.onNotification(onNotification);
    client.onRequest(onRequest);
    let pendingSettlements = 0;
    let exitSettlements = 0;
    const pending = client
      .request("model/list", { private: "request-secret" }, decodeModelListResult)
      .catch((error: unknown) => error)
      .finally(() => {
        pendingSettlements += 1;
      });
    const exited = client.exited
      .catch((error: unknown) => error)
      .finally(() => {
        exitSettlements += 1;
      });

    stdin.destroy(new Error("private-stdin-failure"));
    const [pendingFailure, exitFailure] = await Promise.all([pending, exited]);

    expect(pendingFailure).toBe(exitFailure);
    expect(pendingFailure).toMatchObject({ kind: "closed" });
    expect((pendingFailure as Error).message).toMatch(/^Codex transport (?:closed|failed)\.$/);
    expect(`${String(pendingFailure)} ${(pendingFailure as Error).message}`).not.toMatch(
      /private-stdin-failure|request-secret/,
    );
    await tick();
    expect(pendingSettlements).toBe(1);
    expect(exitSettlements).toBe(1);
    expect(onStderr).toHaveBeenCalledOnce();
    expect(onNotification).not.toHaveBeenCalled();
    expect(onRequest).not.toHaveBeenCalled();
    expect(stdin.listenerCount("error")).toBe(0);
    expect(stdin.listenerCount("close")).toBe(0);
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("end")).toBe(0);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("data")).toBe(0);
    expect(stderr.listenerCount("end")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("cancels deterministically through an abort signal", async () => {
    const controller = new AbortController();
    const { client } = transport({ signal: controller.signal });
    const pending = client.request("model/list", {}, decodeModelListResult);
    controller.abort();
    expect((await failureOf(pending)).kind).toBe("closed");
    await expect(client.exited).resolves.toBeUndefined();
  });

  it("closes idempotently and rejects future writes", async () => {
    const { client, stdin } = transport();
    await Promise.all([client.close(), client.close(), client.close()]);
    expect(stdin.writableEnded).toBe(true);
    expect((await failureOf(client.notify("initialized"))).kind).toBe("closed");
    await expect(client.exited).resolves.toBeUndefined();
  });
});
