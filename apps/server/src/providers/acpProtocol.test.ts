import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AcpFailure,
  makeAcpClient,
  type AcpClientOptions,
  type AcpServerNotification,
  type AcpServerRequest,
} from "./acpProtocol";

function transport(overrides: Partial<AcpClientOptions> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = makeAcpClient({ stdin, stdout, stderr, ...overrides });
  void client.exited.catch(() => undefined);
  return { client, stdin, stdout, stderr };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function failureOf(promise: Promise<unknown>): Promise<AcpFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AcpFailure);
    return error as AcpFailure;
  }
  throw new Error("Expected AcpFailure");
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

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    sessionCapabilities: { list: {}, resume: {} },
  },
  authMethods: [{ id: "login", type: "terminal", args: ["--login"] }],
  agentInfo: { name: "Fixture Agent", version: "0.27.0" },
} as const;

describe("ACP protocol boundary", () => {
  it("negotiates ACP protocol 1 and strips unconsumed provider fields", async () => {
    const { client, stdin, stdout } = transport();
    const written = lines(stdin);
    const initialized = client.initialize();
    await tick();
    expect(written.values).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "Octant", version: "1" },
        },
      },
    ]);
    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ...initializeResult, private: true } })}\n`,
    );
    await expect(initialized).resolves.toEqual(initializeResult);
    written.dispose();
    await client.close();
  });

  it("accepts the handshake vibe-acp 2.16.1 sends, keeping only the fields Octant reads", async () => {
    // Captured over stdio from `vibe-acp` 2.16.1: session capabilities Octant
    // does not consume (`close`, `fork`), a titled agentInfo, described auth
    // methods, and a session/new that spells its models three ways at once.
    const { client, stdin, stdout } = transport();
    const written = lines(stdin);
    const initialized = client.initialize();
    const session = client.newSession("/tmp/octant-acp");
    await tick();
    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { audio: false, embeddedContext: true, image: false },
            sessionCapabilities: { close: {}, fork: {}, list: {} },
          },
          agentInfo: { name: "@mistralai/mistral-vibe", title: "Mistral Vibe", version: "2.16.1" },
          authMethods: [
            {
              description: "Sign into Mistral Vibe through your Mistral AI Studio account.",
              id: "browser-auth",
              name: "Sign in through Mistral AI Studio",
            },
          ],
          protocolVersion: 1,
        },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          configOptions: [
            {
              currentValue: "default",
              options: [
                {
                  description: "Requires approval for tool executions",
                  name: "Default",
                  value: "default",
                },
                {
                  description: "Read-only agent for exploration and planning",
                  name: "Plan",
                  value: "plan",
                },
              ],
              category: "mode",
              id: "mode",
              name: "Session Mode",
              type: "select",
            },
            {
              currentValue: "mistral-medium-3.5",
              options: [
                {
                  description: "mistral-vibe-cli-latest",
                  name: "mistral-medium-3.5",
                  value: "mistral-medium-3.5",
                },
                { description: "devstral", name: "local", value: "local" },
              ],
              category: "model",
              id: "model",
              name: "Model",
              type: "select",
            },
          ],
          models: {
            availableModels: [
              { modelId: "mistral-medium-3.5", name: "mistral-medium-3.5" },
              { modelId: "local", name: "local" },
            ],
            currentModelId: "mistral-medium-3.5",
          },
          modes: {
            availableModes: [{ description: "Requires approval", id: "default", name: "Default" }],
            currentModeId: "default",
          },
          sessionId: "90efe725-aba2-551f-5fc4-f75c8319c110",
        },
      })}\n`,
    );
    await expect(initialized).resolves.toMatchObject({
      agentInfo: { name: "@mistralai/mistral-vibe", version: "2.16.1" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      authMethods: [{ id: "browser-auth" }],
    });
    const opened = await session;
    expect(opened.sessionId).toBe("90efe725-aba2-551f-5fc4-f75c8319c110");
    expect(opened.configOptions?.map((option) => option.id)).toEqual(["mode", "model"]);
    expect(opened.models?.availableModels.map((model) => model.modelId)).toEqual([
      "mistral-medium-3.5",
      "local",
    ]);
    expect("modes" in opened).toBe(false);
    written.dispose();
    await client.close();
  });

  it("correlates concurrent responses that arrive out of order", async () => {
    const { client, stdin, stdout } = transport();
    const written = lines(stdin);
    const first = client.initialize();
    const second = client.newSession("/tmp/octant-acp");
    await tick();
    expect(written.values.map((value) => (value as { id: number }).id)).toEqual([1, 2]);
    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "session-1", configOptions: [] },
      })}\n`,
    );
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: initializeResult })}\n`);
    await expect(Promise.all([first, second])).resolves.toEqual([
      initializeResult,
      { sessionId: "session-1", configOptions: [] },
    ]);
    written.dispose();
    await client.close();
  });

  it("delivers only stable bounded notifications and reverse requests", async () => {
    const { client, stdout } = transport();
    const notifications: AcpServerNotification[] = [];
    const requests: AcpServerRequest[] = [];
    client.onNotification((message) => notifications.push(message));
    client.onRequest((message) => requests.push(message));

    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          toolCall: { toolCallId: "tool-1", title: "Write file", kind: "edit" },
          options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
        },
      })}\n`,
    );
    await tick();
    expect(notifications).toEqual([
      expect.objectContaining({ kind: "notification", method: "session/update" }),
    ]);
    expect(requests).toEqual([
      expect.objectContaining({
        kind: "request",
        id: "permission-1",
        method: "session/request_permission",
      }),
    ]);
    await client.close();
  });

  it("fails closed for duplicate IDs, malformed JSON, incomplete lines, and oversized frames", async () => {
    for (const write of [
      (stdout: PassThrough) => stdout.write('{"private":"prompt"\n'),
      (stdout: PassThrough) => stdout.end('{"jsonrpc":"2.0"'),
      (stdout: PassThrough) => stdout.write("x".repeat(65)),
    ]) {
      const { client, stdout } = transport({ limits: { lineBytes: 64 } });
      const exited = client.exited;
      write(stdout);
      const failure = await failureOf(exited);
      expect(failure.kind).toBe("protocol");
      expect(failure.message).not.toContain("prompt");
    }

    const { client, stdout } = transport();
    const pending = client.initialize();
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: initializeResult })}\n`);
    await expect(pending).resolves.toEqual(initializeResult);
    const exited = client.exited;
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: initializeResult })}\n`);
    expect((await failureOf(exited)).kind).toBe("protocol");
  });

  it("times out without exposing the method or params", async () => {
    vi.useFakeTimers();
    try {
      const { client } = transport({ limits: { requestTimeoutMs: 50 } });
      const observed = failureOf(client.newSession("/private/project"));
      await vi.advanceTimersByTimeAsync(50);
      const failure = await observed;
      expect(failure).toMatchObject({ kind: "timeout", message: "ACP request timed out." });
      expect(failure.message).not.toContain("session/new");
      expect(failure.message).not.toContain("private");
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads an expired credential as an authentication refusal without echoing the agent", async () => {
    // Verified against grok 1.0.4 and vibe-acp 2.24.1: a managed home holding a
    // stale credential opens the session and only refuses the turn, and neither
    // agent uses -32000 for it.
    const refusals = [
      {
        code: -32603,
        message: "Internal error",
        data: "Unauthorized (401) from https://cli-chat-proxy.example/v1/responses: Invalid or expired credentials",
      },
      {
        code: -32603,
        message:
          "API error from mistral (model: vibe-cli): Invalid API key. Please check your API key and try again.",
      },
      { code: -32000, message: "Authentication required", data: "no auth method id provided" },
    ];
    for (const error of refusals) {
      const { client, stdout } = transport();
      const observed = failureOf(client.prompt("session-1", "hello"));
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error })}\n`);
      const failure = await observed;
      expect(failure).toMatchObject({ kind: "remote", message: "ACP authentication is required." });
      expect(failure.message).not.toContain("cli-chat-proxy");
      expect(failure.message).not.toContain("mistral");
      await client.close();
    }
  });

  it("leaves an unrelated agent refusal a generic failure", async () => {
    const { client, stdout } = transport();
    const observed = failureOf(client.prompt("session-1", "hello"));
    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error", data: "tool execution failed" },
      })}\n`,
    );
    expect(await observed).toMatchObject({ kind: "remote", message: "ACP request failed." });
    await client.close();
  });

  it("bounds stderr diagnostics without exposing their contents", async () => {
    const onStderr = vi.fn();
    const { client, stderr, stdout } = transport({
      limits: { stderrBytes: 16 },
      onStderr,
    });
    stderr.end("secret-provider-diagnostic");
    await tick();
    expect(onStderr).toHaveBeenCalledWith({ capturedBytes: 16, truncated: true });
    const exited = client.exited;
    stdout.write("invalid\n");
    expect((await failureOf(exited)).message).not.toContain("secret");
  });
  it("negotiates delegated browser authentication metadata without terminal or fs authority", async () => {
    const { client, stdin, stdout } = transport();
    const written = lines(stdin);
    const initialized = client.initialize({
      "browser-auth-delegated": true,
      "terminal-auth": false,
    });
    await vi.waitFor(() => expect(written.values).toHaveLength(1));
    expect(written.values[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { "browser-auth-delegated": true, "terminal-auth": false },
        },
        clientInfo: { name: "Octant", version: "1" },
      },
    });
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: initializeResult })}\n`);
    await expect(initialized).resolves.toMatchObject({ protocolVersion: 1 });
    written.dispose();
  });

  it("starts and completes delegated browser authentication without credential payloads", async () => {
    const { client, stdin, stdout } = transport();
    const written = lines(stdin);
    const started = client.startBrowserAuthentication();
    await vi.waitFor(() => expect(written.values).toHaveLength(1));
    expect(written.values[0]).toMatchObject({
      id: 1,
      method: "authenticate",
      params: { methodId: "browser-auth-delegated", action: "start" },
    });
    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          _meta: {
            "browser-auth-delegated": {
              attemptId: "attempt-1",
              expiresAt: "2026-07-17T21:00:00.000Z",
              signInUrl: "https://console.mistral.ai/sign-in/attempt-1",
            },
          },
        },
      })}\n`,
    );
    await expect(started).resolves.toEqual({
      attemptId: "attempt-1",
      expiresAt: "2026-07-17T21:00:00.000Z",
      signInUrl: "https://console.mistral.ai/sign-in/attempt-1",
    });

    const completed = client.completeBrowserAuthentication("attempt-1");
    await vi.waitFor(() => expect(written.values).toHaveLength(2));
    expect(written.values[1]).toMatchObject({
      id: 2,
      method: "authenticate",
      params: { methodId: "browser-auth-delegated", action: "complete", attemptId: "attempt-1" },
    });
    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          _meta: {
            "browser-auth-delegated": {
              attemptId: "attempt-1",
              persistResult: "persisted",
              status: "completed",
            },
          },
        },
      })}\n`,
    );
    await expect(completed).resolves.toBeUndefined();
    expect(JSON.stringify(written.values)).not.toMatch(/api.?key|token|credential/i);
    written.dispose();
  });
});
