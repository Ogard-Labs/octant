import { generateKeyPairSync } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  decodeProviderTurnInput,
} from "@octant/contracts";
import type { HarnessEndpointStreamEvent } from "@octant/provider-sdk/harness-endpoint";
import { runHarnessEndpointConformance } from "@octant/provider-sdk/harness-endpoint-conformance";
import type {
  OutsideDriverImplementation,
  OutsideDriverLineIo,
} from "@octant/provider-sdk/outside-driver-serve";
import { signOutsideDriverPackage } from "@octant/provider-sdk/outside-driver-sign";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPluginFolderRegistry } from "../extensions/localPluginFolderRegistry";
import { readOutsideProviderDriverPackage } from "../extensions/outsideProviderDriverPackage";
import { makeInMemoryOutsideDriverChannel } from "./outsideDriverFixture.test-support";
import { makeOutsideHarnessEndpointProxy } from "./outsideHarnessEndpointProxy";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * The example loopback driver that ships with the author kit, run through the
 * host's own proxy against a local OpenAI-compatible model server on loopback.
 * A Linux host never starts a driver process (`host-prohibited`), so the
 * driver's modules run in process over the in-memory channel the proxy tests
 * use; its folder is still read exactly as the host inspects one.
 */

const exampleRoot = fileURLToPath(
  new URL("../../../../packages/provider-sdk/examples/loopback-chat-driver/", import.meta.url),
);
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000801");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000802");
const modelId = decodeProviderModelId("local-model");
const servers: Array<{ readonly close: () => void }> = [];
const copies: Array<string> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(copies.splice(0).map((copy) => rm(copy, { recursive: true, force: true })));
});

async function exampleDriver(): Promise<{
  readonly driver: OutsideDriverImplementation;
  readonly serve: (driver: OutsideDriverImplementation, io: OutsideDriverLineIo) => void;
}> {
  const driverModule: unknown = await import(
    pathToFileURL(`${exampleRoot}lib/loopback-chat.mjs`).href
  );
  const serveModule: unknown = await import(
    pathToFileURL(`${exampleRoot}lib/outside-driver-serve.mjs`).href
  );
  const create = exportedFunction(driverModule, "createLoopbackChatDriver");
  const serve = exportedFunction(serveModule, "serveOutsideDriver");
  return {
    driver: create() as OutsideDriverImplementation,
    serve: (driver, io) => {
      serve(driver, io);
    },
  };
}

function exportedFunction(module: unknown, name: string): (...args: Array<unknown>) => unknown {
  const value =
    typeof module === "object" && module !== null
      ? (module as Readonly<Record<string, unknown>>)[name]
      : undefined;
  if (typeof value !== "function") throw new Error(`The example driver does not export ${name}.`);
  return (...args) => value(...args);
}

/** A local model server: models, and a streamed chat completion, on 127.0.0.1. */
async function localModelServer(): Promise<{
  readonly baseUrl: string;
  readonly requests: ReadonlyArray<{ readonly path: string; readonly authorization?: string }>;
}> {
  const requests: Array<{ readonly path: string; readonly authorization?: string }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      path: request.url ?? "",
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
    });
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "local-model" }] }));
      return;
    }
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
        { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
      ]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => server.close() });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1/`, requests };
}

describe("example loopback driver", () => {
  it("is a driver package the host's inspection accepts", async () => {
    const folders = new LocalPluginFolderRegistry({ platform: "darwin" });
    const registered = await folders.register(exampleRoot);
    const input = registered.packageInput;
    if (!("layout" in input) || input.layout !== "outside-provider-driver") {
      throw new Error("The example folder was not read as a provider driver.");
    }

    const reading = readOutsideProviderDriverPackage(input);

    expect(reading.status).toBe("accepted");
    if (reading.status !== "accepted") return;
    expect(reading.resolved.manifest).toMatchObject({
      components: [{ kind: "provider-driver", entryPoint: "driver.mjs" }],
    });
  });

  it("is accepted signed by a publisher key made for this test, and refused once a file changes", async () => {
    const copy = await mkdtemp(join(tmpdir(), "octant-signed-example-"));
    copies.push(copy);
    await cp(exampleRoot, copy, { recursive: true });
    const privateKeyPem = generateKeyPairSync("ed25519")
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    const signed = await signOutsideDriverPackage({ root: copy, privateKeyPem });
    const read = async () => {
      const folders = new LocalPluginFolderRegistry({ platform: "darwin" });
      const input = (await folders.register(copy)).packageInput;
      if (!("layout" in input) || input.layout !== "outside-provider-driver") {
        throw new Error("The signed example was not read as a provider driver.");
      }
      return readOutsideProviderDriverPackage(input);
    };

    const reading = await read();
    expect(reading.status).toBe("accepted");
    if (reading.status !== "accepted") return;
    expect(reading.resolved.manifest).toMatchObject({
      provenance: { publisherKey: signed.fingerprint },
    });

    await writeFile(join(copy, "lib/loopback-chat.mjs"), "export const tampered = true;\n");
    expect(await read()).toEqual({ status: "refused", reason: "signature-invalid" });
  });

  it("passes the harness endpoint conformance kit through the host proxy against a loopback model server", async () => {
    const server = await localModelServer();
    const { driver, serve } = await exampleDriver();
    const channel = makeInMemoryOutsideDriverChannel();
    serve(driver, channel.driver);
    const registry = new ProviderRuntimeRegistry();
    const proxy = makeOutsideHarnessEndpointProxy({
      instanceId,
      channel: channel.host,
      baseUrl: server.baseUrl,
      key: undefined,
      modelIds: [modelId, decodeProviderModelId("unreported-model")],
      runtimeRegistry: registry,
      limits: { callTimeoutMs: 5_000, sendTimeoutMs: 5_000 },
    });

    const observed = await Effect.runPromise(Effect.scoped(proxy.probe({ instanceId })));
    expect(observed.readiness).toBe("ready");
    expect(observed.models.map(({ id }) => String(id))).toEqual(["local-model"]);

    const request = {
      sessionId,
      modelId,
      system: "Answer briefly.",
      history: [{ role: "user" as const, text: "Say hello" }],
      tools: [],
    };
    const session = await proxy.harnessEndpoint.open(modelId);
    const events: Array<HarnessEndpointStreamEvent> = [];
    const answer = await session.send(request, {
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    expect(answer).toEqual({
      text: "Hello",
      toolCalls: [],
      usage: { inputTokens: 9, outputTokens: 2 },
    });
    expect(events).toEqual([
      { kind: "text-delta", text: "Hel" },
      { kind: "text-delta", text: "lo" },
    ]);
    session.release();

    await expect(
      runHarnessEndpointConformance({
        endpoint: proxy.harnessEndpoint,
        modelId,
        request,
        unverifiedToolTurn: decodeProviderTurnInput({
          sessionId,
          prompt: "Read the file",
          attachments: [],
          tools: [{ name: "octant_read_file", inputSchema: { type: "object" } }],
        }),
      }),
    ).resolves.toEqual({
      unverifiedToolsRefusedBeforeAnyRequest: true,
      answeredWithASettledResponse: true,
      cancelledRequestInterrupted: true,
      releasedSessionRefused: true,
    });
    // The driver reached only the address entered, through the host, with no key.
    expect(server.requests.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["/v1/models", "/v1/chat/completions"]),
    );
    expect(server.requests.every(({ authorization }) => authorization === undefined)).toBe(true);
    expect(registry.observedState(instanceId)?.capabilities.streaming).toBe("supported");
  });
});
