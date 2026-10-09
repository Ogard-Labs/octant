import { decodeProviderInstanceId } from "@octant/contracts";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  betaSessionPermissionRules,
  makeOfficialOpenCodeClient,
  makeOpenCodeDriver,
} from "./openCodeDriver";
import { createOpenCodeManagedToolsBridge } from "./openCodeManagedTools";
import { makeOpenCodeProcessLive } from "./openCodeProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * Evidence for app-managed tools on OpenCode 2.x. It launches the installed
 * 2.x binary under Octant's real confinement with a scratch home, scratch
 * XDG directories, and a loopback OpenAI-compatible fake model, so no real
 * provider, account, or the person's own OpenCode data is involved.
 */
const enabled = process.env.OCTANT_OPENCODE2_APP_TOOLS_SMOKE === "1";
const binaryPath =
  process.env.OCTANT_OPENCODE2_BINARY ?? join(homedir(), ".opencode", "bin", "opencode");

interface FakeModelRequest {
  readonly toolNames: ReadonlyArray<string>;
  readonly lastRole: string;
  readonly lastContent: string;
}

/** A loopback chat-completions model: it calls the first Octant echo tool, then repeats its result. */
async function startFakeModel(): Promise<{
  readonly server: Server;
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: FakeModelRequest[];
}> {
  const requests: FakeModelRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (!request.url?.endsWith("/chat/completions")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      const parsed = JSON.parse(body) as {
        readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
        readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
      };
      const toolNames = (parsed.tools ?? []).flatMap((tool) =>
        tool.function?.name === undefined ? [] : [tool.function.name],
      );
      const last = parsed.messages[parsed.messages.length - 1];
      const lastContent =
        typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
      requests.push({ toolNames, lastRole: last?.role ?? "", lastContent });
      const echo = toolNames.find((name) => name.endsWith("_octant_echo"));
      const base = { id: "fake", object: "chat.completion.chunk", created: 1, model: "fake" };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const chunks =
        last?.role !== "tool" && echo !== undefined
          ? [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_echo",
                          type: "function",
                          function: { name: echo, arguments: JSON.stringify({ text: "ping" }) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
            ]
          : [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: `done: ${lastContent}` },
                    finish_reason: null,
                  },
                ],
              },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
            ];
      response.setHeader("content-type", "text/event-stream");
      response.end(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake model has no port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, port: address.port, requests };
}

function scratchEnvironment(root: string, home = join(root, "home")): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  // The launch grants writes to an existing provider data directory only, as
  // on a host where OpenCode has run before; its database lives there.
  mkdirSync(join(root, "data", "opencode"), { recursive: true });
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OCTANT_FAKE_MODEL_KEY: "not-a-credential",
  };
}

describe("OpenCode 2.x app-managed tools", () => {
  it.skipIf(!enabled)(
    "keeps hostile project, global, and home extensions out of a confined 2.x launch",
    async (context) => {
      if (process.platform !== "darwin") context.skip("isolation is attested under Seatbelt");
      accessSync(binaryPath, constants.X_OK);
      const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-opencode2-isolation-")));
      try {
        const environment = scratchEnvironment(root);
        const project = join(root, "project");
        const marker = join(root, "hostile-plugin-loaded");
        const hostile = `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "loaded");\nexport const Hostile = async () => ({});\n`;
        const hostileConfig = JSON.stringify({
          plugin: ["hostile-plugin"],
          mcp: { "hostile-mcp": { type: "remote", url: "http://127.0.0.1:9/mcp" } },
        });
        const configRoots = [
          join(project, ".opencode"),
          join(environment.XDG_CONFIG_HOME!, "opencode"),
          join(environment.HOME!, ".config", "opencode"),
          join(environment.XDG_DATA_HOME!, "opencode"),
        ];
        for (const directory of configRoots) {
          mkdirSync(join(directory, "plugins"), { recursive: true });
          writeFileSync(join(directory, "plugins", "hostile.js"), hostile);
          writeFileSync(join(directory, "opencode.json"), hostileConfig);
        }
        writeFileSync(join(project, "opencode.json"), hostileConfig);
        writeFileSync(
          join(project, ".mcp.json"),
          JSON.stringify({ mcpServers: { "hostile-claude": { url: "http://127.0.0.1:9/mcp" } } }),
        );
        const listed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeOpenCodeProcessLive({
                inheritedEnvironment: environment,
                // Routing only: the hostile global config must not be the source.
                runtimeConfigResolver: async () => undefined,
                startupTimeoutMs: 20_000,
              }).start({ binaryPath, cwd: project, mode: "code" });
              const read = (path: string) =>
                Effect.promise(async () => {
                  const url = new URL(path, server.url);
                  url.searchParams.set("location[directory]", project);
                  const response = await fetch(url, {
                    headers: {
                      authorization: server.authorization,
                      "x-opencode-directory": encodeURIComponent(project),
                    },
                  });
                  return (await response.json()) as { readonly data: ReadonlyArray<unknown> };
                });
              return {
                server,
                mcp: (yield* read("/api/mcp")).data,
                plugins: (yield* read("/api/plugin")).data,
              };
            }),
          ),
        );
        expect(listed.server.runtime).toBe("beta");
        expect(listed.server.isolatedConfiguration).toBe(true);
        expect(listed.mcp).toEqual([]);
        expect(listed.plugins).toEqual([]);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(!enabled)(
    "hands an app-managed tool to a confined 2.x turn and returns Octant's answer to the model",
    async (context) => {
      if (process.platform !== "darwin") context.skip("app tools need Seatbelt loopback rules");
      accessSync(binaryPath, constants.X_OK);
      const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-opencode2-tools-")));
      const model = await startFakeModel();
      const registry = new ProviderRuntimeRegistry();
      const previousDirectory = process.cwd();
      try {
        const projectRoot = join(root, "project");
        mkdirSync(projectRoot, { recursive: true });
        // A turn resolves the home directory's real path before it reads any
        // instructions. Every launch denies the host temporary directory, so
        // a scratch home there blocks the turn; inside the project it is
        // reachable, as a person's own home is on a real host.
        const environment = scratchEnvironment(root, join(projectRoot, ".home"));
        const processPort = makeOpenCodeProcessLive({
          inheritedEnvironment: environment,
          runtimeConfigResolver: async () => ({
            model: "fake/fake-model",
            provider: {
              fake: {
                npm: "@ai-sdk/openai-compatible",
                name: "Fake",
                options: { baseURL: model.baseUrl, apiKey: "{env:OCTANT_FAKE_MODEL_KEY}" },
                models: {
                  "fake-model": {
                    name: "Fake Model",
                    tool_call: true,
                    limit: { context: 8000, output: 1000 },
                  },
                },
              },
            },
          }),
          startupTimeoutMs: 20_000,
        });

        // The probe registers an empty bridge through the 2.x route under the
        // Chat/Plan jail and reports app tools only once OpenCode lists it.
        const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000458");
        const driver = makeOpenCodeDriver({
          instanceId,
          binaryPath,
          process: processPort,
          runtimeRegistry: registry,
          idleLeaseMs: 0,
          permissionPersistence: () => "current-session",
        });
        process.chdir(projectRoot);
        const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
        process.chdir(previousDirectory);
        await registry.closeAll();
        expect(probe.readiness, probe.message).toBe("ready");
        expect(probe.detectedVersion).toMatch(/^opencode v2\./);
        expect(probe.capabilities.appManagedTools).toBe("supported");

        // The turn: the launch, posture, bridge, and client a Chat session
        // with app tools uses, with this test answering as Octant's host.
        const calls: Array<{
          readonly name: string;
          readonly inputJson: string;
          readonly caller: unknown;
        }> = [];
        const bridge = await createOpenCodeManagedToolsBridge(
          [
            {
              name: "octant_echo",
              description: "Echoes text back.",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
          async (name, inputJson, _signal, callContext) => {
            calls.push({
              name,
              inputJson,
              caller: callContext?.metadata["ai.opencode/sessionID"],
            });
            return { resultJson: JSON.stringify({ echoed: "pong-from-octant" }), isError: false };
          },
        );
        const serverName = "octant-0123456789abcdef";
        const observed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const server = yield* processPort.start({
                binaryPath,
                cwd: projectRoot,
                mode: "chat",
                executionPolicy: "approval-gated",
                // The jail reaches loopback only on listed ports; the fake
                // model stands in for a remote provider endpoint.
                loopbackPorts: [bridge.port, model.port],
                betaPermissions: betaSessionPermissionRules("approval-gated", "chat", serverName),
              });
              expect(server.isolatedConfiguration).toBe(true);
              const client = makeOfficialOpenCodeClient(server, projectRoot);
              const abort = new AbortController();
              yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
              const events = yield* Effect.promise(() => client.subscribe(abort.signal));
              const permissionsAsked: string[] = [];
              void (async () => {
                for await (const event of events) {
                  if (event.type === "permission.v2.asked") permissionsAsked.push(event.type);
                }
              })().catch(() => undefined);
              yield* Effect.promise(() =>
                client.addMcpServer({ name: serverName, url: bridge.url }),
              );
              const session = yield* Effect.promise(() =>
                client.createSession({
                  permission: [],
                  model: { providerId: "fake", modelId: "fake-model" },
                }),
              );
              yield* Effect.promise(() =>
                client.prompt({
                  sessionId: session.id,
                  providerId: "fake",
                  modelId: "fake-model",
                  prompt: "Call the echo tool.",
                  permission: [],
                }),
              );
              const deadline = Date.now() + 30_000;
              while (
                !model.requests.some((entry) => entry.lastRole === "tool") &&
                Date.now() < deadline
              ) {
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
              }
              yield* Effect.promise(() => client.disconnectMcpServer(serverName));
              return { sessionId: session.id, permissionsAsked };
            }),
          ),
        );
        await bridge.close();
        // Code Mode is off for the bridge, so the tool is offered by its own
        // name, which only this connection's posture allows.
        const offered = model.requests.find((entry) =>
          entry.toolNames.includes(`${serverName}_octant_echo`),
        );
        expect(offered).toBeDefined();
        expect(calls).toEqual([
          { name: "octant_echo", inputJson: '{"text":"ping"}', caller: observed.sessionId },
        ]);
        expect(
          model.requests.some(
            (entry) => entry.lastRole === "tool" && entry.lastContent.includes("pong-from-octant"),
          ),
        ).toBe(true);
        // OpenCode itself asks nothing: the call is gated by Octant's own
        // tool request, which the driver raises before answering the bridge.
        expect(observed.permissionsAsked).toEqual([]);
      } finally {
        process.chdir(previousDirectory);
        await registry.closeAll();
        await new Promise<void>((resolve) => model.server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
