import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeAcpDriver, type AcpClientPort, type AcpDriverOptions } from "./acpDriver";
import type { AcpConnection, AcpProcessPort } from "./acpProcess";
import { acpProviderProfiles, type AcpProviderKind, type AcpProviderProfile } from "./acpProfiles";
import { AcpFailure, type AcpNewSessionResult } from "./acpProtocol";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

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
      toolCall: { toolCallId, title: "Write", kind: "edit" },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
  };
}

function fixture(
  profile: AcpProviderProfile,
  overrides: Partial<Pick<AcpDriverOptions, "authentication">> = {},
) {
  const client = new FakeClient(profile);
  const starts: Array<Record<string, unknown>> = [];
  let active = 0;
  let released = 0;
  const connection = {
    version: "7.4.11",
    pid: 311,
    root: managedHome,
    initialized: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {} },
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
    released: () => released,
  };
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
  it("probes through the managed home and discovers models without a prompt", async () => {
    const { driver, client, registry, active, released } = fixture(profile);
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
      },
    });
    expect(client.newSession).toHaveBeenCalledOnce();
    expect(client.newSession).toHaveBeenCalledWith(managedHome);
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
      message: profile.unauthenticatedMessage,
    });
    expect(failure.message).toContain(profile.displayName);
    expect(active()).toBe(0);
    expect(released()).toBe(1);
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

  it.each([
    ["code", "approval-gated"],
    ["code", "plan"],
    ["code", "full-access"],
    ["chat", "approval-gated"],
  ] as const)(
    "launches %s %s in the profile root and applies the profile ACP mode",
    async (productMode, executionPolicy) => {
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
          });
          const collected = yield* Effect.fork(
            Effect.promise(() => collectTerminal(connection.events)),
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

  it("correlates approvals and denies approvals in plan mode", async () => {
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
  });

  it("absorbs transport failure and keeps sequence contiguous for auto-rejected Plan side effects", async () => {
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
          const collected = yield* Effect.fork(
            Effect.promise(() => collectTerminal(connection.events)),
          );
          yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
          const events = yield* Fiber.join(collected);
          expect(events.map((event) => event.sequence)).toEqual([1, 2]);
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

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
    [vibe, "code", "approval-gated", "default"],
    [vibe, "code", "plan", "plan"],
    [vibe, "code", "full-access", "auto-approve"],
    [vibe, "chat", "full-access", "chat"],
    [kimi, "code", "approval-gated", "default"],
    [kimi, "code", "plan", "plan"],
    [kimi, "code", "full-access", "yolo"],
    [kilo, "code", "full-access", "octant"],
    [kilo, "chat", "approval-gated", "octant"],
  ] as const)(
    "maps $0.displayName %s %s only to the approved ACP mode %s",
    (profile, mode, policy, expected) => {
      expect(profile.sessionMode(mode, policy)).toBe(expected);
    },
  );

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
          const collected = yield* Effect.fork(
            Effect.promise(() => collectTerminal(connection.events)),
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

  it("delegates Mistral Vibe subscription browser authentication without returning credentials", async () => {
    const { driver, client, starts } = fixture(vibe, { authentication: "subscription" });
    if (driver.beginAuthentication === undefined || driver.completeAuthentication === undefined) {
      throw new Error("Missing provider authentication operations.");
    }
    const attempt = await Effect.runPromise(
      Effect.scoped(driver.beginAuthentication({ instanceId })),
    );
    expect(attempt).toEqual({
      attemptId: "provider-attempt-1",
      signInUrl: "https://auth.mistral.example/attempt",
      expiresAt: "2026-07-17T11:00:00.123Z",
    });
    await Effect.runPromise(
      Effect.scoped(driver.completeAuthentication({ instanceId, attemptId: attempt.attemptId })),
    );
    expect(client.startBrowserAuthentication).toHaveBeenCalledOnce();
    expect(client.completeBrowserAuthentication).toHaveBeenCalledWith("provider-attempt-1");
    expect(starts).toHaveLength(2);
    expect(JSON.stringify(attempt)).not.toMatch(/token|key|credential/i);
  });

  it("rejects delegated browser authentication for API-key instances", async () => {
    const { driver } = fixture(vibe, { authentication: "api-key" });
    if (driver.beginAuthentication === undefined) {
      throw new Error("Missing provider authentication operation.");
    }
    const failure = await Effect.runPromise(
      Effect.scoped(Effect.flip(driver.beginAuthentication({ instanceId }))),
    );
    expect(failure.category).toBe("unsupported");
  });

  it("does not offer browser authentication for provider-owned profiles", () => {
    for (const kind of ["kilo", "devin", "kimi-code"] as const satisfies AcpProviderKind[]) {
      const { driver } = fixture(acpProviderProfiles[kind]);
      expect(driver.beginAuthentication).toBeUndefined();
      expect(driver.completeAuthentication).toBeUndefined();
    }
  });
});
