import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderToolDefinition,
} from "@octant/contracts";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeAcpDriver, type AcpClientPort, type AcpDriverOptions } from "./acpDriver";
import type { AcpConnection, AcpProcessPort } from "./acpProcess";
import { sanitizeAcpEnvironment } from "./acpProcess";
import { acpProviderProfiles, type AcpProviderKind, type AcpProviderProfile } from "./acpProfiles";
import { AcpFailure, type AcpNewSessionResult } from "./acpProtocol";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import type { ManagedToolAnswer, ManagedToolCallContext } from "./managedMcpTools";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000311");
const otherInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000312");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000313");
const modelId = "agent-k2" as ProviderModelId;
const projectRoot = "/tmp/octant-acp-driver";
const managedHome = "/tmp/octant-acp-home";
const binaryPath = "/Users/example/.local/bin/agent";

const kilo = acpProviderProfiles.kilo;
const devin = acpProviderProfiles.devin;
const vibe = acpProviderProfiles["mistral-vibe"];
const kimi = acpProviderProfiles["kimi-code"];
const fx = acpProviderProfiles.fx;
const profiles = Object.values(acpProviderProfiles);

class FakeClient implements AcpClientPort {
  readonly notifications = new Set<Parameters<AcpClientPort["onNotification"]>[0]>();
  readonly requests = new Set<Parameters<AcpClientPort["onRequest"]>[0]>();
  readonly setConfigOption = vi.fn(async () => ({ configOptions: this.configOptions }));
  readonly call = vi.fn(async () => ({})) as unknown as AcpClientPort["call"];
  readonly respondPermission = vi.fn(async () => undefined);
  readonly closeSession = vi.fn(async () => undefined);
  readonly authenticate = vi.fn(async () => undefined);
  readonly startBrowserAuthentication = vi.fn(async () => ({
    attemptId: "provider-attempt-1",
    signInUrl: "https://auth.mistral.example/attempt",
    expiresAt: "2026-07-17T11:00:00.123456Z",
  }));
  readonly completeBrowserAuthentication = vi.fn(async () => undefined);
  availableCommands: string[];
  readonly newSession = vi.fn(async (): Promise<AcpNewSessionResult> => {
    this.emitCommands("agent-session-1");
    return { sessionId: "agent-session-1", configOptions: this.configOptions };
  });
  readonly loadSession = vi.fn(async (sourceSessionId: string) => {
    if (sourceSessionId === "stale") throw new Error("private stale detail");
    return { sessionId: sourceSessionId, configOptions: this.configOptions };
  });
  readonly resumeSession = vi.fn(async (sourceSessionId: string) => {
    if (sourceSessionId === "stale") throw new Error("private stale detail");
    return { sessionId: sourceSessionId, configOptions: this.configOptions };
  });
  readonly prompt = vi.fn(async (sourceSessionId: string) => {
    this.emit({
      kind: "notification",
      method: "session/update",
      params: {
        sessionId: sourceSessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    });
    return { stopReason: "end_turn" };
  });
  readonly notify = vi.fn(async () => undefined);
  readonly configOptions: Array<{
    type: "select";
    id: string;
    name: string;
    currentValue: string;
    options: Array<{ value: string; name: string }>;
  }>;

  constructor(readonly profile: AcpProviderProfile) {
    this.availableCommands = [...(profile.reviewedCommands ?? [])];
    this.configOptions = [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "agent-k2",
        options: [
          { value: "agent-k2", name: "Agent K2" },
          { value: "agent-k2-thinking", name: "Agent K2 Thinking" },
        ],
      },
      {
        type: "select",
        id: profile.reasoningOptionId,
        name: "Reasoning",
        currentValue: "on",
        options: [
          { value: "off", name: "Off" },
          { value: "on", name: "On" },
        ],
      },
      {
        type: "select",
        id: "mode",
        name: "Mode",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      },
    ];
  }

  emitCommands(sourceSessionId: string) {
    if (this.profile.reviewedCommands === undefined) return;
    this.emit({
      kind: "notification",
      method: "session/update",
      params: {
        sessionId: sourceSessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: this.availableCommands.map((name) => ({ name, description: name })),
        },
      },
    });
  }
  onNotification(listener: Parameters<AcpClientPort["onNotification"]>[0]) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }
  onRequest(listener: Parameters<AcpClientPort["onRequest"]>[0]) {
    this.requests.add(listener);
    return () => this.requests.delete(listener);
  }
  emit(message: Parameters<Parameters<AcpClientPort["onNotification"]>[0]>[0]) {
    for (const listener of this.notifications) listener(message);
  }
  request(message: Parameters<Parameters<AcpClientPort["onRequest"]>[0]>[0]) {
    for (const listener of this.requests) listener(message);
  }
}

function permissionRequest(id: string, toolCallId: string) {
  return {
    kind: "request" as const,
    id,
    method: "session/request_permission" as const,
    params: {
      sessionId: "agent-session-1",
      toolCall: { toolCallId, title: "Write fixture file", kind: "edit" as const },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
  };
}

function fixture(
  profile: AcpProviderProfile,
  overrides: Partial<Pick<AcpDriverOptions, "authentication" | "managedToolsBridgeFactory">> & {
    readonly mcpHttp?: boolean;
    readonly nativeResume?: boolean;
    readonly runtimeVersion?: string;
  } = {},
) {
  const client = new FakeClient(profile);
  const starts: Array<Record<string, unknown>> = [];
  let active = 0;
  let peakActive = 0;
  let released = 0;
  const connection = {
    version: overrides.runtimeVersion ?? "7.4.11",
    pid: 311,
    root: managedHome,
    initialized: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: {
          list: {},
          ...(overrides.nativeResume === true ? { resume: {} } : {}),
        },
        ...(overrides.mcpHttp === true ? { mcpCapabilities: { http: true } } : {}),
      },
      authMethods: [{ id: "provider-auth" }],
      agentInfo: { name: profile.process.agentName, version: "0.0.0-dev" },
    },
    acp: {} as AcpConnection["acp"],
    exited: new Promise<void>(() => undefined),
  } satisfies AcpConnection;
  const processPort: AcpProcessPort = {
    start: (input) => {
      const { profile: _profile, ...rest } = input;
      starts.push(rest);
      return Effect.acquireRelease(
        Effect.sync(() => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          return { ...connection, root: input.root };
        }),
        () =>
          Effect.sync(() => {
            active -= 1;
            released += 1;
          }),
      );
    },
  };
  const credentialResolver = {
    has: vi.fn(async () => true),
    resolve: vi.fn(async () => "secret-provider-key"),
  };
  const registry = new ProviderRuntimeRegistry();
  const driver = makeAcpDriver({
    profile,
    instanceId,
    binaryPath,
    managedHome,
    process: processPort,
    runtimeRegistry: registry,
    credentialResolver,
    clientFactory: () => client,
    clock: () => "2026-07-17T10:00:00.000Z",
    correlationId: () => "80000000-0000-4000-8000-000000000314",
    requestId: (() => {
      let id = 0;
      return () => `request-${++id}`;
    })(),
    ...overrides,
  });
  return {
    driver,
    client,
    connection,
    registry,
    starts,
    credentialResolver,
    active: () => active,
    peakActive: () => peakActive,
    released: () => released,
  };
}

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  action: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("Expected a process platform descriptor.");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

async function collectTerminal(
  events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
): Promise<ReadonlyArray<ProviderRuntimeEvent>> {
  return Effect.runPromise(
    Stream.runCollect(
      events.pipe(
        Stream.filter((event) => event.sessionId === sessionId),
        Stream.takeUntil((event) =>
          ["completed", "interrupted", "failed", "waiting"].includes(event.kind),
        ),
      ),
    ).pipe(Effect.map((items) => Array.from(items) as ProviderRuntimeEvent[])),
  );
}

describe.each(profiles)("ACP provider driver ($displayName)", (profile) => {
  it("delivers immediate prompt output to every established subscriber", async () => {
    const { driver } = fixture(profile);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "full-access" });
          const first = yield* connection.subscribe;
          const second = yield* connection.subscribe;
          yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
          const outputs = yield* Effect.all(
            [first, second].map((events) =>
              Stream.runCollect(
                events.pipe(Stream.takeUntil((event) => event.kind === "completed")),
              ),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("1 second"));
          expect(Array.from(outputs[0] ?? [])).toEqual(Array.from(outputs[1] ?? []));
          expect(Array.from(outputs[0] ?? []).at(-1)?.kind).toBe("completed");
        }),
      ),
    );
  });

  it("probes through the managed home and discovers models without a prompt", async () => {
    const { driver, client, registry, active, released, starts } = fixture(profile);
    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(result).toMatchObject({
      instanceId,
      readiness: "ready",
      detectedVersion: "7.4.11",
      processState: "stopped",
      models: [
        { id: "agent-k2", displayName: "Agent K2", reasoning: "supported" },
        { id: "agent-k2-thinking", displayName: "Agent K2 Thinking", reasoning: "supported" },
      ],
      capabilities: {
        streaming: "supported",
        resume: "supported",
        interruption: "supported",
        approvals: "supported",
        userQuestions: profile.userQuestions,
        reasoning: "supported",
        usage: "unavailable",
        fileChanges: "unavailable",
        nativeChildAgents: "unavailable",
        harnessAutoReview: "unsupported",
      },
    });
    expect(client.newSession).toHaveBeenCalledOnce();
    expect(client.newSession).toHaveBeenCalledWith(managedHome);
    expect(starts[0]).toMatchObject({
      mode: "chat",
      executionPolicy: "approval-gated",
      purpose: "probe",
    });
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.authenticate).toHaveBeenCalledTimes(profile.authenticateOnProbe ? 1 : 0);
    if (profile.closesSessions) {
      expect(client.closeSession).toHaveBeenCalledWith("agent-session-1");
    } else {
      expect(client.closeSession).not.toHaveBeenCalled();
    }
    expect(registry.observedState(instanceId)).toEqual(result);
    expect(active()).toBe(0);
    expect(released()).toBe(1);
  });

  it("reports missing provider-owned authentication as actionable unauthenticated state", async () => {
    const { driver, client, active, released } = fixture(profile);
    const rejection = new AcpFailure("remote", "ACP authentication is required.");
    if (profile.authenticateOnProbe) client.authenticate.mockRejectedValueOnce(rejection);
    else client.newSession.mockRejectedValueOnce(rejection);

    const failure = await Effect.runPromise(
      Effect.scoped(Effect.flip(driver.probe({ instanceId }))),
    );
    expect(failure).toEqual({
      category: "unauthenticated",
      reason: "authentication-required",
      message: profile.unauthenticatedMessage,
    });
    expect(failure.message).toContain(profile.displayName);
    expect(active()).toBe(0);
    expect(released()).toBe(1);
  });

  it("keeps a safe stage and installed version when session discovery is refused", async () => {
    const { driver, client } = fixture(profile);
    client.newSession.mockRejectedValueOnce(
      new AcpFailure("remote", "ACP request failed.", "configuration"),
    );

    await expect(
      Effect.runPromise(Effect.scoped(Effect.flip(driver.probe({ instanceId })))),
    ).resolves.toMatchObject({
      category: "provider-failed",
      diagnostic: {
        stage: "model-discovery",
        kind: "protocol-failed",
        detectedVersion: "7.4.11",
        stderrContext: "Provider refused the ACP request because its configuration was invalid.",
      },
    });
  });

  it("does not claim resume when ACP negotiation omits load and resume support", async () => {
    const { driver, connection } = fixture(profile);
    const capabilities = connection.initialized.agentCapabilities as {
      loadSession?: boolean;
      sessionCapabilities?: { list?: object; resume?: object };
    };
    capabilities.loadSession = false;
    capabilities.sessionCapabilities = {};

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(result.capabilities.resume).toBe("unsupported");
  });

  it("does not claim reasoning when the agent exposes no reasoning option", async () => {
    const { driver, client } = fixture(profile);
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-plain");
      return {
        sessionId: "agent-session-plain",
        configOptions: client.configOptions.filter(
          (option) => option.id !== profile.reasoningOptionId,
        ),
      };
    });

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(result.capabilities.reasoning).toBe("unavailable");
    expect(result.models.every((model) => model.reasoning === "unavailable")).toBe(true);
  });

  it("declares the agent's reasoning choices so the composer can offer a level", async () => {
    const { driver } = fixture(profile);

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(result.models[0]?.options).toEqual([
      {
        id: profile.reasoningOptionId,
        displayName: "Reasoning",
        kind: "selection",
        values: ["off", "on"],
      },
    ]);
  });

  it("finds a reasoning option the agent names differently", async () => {
    const { driver, client } = fixture(profile);
    // The installed Grok agent reports `reasoning_effort` under
    // `category: "thought_level"`; matching the profile's id alone read it as
    // an agent that cannot reason.
    const renamed = (sourceSessionId: string): AcpNewSessionResult => ({
      sessionId: sourceSessionId,
      configOptions: client.configOptions.map((option) =>
        option.id === profile.reasoningOptionId
          ? {
              ...option,
              id: "reasoning_effort",
              name: "Reasoning Effort",
              category: "thought_level",
            }
          : option,
      ),
    });
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-renamed");
      return renamed("agent-session-renamed");
    });

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(result.capabilities.reasoning).toBe("supported");
    expect(result.models[0]?.options).toEqual([
      {
        id: "reasoning_effort",
        displayName: "Reasoning Effort",
        kind: "selection",
        values: ["off", "on"],
      },
    ]);
  });

  it("declares no selectable option when the agent exposes no reasoning control", async () => {
    const { driver, client } = fixture(profile);
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-plain");
      return {
        sessionId: "agent-session-plain",
        configOptions: client.configOptions.filter(
          (option) => option.id !== profile.reasoningOptionId,
        ),
      };
    });

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(result.models.every((model) => model.options.length === 0)).toBe(true);
  });

  // ACP lets an agent report its models either as a `model` config option or as
  // the session's own model state. An agent that only does the latter was read
  // as having none, so the picker offered nothing and no session could start.
  it("discovers the models an agent reports as session state rather than a config option", async () => {
    const { driver, client } = fixture(profile);
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-models");
      return {
        sessionId: "agent-session-models",
        models: {
          currentModelId: "agent-fast",
          availableModels: [
            { modelId: "agent-fast", name: "Agent Fast" },
            { modelId: "agent-deep", name: "Agent Deep" },
          ],
        },
      };
    });

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(result).toMatchObject({
      readiness: "ready",
      models: [
        { id: "agent-fast", displayName: "Agent Fast", source: "discovered" },
        { id: "agent-deep", displayName: "Agent Deep", source: "discovered" },
      ],
    });
  });

  it("reports degraded readiness when ACP exposes no selectable models", async () => {
    const { driver, client } = fixture(profile);
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-empty");
      return { sessionId: "agent-session-empty", configOptions: [] };
    });

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(result).toMatchObject({
      readiness: "degraded",
      models: [],
      message: `${profile.displayName} did not report a selectable model.`,
    });
    expect(result.lastSuccessfulProbeAt).toBeDefined();
  });

  it("reports app-managed tools only when the ACP handshake advertises HTTP MCP", async () => {
    const unsupported = await Effect.runPromise(
      Effect.scoped(fixture(profile).driver.probe({ instanceId })),
    );
    expect(unsupported.capabilities.appManagedTools).toBe("unsupported");
    const supported = await withProcessPlatform("darwin", () =>
      Effect.runPromise(
        Effect.scoped(fixture(profile, { mcpHttp: true }).driver.probe({ instanceId })),
      ),
    );
    expect(supported.capabilities.appManagedTools).toBe("supported");
  });

  it("registers the exact app tool catalogue before an HTTP-capable ACP session starts", async () => {
    const bridgeClose = vi.fn(async () => undefined);
    type ExecuteManagedTool = (
      name: string,
      inputJson: string,
      signal: AbortSignal,
      context?: ManagedToolCallContext,
    ) => Promise<ManagedToolAnswer>;
    const bridgeFactory = vi.fn(
      async (_definitions: ReadonlyArray<ProviderToolDefinition>, _handler: ExecuteManagedTool) => {
        return {
          server: {
            type: "http" as const,
            name: "octant-browser",
            url: "http://127.0.0.1:43123/mcp/test",
            headers: [{ name: "Authorization", value: "Bearer test" }],
          },
          port: 43123,
          attested: Promise.resolve(),
          bind: () => {},
          close: bridgeClose,
        };
      },
    );
    const { driver, client } = fixture(profiles[0]!, {
      mcpHttp: true,
      managedToolsBridgeFactory: bridgeFactory,
    });
    const tools = [
      {
        name: "octant_browser",
        inputSchema: { type: "object", properties: { operation: { type: "string" } } },
      },
    ] as const;

    await withProcessPlatform("darwin", () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
            yield* connection.start({
              sessionId,
              modelId,
              executionPolicy: "approval-gated",
              tools,
            });
            expect(client.newSession).toHaveBeenCalledWith(projectRoot, [
              expect.objectContaining({ type: "http", name: "octant-browser" }),
            ]);
            yield* connection.stop(sessionId);
          }),
        ),
      ),
    );
    expect(bridgeFactory).toHaveBeenCalledOnce();
    expect(bridgeClose).toHaveBeenCalledOnce();
  });

  it("refuses app tools before session creation when ACP HTTP MCP was not negotiated", async () => {
    const bridgeClose = vi.fn(async () => undefined);
    const bridgeFactory = vi.fn(async () => ({
      server: {
        type: "http" as const,
        name: "octant-browser",
        url: "http://127.0.0.1:43123/mcp/test",
        headers: [{ name: "Authorization", value: "Bearer test" }],
      },
      port: 43123,
      attested: Promise.resolve(),
      bind: () => {},
      close: bridgeClose,
    }));
    const { driver, client } = fixture(profiles[0]!, { managedToolsBridgeFactory: bridgeFactory });
    const tools = [
      { name: "octant_browser", inputSchema: { type: "object", properties: {} } },
    ] as const;
    const refusal = await withProcessPlatform("linux", () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.flip(
            Effect.gen(function* () {
              const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
              yield* connection.start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
                tools,
              });
            }),
          ),
        ),
      ),
    );
    expect(refusal).toEqual({
      category: "unsupported",
      message: "App-managed tools are unsupported by this ACP runtime on this platform.",
    });
    expect(client.newSession).not.toHaveBeenCalled();
    expect(bridgeFactory).not.toHaveBeenCalled();
    expect(bridgeClose).not.toHaveBeenCalled();
  });

  it("correlates an ACP MCP tool request through the provider SDK answer seam and cancels it", async () => {
    const bridgeClose = vi.fn(async () => undefined);
    type ExecuteManagedTool = (
      name: string,
      inputJson: string,
      signal: AbortSignal,
      context?: ManagedToolCallContext,
    ) => Promise<ManagedToolAnswer>;
    let execute: ExecuteManagedTool | undefined;
    const bridgeFactory = vi.fn(
      async (_definitions: ReadonlyArray<ProviderToolDefinition>, handler: ExecuteManagedTool) => {
        execute = handler;
        return {
          server: {
            type: "http" as const,
            name: "octant-browser",
            url: "http://127.0.0.1:43123/mcp/test",
            headers: [{ name: "Authorization", value: "Bearer test" }],
          },
          port: 43123,
          attested: Promise.resolve(),
          bind: () => {},
          close: bridgeClose,
        };
      },
    );
    const { driver, client } = fixture(profiles[0]!, {
      mcpHttp: true,
      managedToolsBridgeFactory: bridgeFactory,
    });
    client.prompt.mockImplementation(() => new Promise(() => {}));
    const tools = [
      { name: "octant_browser", inputSchema: { type: "object", properties: {} } },
    ] as const;
    await withProcessPlatform("darwin", () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
            yield* connection.start({
              sessionId,
              modelId,
              executionPolicy: "approval-gated",
              tools,
            });
            yield* connection.send({
              sessionId,
              prompt: "use the browser",
              attachments: [],
              tools,
            });
            if (execute === undefined)
              throw new Error("ACP managed tool handler was not registered.");
            const stream = yield* connection.subscribe;
            const controller = new AbortController();
            const result = execute(
              "octant_browser",
              '{"operation":"read-page"}',
              controller.signal,
            );
            const requestFiber = yield* Effect.fork(
              Stream.runCollect(
                stream.pipe(
                  Stream.filter((event) => event.kind === "tool-request"),
                  Stream.take(1),
                ),
              ),
            );
            const requestEvents = yield* Fiber.join(requestFiber);
            const requestEvent = Array.from(requestEvents)[0];
            if (requestEvent?.kind !== "tool-request") throw new Error("Missing ACP tool request.");
            const requestSignal = connection.toolRequestSignal?.({
              sessionId,
              requestId: requestEvent.requestId,
            });
            expect(requestSignal).toBeInstanceOf(AbortSignal);
            expect(requestSignal).not.toBe(controller.signal);
            controller.abort();
            expect(requestSignal?.aborted).toBe(true);
            yield* Effect.promise(() =>
              expect(result).resolves.toEqual({
                resultJson: '{"error":"tool-interrupted"}',
                isError: true,
              }),
            );
            yield* connection.stop(sessionId);
          }),
        ),
      ),
    );
    expect(bridgeClose).toHaveBeenCalledOnce();
  });

  it("requires an explicit product mode and matching instance before acquire", async () => {
    const { driver } = fixture(profile);
    await expect(
      Effect.runPromise(
        Effect.scoped(Effect.flip(driver.acquire({ instanceId, projectRoot }))),
      ).then((failure) => failure.category),
    ).resolves.toBe("invalid-configuration");
    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.flip(driver.acquire({ instanceId: otherInstanceId, projectRoot, mode: "code" })),
        ),
      ).then((failure) => failure.category),
    ).resolves.toBe("invalid-configuration");
  });

  if (profile.kind === "mistral-vibe") {
    it.each([
      ["2.25.0", undefined, "supported"],
      ["2.25.1", undefined, "unsupported"],
      ["2.25.0", false, "unsupported"],
    ] as const)(
      "honors HTTP capability evidence for %s with advertisement %s",
      async (runtimeVersion, http, expected) => {
        const { driver, connection } = fixture(profile, { runtimeVersion });
        if (http !== undefined)
          Object.assign(connection.initialized.agentCapabilities, { mcpCapabilities: { http } });
        await withProcessPlatform("darwin", async () => {
          const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
          expect(result.capabilities.appManagedTools).toBe(expected);
        });
      },
    );

    it.each(["approval-gated", "full-access"] as const)(
      "resumes a settled native conversation under %s without concurrent writers",
      async (nextPolicy) => {
        const { driver, client, registry, starts, active, peakActive } = fixture(profile, {
          runtimeVersion: "2.25.0",
        });
        try {
          const cursor = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
                const handle = yield* connection.start({
                  sessionId,
                  modelId,
                  executionPolicy: "approval-gated",
                });
                const events = yield* Effect.fork(
                  Stream.runCollect(
                    (yield* connection.subscribe).pipe(
                      Stream.takeUntil((event) => event.kind === "completed"),
                    ),
                  ),
                );
                yield* connection.send({
                  sessionId,
                  prompt: "remember",
                  tools: [],
                  attachments: [],
                });
                yield* Fiber.join(events);
                yield* connection.stop(sessionId);
                return handle.resumeCursor;
              }),
            ),
          );
          expect(active()).toBe(1);
          if (cursor === undefined) throw new Error("Missing cursor");
          const nativeIdentity = JSON.stringify(["acp-native", profile.kind, cursor.value]);
          expect(registry.claimNativeSession(instanceId, nativeIdentity).status).toBe("refused");
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
                yield* connection.resume({
                  sessionId,
                  resumeCursor: cursor,
                  executionPolicy: nextPolicy,
                });
                expect(starts).toHaveLength(nextPolicy === "approval-gated" ? 1 : 2);
                if (nextPolicy === "approval-gated") {
                  expect(client.loadSession).not.toHaveBeenCalled();
                  expect(client.resumeSession).not.toHaveBeenCalled();
                } else {
                  expect(client.loadSession).toHaveBeenCalledWith(cursor.value, projectRoot);
                }
                expect(registry.claimNativeSession(instanceId, nativeIdentity).status).toBe(
                  "refused",
                );
                expect(peakActive()).toBe(1);
                yield* connection.stop(sessionId);
              }),
            ),
          );
          expect(active()).toBe(0);
        } finally {
          await registry.closeAll();
        }
      },
    );

    it
      .skipIf(profile.kind !== "mistral-vibe")
      .each(["unfinished-tool", "late-event", "idle-event"] as const)(
      "destroys a settled process with %s activity",
      async (activity) => {
        const { driver, client, registry, active } = fixture(profile, { runtimeVersion: "2.25.0" });
        const emit = () =>
          client.emit({
            kind: "notification",
            method: "session/update",
            params: {
              sessionId: "agent-session-1",
              update: { sessionUpdate: "tool_call", toolCallId: "unfinished", title: "shell" },
            },
          });
        if (activity === "unfinished-tool")
          client.prompt.mockImplementationOnce(async () => {
            emit();
            return { stopReason: "end_turn" };
          });
        try {
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
                yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
                const events = yield* Effect.fork(
                  Stream.runCollect(
                    (yield* connection.subscribe).pipe(
                      Stream.takeUntil((event) => event.kind === "completed"),
                    ),
                  ),
                );
                yield* connection.send({
                  sessionId,
                  prompt: "complete",
                  tools: [],
                  attachments: [],
                });
                yield* Fiber.join(events);
                if (activity === "late-event") emit();
                yield* connection.stop(sessionId);
                if (activity === "idle-event") emit();
                yield* Effect.promise(() => vi.waitFor(() => expect(active()).toBe(0)));
              }),
            ),
          );
        } finally {
          await registry.closeAll();
        }
      },
    );
  }

  it("waits for starting sessions at shutdown and refuses to admit them afterward", async () => {
    const { driver, client, registry, active } = fixture(profile);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.setConfigOption.mockImplementationOnce(async () => {
      await gate;
      return { configOptions: client.configOptions };
    });
    // Profile-specific model selection can bypass setConfigOption.
    vi.mocked(client.call).mockImplementation(async () => {
      await gate;
      return {};
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          const starting = yield* Effect.fork(
            Effect.flip(
              connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
            ),
          );
          yield* Effect.promise(() => vi.waitFor(() => expect(active()).toBe(1)));
          let closed = false;
          const closing = registry.closeAll().then(() => {
            closed = true;
          });
          yield* Effect.promise(async () => {
            await Promise.resolve();
            expect(closed).toBe(false);
            release();
          });
          yield* Fiber.join(starting);
          yield* Effect.promise(() => closing);
          expect(active()).toBe(0);
        }),
      ),
    );
  });

  it("refuses another connection before it can open the same native conversation", async () => {
    const { driver, starts } = fixture(profile);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          const second = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          const handle = yield* first.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          if (handle.resumeCursor === undefined) throw new Error("Expected native cursor");
          const before = starts.length;
          yield* Effect.flip(
            second.resume({
              sessionId,
              resumeCursor: handle.resumeCursor,
              executionPolicy: "approval-gated",
            }),
          );
          expect(starts).toHaveLength(before);
          const alias = decodeProviderSessionId("80000000-0000-4000-8000-000000000399");
          if (handle.resumeCursor.binding === undefined) throw new Error("Expected binding");
          yield* Effect.flip(
            second.resume({
              sessionId: alias,
              resumeCursor: {
                ...handle.resumeCursor,
                binding: { ...handle.resumeCursor.binding, sessionId: alias },
              },
              executionPolicy: "approval-gated",
            }),
          );
          expect(starts).toHaveLength(before);
          yield* first.stop(sessionId);
          yield* second.resume({
            sessionId,
            resumeCursor: handle.resumeCursor,
            executionPolicy: "approval-gated",
          });
          expect(starts).toHaveLength(before + 1);
          yield* second.stop(sessionId);
        }),
      ),
    );
  });

  it.each([
    ["code", "approval-gated"],
    ["code", "plan"],
    ["code", "full-access"],
    ["chat", "approval-gated"],
  ] as const)(
    "launches %s %s in the profile root and applies the profile ACP mode",
    async (productMode, executionPolicy) => {
      const refusal = profile.refuses?.(productMode, executionPolicy);
      if (refusal !== undefined) {
        // A profile that refuses a mode refuses before a session process
        // starts, so the turn fails closed instead of running read-only.
        const { driver, starts } = fixture(profile);
        const failure = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* driver.acquire({
                instanceId,
                projectRoot,
                mode: productMode,
              });
              return yield* Effect.flip(connection.start({ sessionId, modelId, executionPolicy }));
            }),
          ),
        );
        expect(failure).toMatchObject({ category: "incompatible", message: refusal });
        expect(starts).toEqual([]);
        return;
      }
      const { driver, client, starts, active, registry } = fixture(profile);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* driver.acquire({
              instanceId,
              projectRoot,
              mode: productMode,
            });
            yield* connection.start({ sessionId, modelId, executionPolicy });
            expect(active()).toBe(1);
            yield* connection.stop(sessionId);
          }),
        ),
      );
      const expectedRoot =
        productMode === "chat" && profile.chatSessionRoot === "managed-home"
          ? managedHome
          : projectRoot;
      expect(starts).toEqual([
        {
          binaryPath,
          root: expectedRoot,
          managedHome,
          mode: productMode,
          executionPolicy,
          onProcessStarted: expect.any(Function),
        },
      ]);
      expect(client.newSession).toHaveBeenCalledWith(expectedRoot);
      // A profile without its own request shape is standard ACP, and has to go
      // through the call that decodes the reply rather than the untyped one.
      const expectedModelRequest = profile.setModelCall?.("agent-session-1", modelId);
      if (expectedModelRequest === undefined) {
        expect(client.setConfigOption).toHaveBeenCalledWith("agent-session-1", "model", modelId);
      } else {
        expect(client.call).toHaveBeenCalledWith(
          expectedModelRequest.method,
          expectedModelRequest.params,
        );
      }
      const modeValue = profile.sessionMode(productMode, executionPolicy);
      const expectedModeRequest = profile.setModeCall?.("agent-session-1", modeValue);
      if (expectedModeRequest === undefined) {
        expect(client.setConfigOption).toHaveBeenCalledWith("agent-session-1", "mode", modeValue);
      } else {
        expect(client.call).toHaveBeenCalledWith(
          expectedModeRequest.method,
          expectedModeRequest.params,
        );
      }
      expect(active()).toBe(0);
      expect(registry.activeSessionCount(instanceId)).toBe(0);
    },
  );

  it("applies the chosen reasoning level to the session it starts", async () => {
    const { driver, client } = fixture(profile);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
            modelOptionValues: { [profile.reasoningOptionId]: "on" },
          });
          yield* connection.stop(sessionId);
        }),
      ),
    );

    expect(client.setConfigOption).toHaveBeenCalledWith(
      "agent-session-1",
      profile.reasoningOptionId,
      "on",
    );
  });

  it("applies a reasoning level the agent names differently", async () => {
    const { driver, client } = fixture(profile);
    const renamedOptions = client.configOptions.map((option) =>
      option.id === profile.reasoningOptionId
        ? {
            ...option,
            id: "reasoning_effort",
            name: "Reasoning Effort",
            category: "thought_level",
          }
        : option,
    );
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-renamed");
      return {
        sessionId: "agent-session-renamed",
        configOptions: renamedOptions,
      };
    });
    client.setConfigOption.mockImplementation(async () => ({
      configOptions: renamedOptions,
    }));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
            modelOptionValues: { reasoning_effort: "on" },
          });
          yield* connection.stop(sessionId);
        }),
      ),
    );

    expect(client.setConfigOption).toHaveBeenCalledWith(
      "agent-session-renamed",
      "reasoning_effort",
      "on",
    );
  });

  it("leaves the agent's own level alone when the chosen value is not offered", async () => {
    const { driver, client } = fixture(profile);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
            modelOptionValues: { [profile.reasoningOptionId]: "ultra" },
          });
          yield* connection.stop(sessionId);
        }),
      ),
    );

    // The session keeps the agent's own level: no call carries the option.
    const reasoningCalls = client.setConfigOption.mock.calls.filter(
      (call) => (call as ReadonlyArray<unknown>)[1] === profile.reasoningOptionId,
    );
    expect(reasoningCalls).toEqual([]);
  });

  it("applies a reasoning level the agent reports with the model selection", async () => {
    const { driver, client } = fixture(profile);
    // The agent omits its reasoning control until a model is selected, and the
    // reply to the model selection carries it. Resolving the option from the
    // session's original list would read it as absent and drop the choice.
    // Profiles that set the model with a vendor-shaped call do not receive the
    // updated options in a standard reply, so the refresh does not reach them.
    if (profile.setModelCall !== undefined) return;
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-1");
      return {
        sessionId: "agent-session-1",
        configOptions: client.configOptions.filter(
          (option) => option.id !== profile.reasoningOptionId,
        ),
      };
    });
    client.setConfigOption.mockImplementationOnce(async () => ({
      configOptions: client.configOptions,
    }));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
            modelOptionValues: { [profile.reasoningOptionId]: "on" },
          });
          yield* connection.stop(sessionId);
        }),
      ),
    );

    expect(client.setConfigOption).toHaveBeenCalledWith(
      "agent-session-1",
      profile.reasoningOptionId,
      "on",
    );
  });

  // An agent may publish a model's reasoning levels in the session model state's
  // own metadata and send no config options at all. Grok Build does this, so
  // every one of its models was read as unable to reason, and the composer drew
  // no reasoning control for a model that offers four levels.
  it("declares the reasoning levels a model publishes in its own session metadata", async () => {
    if (profile.sessionMetaReasoning === undefined) return;
    const { driver, client } = fixture(profile);
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-meta");
      return {
        sessionId: "agent-session-meta",
        models: {
          currentModelId: "agent-k2",
          availableModels: [
            {
              modelId: "agent-k2",
              name: "Agent K2",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEfforts: [{ value: "xhigh" }, { value: "low" }],
              },
            },
            { modelId: "agent-k2-plain", name: "Agent K2 Plain", _meta: {} },
          ],
        },
      };
    });

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(result.capabilities.reasoning).toBe("supported");
    expect(result.models).toMatchObject([
      {
        id: "agent-k2",
        reasoning: "supported",
        options: [{ id: profile.reasoningOptionId, kind: "selection", values: ["xhigh", "low"] }],
      },
      { id: "agent-k2-plain", reasoning: "unavailable", options: [] },
    ]);
  });

  it("opens the session with the chosen level, because a model call resets it", async () => {
    if (profile.sessionMetaReasoning === undefined) return;
    const { driver, client } = fixture(profile);
    client.newSession.mockImplementationOnce(async () => {
      client.emitCommands("agent-session-level");
      return {
        sessionId: "agent-session-level",
        models: {
          currentModelId: modelId,
          availableModels: [
            {
              modelId,
              name: "Agent K2",
              _meta: { supportsReasoningEffort: true, reasoningEfforts: [{ value: "low" }] },
            },
          ],
        },
      };
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
            modelOptionValues: { [profile.reasoningOptionId]: "low" },
          });
          yield* connection.stop(sessionId);
        }),
      ),
    );

    expect(client.newSession).toHaveBeenCalledWith(projectRoot, [], {
      modelId,
      reasoningEffort: "low",
    });
    // The session already opened the requested model, so nothing switches it:
    // the agent resets a level its own model call did not set.
    expect(client.call).not.toHaveBeenCalledWith("session/set_model", expect.anything());
    expect(client.setConfigOption).not.toHaveBeenCalled();
  });

  it("tells the user to sign in again when a turn is refused for a stale credential", async () => {
    // A managed home holding an expired credential passes the probe: the agent
    // opens the session and reports its models, and only the turn is refused.
    // Reporting that as a generic provider failure left the user with nothing
    // to act on.
    const { driver, client } = fixture(profile);
    client.prompt.mockRejectedValueOnce(
      new AcpFailure("remote", "ACP authentication is required."),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const runtimeEvents = yield* connection.subscribe;
          const collected = yield* Effect.fork(
            Effect.promise(() => collectTerminal(runtimeEvents)),
          );
          yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
          const events = yield* Fiber.join(collected);
          const last = events.at(-1);
          expect(last?.kind).toBe("failed");
          expect(last?.kind === "failed" ? last.failure : undefined).toEqual({
            category: "unauthenticated",
            message: profile.unauthenticatedMessage,
          });
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it("normalizes a streamed turn and returns an exact opaque resume cursor", async () => {
    const { driver } = fixture(profile);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          const handle = yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          expect(handle.resumeCursor).toEqual({
            driverKind: profile.kind,
            value: "agent-session-1",
            binding: { instanceId, sessionId, projectRoot, mode: "code", modelId },
          });
          const runtimeEvents = yield* connection.subscribe;
          const collected = yield* Effect.fork(
            Effect.promise(() => collectTerminal(runtimeEvents)),
          );
          yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
          const events = yield* Fiber.join(collected);
          expect(events.map((event) => event.kind)).toEqual(["text-delta", "completed"]);
          expect(events.map((event) => event.sequence)).toEqual([1, 2]);
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it.skipIf(profile.refuses?.("code", "plan") !== undefined)(
    "correlates approvals and denies approvals in plan mode",
    async () => {
      const { driver, client } = fixture(profile);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
            yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
            client.request(permissionRequest("permission-provider", "tool-1"));
            yield* Effect.sleep("1 millis");
            yield* connection.answerApproval({ sessionId, requestId: "request-1", approved: true });
            expect(client.respondPermission).toHaveBeenCalledWith(
              "permission-provider",
              "allow_once",
            );
            yield* connection.stop(sessionId);

            yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
            client.request(permissionRequest("permission-plan", "tool-2"));
            yield* Effect.sleep("1 millis");
            const failure = yield* Effect.flip(
              connection.answerApproval({ sessionId, requestId: "request-2", approved: true }),
            );
            expect(failure.category).toBe("protocol");
            expect(client.respondPermission).toHaveBeenCalledWith("permission-plan", "reject_once");
            expect(client.respondPermission).toHaveBeenCalledTimes(2);
            yield* connection.stop(sessionId);
          }),
        ),
      );
    },
  );

  it.skipIf(profile.refuses?.("code", "plan") !== undefined)(
    "absorbs transport failure and keeps sequence contiguous for auto-rejected Plan side effects",
    async () => {
      const { driver, client } = fixture(profile);
      const rejection = Promise.reject(new Error("private transport detail"));
      void rejection.catch(() => undefined);
      const catchRejection = vi.spyOn(rejection, "catch");
      client.respondPermission.mockReturnValueOnce(rejection);

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
            yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
            client.request(permissionRequest("permission-plan-failure", "tool-plan"));
            yield* Effect.sleep("1 millis");
            expect(catchRejection).toHaveBeenCalledOnce();
            const runtimeEvents = yield* connection.subscribe;
            const collected = yield* Effect.fork(
              Effect.promise(() => collectTerminal(runtimeEvents)),
            );
            yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
            const events = yield* Fiber.join(collected);
            expect(events.map((event) => event.sequence)).toEqual([1, 2]);
            yield* connection.stop(sessionId);
          }),
        ),
      );
    },
  );

  it("reattaches the exact ACP session for a valid exact-root cursor", async () => {
    const { driver, client } = fixture(profile);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          const started = yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          yield* connection.stop(sessionId);
          if (started.resumeCursor === undefined) throw new Error("Missing resume cursor.");
          yield* connection.resume({
            sessionId,
            resumeCursor: started.resumeCursor,
            executionPolicy: "approval-gated",
          });
          if (profile.resumeMethod === "session/resume") {
            expect(client.resumeSession).toHaveBeenCalledWith("agent-session-1", projectRoot);
            expect(client.loadSession).not.toHaveBeenCalled();
          } else {
            expect(client.loadSession).toHaveBeenCalledWith("agent-session-1", projectRoot);
            expect(client.resumeSession).not.toHaveBeenCalled();
          }
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it("uses negotiated native resume without requesting a transcript replay", async () => {
    const { driver, client } = fixture(profile, { nativeResume: true });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          const started = yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          yield* connection.stop(sessionId);
          if (started.resumeCursor === undefined) throw new Error("Missing resume cursor.");
          yield* connection.resume({
            sessionId,
            resumeCursor: started.resumeCursor,
            executionPolicy: "approval-gated",
          });
          expect(client.resumeSession).toHaveBeenCalledWith("agent-session-1", projectRoot);
          expect(client.loadSession).not.toHaveBeenCalled();
          expect(client.newSession).toHaveBeenCalledTimes(1);
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it("rejects stale, wrong-driver, and cross-root resume", async () => {
    const { driver } = fixture(profile);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* connection.stop(sessionId);
          for (const resumeCursor of [
            { driverKind: "codex" as const, value: "agent-session-1" },
            { driverKind: profile.kind, value: "stale" },
          ]) {
            const failure = yield* Effect.flip(
              connection.resume({ sessionId, resumeCursor, executionPolicy: "approval-gated" }),
            );
            expect(failure.category).toBe("stale-resume");
          }
        }),
      ),
    );
    const other = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({
            instanceId,
            projectRoot: "/tmp/other-root",
            mode: "code",
          });
          return yield* Effect.flip(
            connection.resume({
              sessionId,
              resumeCursor: { driverKind: profile.kind, value: "agent-session-1" },
              executionPolicy: "approval-gated",
            }),
          );
        }),
      ),
    );
    expect(other.category).toBe("stale-resume");
  });
});

describe("ACP provider driver profile quirks", () => {
  it.each([
    [devin, "code", "approval-gated", "ask"],
    [devin, "code", "plan", "plan"],
    [devin, "code", "full-access", "bypass"],
    [devin, "chat", "full-access", "ask"],
    [vibe, "code", "approval-gated", "ask"],
    [vibe, "code", "plan", "plan"],
    [vibe, "code", "full-access", "auto-approve"],
    [vibe, "chat", "full-access", "ask"],
    [kimi, "code", "approval-gated", "default"],
    [kimi, "code", "plan", "plan"],
    [kimi, "code", "full-access", "yolo"],
    [kilo, "code", "full-access", "octant"],
    [kilo, "chat", "approval-gated", "octant"],
    [fx, "code", "approval-gated", "ask"],
    [fx, "code", "full-access", "code"],
  ] as const)(
    "maps $0.displayName %s %s only to the approved ACP mode %s",
    (profile, mode, policy, expected) => {
      expect(profile.sessionMode(mode, policy)).toBe(expected);
    },
  );

  it("refuses fx where it would run with runtime tools Octant did not admit", () => {
    // fx always advertises runtime tools, so a read-only product mode cannot
    // be honoured; the refusal happens before a session process starts.
    expect(fx.refuses?.("chat", "approval-gated")).toMatch(/cannot run read-only/);
    expect(fx.refuses?.("code", "plan")).toMatch(/cannot run read-only/);
    expect(fx.refuses?.("work", "approval-gated")).toBeUndefined();
    expect(fx.refuses?.("code", "full-access")).toBeUndefined();
    // fx's own `code` mode maps to `permissionMode: "auto"`, so only an
    // explicit Full access turn may select it.
    expect(fx.sessionMode("code", "approval-gated")).toBe("ask");
  });

  it("keeps fx in a managed home and denies its workspace instruction and extension surfaces", () => {
    const environment = sanitizeAcpEnvironment(
      fx,
      { PATH: "/usr/bin", HOME: "/Users/example", AI_GATEWAY_API_KEY: "host-secret" },
      { managedHome: "/var/empty/octant-fx-home", apiKey: "brokered-key" },
    );
    // fx resolves its whole profile through $HOME and exposes no profile-path
    // variable, so the managed home is the only thing standing between it and
    // the interactive ~/.fx profile.
    expect(environment.HOME).toBe("/var/empty/octant-fx-home");
    expect(environment.XDG_CONFIG_HOME).toBe("/var/empty/octant-fx-home/.config");
    expect(environment.AI_GATEWAY_API_KEY).toBe("brokered-key");
    expect(fx.process.hostAuthentication).toBeUndefined();
    // `permission_mode` is a profile-owned key that a project `.fx.json`
    // cannot raise, and the pin keeps a session that fails to select its mode
    // on `ask` rather than fx's default `auto`.
    expect(fx.process.guards.FX_PERMISSION_MODE).toBe("ask");
    expect(fx.process.forbiddenRootEntries).toEqual([
      ".fx.json",
      ".mcp.json",
      "AGENTS.md",
      ".agents",
    ]);
  });

  it("leaves Mistral Vibe a selectable default agent for every mode it can request", () => {
    const guards = vibe.process.guards;
    const enabled = JSON.parse(guards.VIBE_ENABLED_AGENTS ?? "[]") as ReadonlyArray<string>;

    // Vibe resolves `default_agent` against these guards while creating the
    // session, so a guard that excludes it fails `session/new` before any mode
    // is requested.
    expect(guards).not.toHaveProperty("VIBE_DISABLED_AGENTS");
    expect(enabled).toContain(guards.VIBE_DEFAULT_AGENT);
    for (const mode of ["chat", "work", "code"] as const) {
      for (const policy of ["approval-gated", "plan", "full-access"] as const) {
        expect(enabled).toContain(vibe.sessionMode(mode, policy));
      }
    }
    expect(enabled).not.toContain("accept-edits");
  });

  it("does not select the Kimi auto mode for any execution policy", () => {
    for (const policy of ["approval-gated", "plan", "full-access"] as const) {
      expect(kimi.sessionMode("code", policy)).not.toBe("auto");
    }
  });

  it("fails closed when Kimi Code advertises an unreviewed embedded command", async () => {
    const { driver, client } = fixture(kimi);
    client.availableCommands.push("unexpected-provider-command");

    const failure = await Effect.runPromise(
      Effect.scoped(Effect.flip(driver.probe({ instanceId }))),
    );
    expect(failure).toEqual({
      category: "incompatible",
      reason: "runtime-incompatible",
      message: "Kimi Code advertised an unreviewed command inventory.",
    });
  });

  it("rejects provider slash commands before they reach Kimi Code ACP", async () => {
    const { driver, client } = fixture(kimi);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const failure = yield* Effect.flip(
            connection.send({ sessionId, prompt: "  /skill:embedded", attachments: [], tools: [] }),
          );
          expect(failure).toEqual({
            category: "unauthorized",
            message:
              "Kimi Code slash commands are disabled. Rephrase the request without a leading slash.",
          });
          expect(client.prompt).not.toHaveBeenCalled();
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it("answers single-select questions for agents that support user input", async () => {
    const { driver, client } = fixture(kilo);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          client.request({
            kind: "request",
            id: "question-provider",
            method: "session/request_permission",
            params: {
              sessionId: "agent-session-1",
              toolCall: { toolCallId: "question", title: "Choose" },
              options: [
                { optionId: "q0_opt_0", name: "A", kind: "allow_once" },
                { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
              ],
            },
          });
          yield* Effect.sleep("1 millis");
          yield* connection.answerUserInput({ sessionId, requestId: "request-1", answer: "A" });
          expect(client.respondPermission).toHaveBeenCalledWith("question-provider", "q0_opt_0");
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it("fails closed on user questions for Mistral Vibe and skips them at the agent", async () => {
    const { driver, client } = fixture(vibe, { authentication: "subscription" });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const runtimeEvents = yield* connection.subscribe;
          const collected = yield* Effect.fork(
            Effect.promise(() => collectTerminal(runtimeEvents)),
          );
          client.request({
            kind: "request",
            id: "question-provider",
            method: "session/request_permission",
            params: {
              sessionId: "agent-session-1",
              toolCall: { toolCallId: "question", title: "Choose" },
              options: [
                { optionId: "q0_opt_0", name: "A", kind: "allow_once" },
                { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
              ],
            },
          });
          const events = yield* Fiber.join(collected);
          expect(events.map((event) => event.kind)).toEqual(["failed"]);
          expect(client.respondPermission).toHaveBeenCalledWith("question-provider", "q0_skip");
          const failure = yield* Effect.flip(
            connection.answerUserInput({ sessionId, requestId: "request-1", answer: "A" }),
          );
          expect(failure.category).toBe("unsupported");
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it("resolves a Mistral Vibe API key only at process launch and never exposes it", async () => {
    const { driver, starts, credentialResolver } = fixture(vibe, { authentication: "api-key" });
    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(credentialResolver.has).toHaveBeenCalledWith(instanceId);
    expect(credentialResolver.resolve).toHaveBeenCalledWith(instanceId);
    expect(starts).toEqual([
      {
        binaryPath,
        root: managedHome,
        managedHome,
        mode: "chat",
        executionPolicy: "approval-gated",
        purpose: "probe",
        apiKey: "secret-provider-key",
        onProcessStarted: expect.any(Function),
      },
    ]);
    expect(result).toMatchObject({ credentialStatus: "stored" });
    expect(JSON.stringify(result)).not.toContain("secret-provider-key");
  });

  it("does not consult the credential broker for subscription or provider-owned authentication", async () => {
    for (const [profile, authentication] of [
      [vibe, "subscription"],
      [kilo, undefined],
      [kimi, undefined],
      [acpProviderProfiles.glm, "provider-owned"],
      [acpProviderProfiles.gemini, "provider-owned"],
      [acpProviderProfiles.cline, "provider-owned"],
      [acpProviderProfiles.qwen, "provider-owned"],
    ] as const) {
      const { driver, credentialResolver } = fixture(
        profile,
        authentication === undefined ? {} : { authentication },
      );
      await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
      expect(credentialResolver.has).not.toHaveBeenCalled();
      expect(credentialResolver.resolve).not.toHaveBeenCalled();
    }
  });

  it("does not offer browser authentication for provider-owned profiles", () => {
    for (const kind of [
      "kilo",
      "devin",
      "mistral-vibe",
      "grok",
      "glm",
      "gemini",
      "copilot",
      "cline",
      "qwen",
      "kimi-code",
    ] as const satisfies AcpProviderKind[]) {
      const { driver } = fixture(acpProviderProfiles[kind]);
      expect(driver.beginAuthentication).toBeUndefined();
      expect(driver.completeAuthentication).toBeUndefined();
    }
  });
});

it("resumes the same native session after recreating the driver", async () => {
  const first = fixture(vibe);
  const handle = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* first.driver.acquire({ instanceId, mode: "code", projectRoot });
        const started = yield* connection.start({
          sessionId,
          modelId,
          executionPolicy: "approval-gated",
        });
        yield* connection.stop(sessionId);
        return started;
      }),
    ),
  );
  if (handle.resumeCursor === undefined) throw new Error("Missing cursor");
  const cursor = handle.resumeCursor;
  const restarted = fixture(vibe);
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* restarted.driver.acquire({
          instanceId,
          mode: "code",
          projectRoot,
        });
        return yield* connection.resume({
          sessionId,
          resumeCursor: cursor,
          executionPolicy: "approval-gated",
        });
      }),
    ),
  );
  expect(result.resumeCursor).toEqual(cursor);
});

it("adding Computer use on a resumed task can send the next message", async () => {
  const { driver, client } = fixture(vibe, {
    mcpHttp: true,
    managedToolsBridgeFactory: async () => ({
      server: {
        type: "http",
        name: "octant-tools",
        url: "http://127.0.0.1:43123/mcp/test",
        headers: [],
      },
      port: 43123,
      attested: Promise.resolve(),
      bind: () => {},
      close: async () => undefined,
    }),
  });
  await withProcessPlatform("darwin", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, mode: "code", projectRoot });
          const started = yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
            tools: [],
          });
          yield* connection.stop(sessionId);
          if (started.resumeCursor === undefined) throw new Error("Missing cursor");
          yield* connection.resume({
            sessionId,
            resumeCursor: started.resumeCursor,
            executionPolicy: "approval-gated",
            tools: [{ name: "octant_computer", inputSchema: { type: "object" } }],
          });
          yield* connection.send({
            sessionId,
            prompt: "Use the selected computer tool",
            attachments: [],
            tools: [{ name: "octant_computer", inputSchema: { type: "object" } }],
          });
          yield* connection.stop(sessionId);
          yield* connection.resume({
            sessionId,
            resumeCursor: started.resumeCursor,
            executionPolicy: "approval-gated",
            tools: [],
          });
          yield* connection.send({
            sessionId,
            prompt: "Continue without tools",
            attachments: [],
            tools: [],
          });
          expect(client.newSession).toHaveBeenCalledOnce();
          expect(client.loadSession).toHaveBeenLastCalledWith("agent-session-1", projectRoot);
        }),
      ),
    ),
  );
});

it("refuses a durable cursor in another Project before starting a process", async () => {
  const first = fixture(vibe);
  const cursor = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* first.driver.acquire({ instanceId, projectRoot, mode: "code" });
        return (yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }))
          .resumeCursor;
      }),
    ),
  );
  if (cursor === undefined) throw new Error("missing cursor");
  const restarted = fixture(vibe);
  const refused = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* restarted.driver.acquire({
          instanceId,
          projectRoot: "/another-project",
          mode: "code",
        });
        return yield* Effect.flip(
          connection.resume({ sessionId, resumeCursor: cursor, executionPolicy: "approval-gated" }),
        );
      }),
    ),
  );
  expect(refused.category).toBe("stale-resume");
  expect(restarted.starts).toEqual([]);
});

it("refuses a provider that replaces the native identity during resume", async () => {
  const { driver, client } = fixture(vibe);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* driver.acquire({ instanceId, projectRoot, mode: "code" });
        const handle = yield* connection.start({
          sessionId,
          modelId,
          executionPolicy: "approval-gated",
        });
        if (handle.resumeCursor === undefined) throw new Error("missing cursor");
        yield* connection.stop(sessionId);
        client.loadSession.mockResolvedValueOnce({
          sessionId: "replacement",
          configOptions: client.configOptions,
        });
        const refused = yield* Effect.flip(
          connection.resume({
            sessionId,
            resumeCursor: handle.resumeCursor,
            executionPolicy: "approval-gated",
          }),
        );
        expect(refused.category).toBe("stale-resume");
        expect(client.prompt).not.toHaveBeenCalled();
      }),
    ),
  );
});
