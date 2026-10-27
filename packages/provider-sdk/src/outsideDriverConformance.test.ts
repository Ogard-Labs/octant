import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  runOutsideDriverConformance,
  type OutsideDriverConformanceChannel,
  type OutsideDriverConformanceFixture,
} from "./outsideDriverConformance";
import type {
  OutsideDriverImplementation,
  OutsideDriverLineIo,
  serveOutsideDriver,
} from "./outsideDriverServe.mjs";

const exampleRoot = fileURLToPath(new URL("../examples/loopback-chat-driver/", import.meta.url));
const baseUrl = "http://127.0.0.1:8080/v1/";
const children: Array<ChildProcess> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/**
 * The example driver's own modules, loaded from its package as the host's
 * runtime would load them: plain JavaScript with no declarations of its own.
 */
async function exampleModules(): Promise<{
  readonly createLoopbackChatDriver: () => OutsideDriverImplementation;
  readonly serveOutsideDriver: typeof serveOutsideDriver;
}> {
  const driver: unknown = await import(pathToFileURL(`${exampleRoot}lib/loopback-chat.mjs`).href);
  const serve: unknown = await import(
    pathToFileURL(`${exampleRoot}lib/outside-driver-serve.mjs`).href
  );
  if (
    !hasFunction(driver, "createLoopbackChatDriver") ||
    !hasFunction(serve, "serveOutsideDriver")
  ) {
    throw new Error("The example driver's modules are missing their exports.");
  }
  return {
    createLoopbackChatDriver: driver.createLoopbackChatDriver as () => OutsideDriverImplementation,
    serveOutsideDriver: serve.serveOutsideDriver as typeof serveOutsideDriver,
  };
}

function hasFunction<K extends string>(
  value: unknown,
  key: K,
): value is Readonly<Record<K, (...args: ReadonlyArray<unknown>) => unknown>> {
  return typeof value === "object" && value !== null && key in value
    ? typeof (value as Readonly<Record<string, unknown>>)[key] === "function"
    : false;
}

/** Lines that cross asynchronously, as they would between two processes. */
function inProcessChannel(): {
  readonly kit: OutsideDriverConformanceChannel;
  readonly driver: OutsideDriverLineIo;
} {
  const toDriver: Array<(line: string) => void> = [];
  const toKit: Array<(line: string) => void> = [];
  const deliver = (listeners: ReadonlyArray<(line: string) => void>, line: string) =>
    queueMicrotask(() => {
      for (const listener of listeners) listener(line);
    });
  return {
    kit: { write: (line) => deliver(toDriver, line), onLine: (listener) => toKit.push(listener) },
    driver: {
      write: (line) => deliver(toKit, line),
      onLine: (listener) => toDriver.push(listener),
    },
  };
}

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function sse(events: ReadonlyArray<unknown>): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * A local OpenAI-compatible model server as the kit's broker reaches it. It
 * streams its answer in server-sent events and calls a tool when offered one.
 */
function fakeLocalModelServer(
  answer: (body: Readonly<Record<string, unknown>>) => Response = defaultAnswer,
) {
  const seen: Array<SeenRequest> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = typeof init.body === "string" ? init.body : "";
    seen.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body });
    const path = new URL(url).pathname;
    if (path === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "local-model" }, { id: "a-model-nobody-listed" }],
      });
    }
    if (path === "/v1/chat/completions") return answer(JSON.parse(body));
    return new Response("not found", { status: 404 });
  };
  return { fetch, seen };
}

function defaultAnswer(body: Readonly<Record<string, unknown>>): Response {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return sse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_7",
                  type: "function",
                  function: { name: "octant_capability_", arguments: '{"echo":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: "echo", arguments: '"ready"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
  }
  return sse([
    { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
    { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
  ]);
}

const request = {
  sessionId: "80000000-0000-4000-8000-000000000701",
  modelId: "local-model",
  history: [{ role: "user" as const, text: "Say hello" }],
  tools: [],
};

function fixture(
  channel: OutsideDriverConformanceChannel,
  fetch: OutsideDriverConformanceFixture["fetch"],
  overrides: Partial<OutsideDriverConformanceFixture> = {},
): OutsideDriverConformanceFixture {
  return {
    channel,
    configuration: { baseUrl, modelIds: ["local-model"] },
    fetch,
    request,
    timeoutMs: 2_000,
    ...overrides,
  };
}

const passed = {
  agreedOnAHostProtocolVersion: true,
  probeReportedAListedModel: true,
  answeredWithASettledResponse: true,
  keptServingAfterACancel: true,
  keptServingAfterARelease: true,
  everyMessageDecoded: true,
  brokeredCallsStayedOnTheConfiguredOrigin: true,
};

async function served(
  driver: OutsideDriverImplementation,
): Promise<OutsideDriverConformanceChannel> {
  const { serveOutsideDriver } = await exampleModules();
  const channel = inProcessChannel();
  serveOutsideDriver(driver, channel.driver);
  return channel.kit;
}

describe("outside driver conformance kit", () => {
  it("passes the example loopback driver served in process against a local model server", async () => {
    const { createLoopbackChatDriver } = await exampleModules();
    const server = fakeLocalModelServer();

    await expect(
      runOutsideDriverConformance(fixture(await served(createLoopbackChatDriver()), server.fetch)),
    ).resolves.toEqual(passed);
    // Every call went to the address the person entered, and none carried a key.
    expect(server.seen.map(({ method, url }) => `${method} ${url}`)).toContain(
      "POST http://127.0.0.1:8080/v1/chat/completions",
    );
    expect(server.seen.every(({ headers }) => !headers.has("authorization"))).toBe(true);
  });

  it("passes the example driver's entry run as its own process, speaking only on stdin and stdout", async () => {
    const child = spawn(process.execPath, [`${exampleRoot}driver.mjs`], {
      cwd: exampleRoot,
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const { stdin, stdout } = child;
    if (stdin === null || stdout === null) throw new Error("The driver process has no stdio.");
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
    const channel: OutsideDriverConformanceChannel = {
      write: (line) => {
        stdin.write(`${line}\n`);
      },
      onLine: (listener) => {
        lines.on("line", listener);
      },
    };

    await expect(
      runOutsideDriverConformance(
        fixture(channel, fakeLocalModelServer().fetch, { timeoutMs: 10_000 }),
      ),
    ).resolves.toEqual(passed);
  });

  it("assembles a tool call the server streamed in pieces, and keeps a stream split mid-event", async () => {
    const { createLoopbackChatDriver, serveOutsideDriver } = await exampleModules();
    const driver = createLoopbackChatDriver();
    const server = fakeLocalModelServer();
    const kit = inProcessChannel();
    serveOutsideDriver(driver, kit.driver);
    const answers: Array<unknown> = [];
    kit.kit.onLine((line) => answers.push(JSON.parse(line)));
    await expect(
      runOutsideDriverConformance(
        fixture(kit.kit, server.fetch, {
          request: {
            ...request,
            tools: [{ name: "octant_capability_echo", inputSchema: { type: "object" } }],
          },
        }),
      ),
    ).resolves.toEqual(passed);
    expect(answers).toContainEqual({
      jsonrpc: "2.0",
      id: 4,
      result: {
        text: "",
        toolCalls: [
          {
            toolCallId: "call_7",
            toolName: "octant_capability_echo",
            argumentsJson: '{"echo":"ready"}',
          },
        ],
      },
    });
    const offered = JSON.parse(
      server.seen.find(({ url }) => url.endsWith("/chat/completions"))?.body ?? "{}",
    );
    expect(offered.tools).toEqual([
      {
        type: "function",
        function: { name: "octant_capability_echo", parameters: { type: "object" } },
      },
    ]);
  });

  it("reports a request that outgrew the model's window as structure the host reads", async () => {
    const { createLoopbackChatDriver } = await exampleModules();
    const server = fakeLocalModelServer(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "the request exceeds the available context size (n_ctx: 4096)" },
          }),
          { status: 400 },
        ),
    );
    const kit = inProcessChannel();
    const { serveOutsideDriver } = await exampleModules();
    serveOutsideDriver(createLoopbackChatDriver(), kit.driver);
    const answers: Array<unknown> = [];
    kit.kit.onLine((line) => answers.push(JSON.parse(line)));

    await expect(runOutsideDriverConformance(fixture(kit.kit, server.fetch))).rejects.toThrow(
      "Outside driver conformance failed: session/send failed",
    );
    expect(answers).toContainEqual({
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32000,
        message: "provider-failed",
        data: { category: "provider-failed", contextOverflow: { contextWindowTokens: 4096 } },
      },
    });
  });

  it("carries the kit's serve helper unchanged, since a driver package cannot import it", async () => {
    const [kit, copy] = await Promise.all([
      readFile(new URL("./outsideDriverServe.mjs", import.meta.url), "utf8"),
      readFile(`${exampleRoot}lib/outside-driver-serve.mjs`, "utf8"),
    ]);
    expect(copy).toBe(kit);
  });

  const wellBehaved: OutsideDriverImplementation = {
    probe: () => ({ models: [{ id: "local-model" }] }),
    send: (_params, turn) => {
      turn.emit({ kind: "text-delta", text: "Hello" });
      return { text: "Hello", toolCalls: [] };
    },
  };

  it("fails a driver that writes anything on stdout but protocol messages", async () => {
    const { serveOutsideDriver } = await exampleModules();
    const channel = inProcessChannel();
    serveOutsideDriver(wellBehaved, channel.driver);
    // What a stray `process.stdout.write` in a driver puts on the channel.
    channel.driver.write("Driver ready!");
    await expect(
      runOutsideDriverConformance(fixture(channel.kit, fakeLocalModelServer().fetch)),
    ).rejects.toThrow("a line was not JSON; console output belongs on stderr");
  });

  it("fails a driver that asks the host for an address outside the configured origin", async () => {
    const channel = await served({
      ...wellBehaved,
      probe: async (host) => {
        await host.http({ url: "https://collector.example.test/upload", method: "POST" });
        return { models: [{ id: "local-model" }] };
      },
    });
    await expect(
      runOutsideDriverConformance(fixture(channel, fakeLocalModelServer().fetch)),
    ).rejects.toThrow("a brokered request named an address outside the configured origin");
  });

  it("fails a driver that asks for a key the provider does not send, or sets a credential header itself", async () => {
    const asksForKey = await served({
      ...wellBehaved,
      probe: async (host) => {
        await host.http({
          url: `${baseUrl}models`,
          method: "GET",
          auth: { header: "authorization", scheme: "Bearer" },
        });
        return { models: [{ id: "local-model" }] };
      },
    });
    await expect(
      runOutsideDriverConformance(fixture(asksForKey, fakeLocalModelServer().fetch)),
    ).rejects.toThrow("a brokered request asked for a key the provider does not send");

    const setsCookie = await served({
      ...wellBehaved,
      probe: async (host) => {
        await host.http({ url: `${baseUrl}models`, method: "GET", headers: [["Cookie", "a=b"]] });
        return { models: [{ id: "local-model" }] };
      },
    });
    await expect(
      runOutsideDriverConformance(fixture(setsCookie, fakeLocalModelServer().fetch)),
    ).rejects.toThrow("a brokered request set the cookie header, which only the host sets");
  });

  it("fails a driver whose answers carry fields the host does not read", async () => {
    const answer = { text: "Hello", toolCalls: [], servedModelId: "gpt-9" };
    const channel = await served({ ...wellBehaved, send: () => answer });
    await expect(
      runOutsideDriverConformance(fixture(channel, fakeLocalModelServer().fetch)),
    ).rejects.toThrow("the session/send answer did not decode");
  });

  it("fails a driver that stops answering after a cancel", async () => {
    let cancelled = false;
    const channel = await served({
      ...wellBehaved,
      probe: () => (cancelled ? new Promise(() => undefined) : { models: [{ id: "local-model" }] }),
    });
    const watched: OutsideDriverConformanceChannel = {
      write: (line) => {
        if (line.includes('"session/cancel"')) cancelled = true;
        channel.write(line);
      },
      onLine: channel.onLine,
    };
    await expect(
      runOutsideDriverConformance(
        fixture(watched, fakeLocalModelServer().fetch, { timeoutMs: 200 }),
      ),
    ).rejects.toThrow("probe was not answered in time");
  });
});
