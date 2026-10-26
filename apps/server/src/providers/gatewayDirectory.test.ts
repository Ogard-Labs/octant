import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  decodeProviderToolDefinition,
  type DirectoryIssuerBinding,
  type ProviderFailure,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import {
  runDirectoryOAuthConformance,
  type DirectoryOAuthConformanceInput,
  type DirectoryOAuthConformanceSubject,
} from "@octant/provider-sdk/directory-oauth-conformance";
import type { HarnessEndpointDriver } from "@octant/provider-sdk/harness-endpoint";
import { runHarnessEndpointConformance } from "@octant/provider-sdk/harness-endpoint-conformance";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import { makeAnthropicCompatibleDriver } from "./anthropicCompatibleDriver";
import { chatStream } from "./foundryDirectory.test-support";
import {
  GATEWAY_CLIENT,
  GATEWAY_ISSUER,
  GATEWAY_MODEL,
  GATEWAY_ORIGIN,
  GATEWAY_POINTER,
  GatewayGrantBroker,
  anthropicGatewayConfiguration,
  gatewayEndpoint,
  messagesStream,
  openAiGatewayConfiguration,
} from "./gatewayDirectory.test-support";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000661");

function storedCredential(value: string | undefined) {
  return {
    has: async () => value !== undefined,
    resolve: async () => {
      // The credential store reports an absent value as an unauthenticated failure.
      if (value === undefined) {
        throw { category: "unauthenticated", message: "The provider credential is missing." };
      }
      return value;
    },
  };
}

type GatewayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The conformance runner's clock as a driver's, when the runner names one. */
function clockOf(now: (() => number) | undefined): { readonly clock?: () => string } {
  return now === undefined ? {} : { clock: () => new Date(now()).toISOString() };
}

/** Each gateway driver kind, built against a broker, a stored value, and a gateway. */
const gateways: ReadonlyArray<{
  readonly name: string;
  readonly baseUrl: string;
  readonly otherBaseUrl: string;
  /** Re-encodes the conformance runner's plain answer as this protocol's stream. */
  readonly stream: (text: string) => Response;
  readonly make: (input: {
    readonly baseUrl?: string;
    readonly directory?: DirectoryIssuerBinding;
    readonly runtimeRegistry: ProviderRuntimeRegistry;
    readonly storedCredential: string | undefined;
    readonly broker: DirectoryOAuthConformanceInput["host"] | undefined;
    readonly fetch: GatewayFetch;
    readonly now?: () => number;
  }) => HarnessEndpointDriver;
}> = [
  {
    name: "OpenAI-compatible",
    baseUrl: "https://llm.example.test/v1/",
    otherBaseUrl: "https://llm-staging.example.test/v1/",
    stream: chatStream,
    make: (input) =>
      makeOpenAiCompatibleDriver({
        instanceId,
        configuration: {
          ...openAiGatewayConfiguration(),
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          ...(input.directory === undefined ? {} : { directory: input.directory }),
        },
        runtimeRegistry: input.runtimeRegistry,
        credentialResolver: storedCredential(input.storedCredential),
        ...(input.broker === undefined ? {} : { directoryOAuth: input.broker }),
        fetch: input.fetch,
        ...clockOf(input.now),
      }),
  },
  {
    name: "Anthropic-compatible",
    baseUrl: "https://llm.example.test/anthropic/v1/",
    otherBaseUrl: "https://llm-staging.example.test/anthropic/v1/",
    stream: messagesStream,
    make: (input) =>
      makeAnthropicCompatibleDriver({
        instanceId,
        configuration: {
          ...anthropicGatewayConfiguration(),
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          ...(input.directory === undefined ? {} : { directory: input.directory }),
        },
        runtimeRegistry: input.runtimeRegistry,
        credentialResolver: storedCredential(input.storedCredential),
        ...(input.broker === undefined ? {} : { directoryOAuth: input.broker }),
        fetch: input.fetch,
        ...clockOf(input.now),
      }),
  },
];

describe.each(gateways)("$name gateway organization sign-in", (gateway) => {
  it("passes every directory sign-in conformance case against the organization's own issuer", async () => {
    const evidence = await runDirectoryOAuthConformance({
      signsInTo: "issuer",
      baseUrl: gateway.baseUrl,
      otherBaseUrl: gateway.otherBaseUrl,
      makeSubject: (input): DirectoryOAuthConformanceSubject => {
        const configured = input.configuration;
        if (!("issuer" in configured)) throw new Error("expected an issuer configuration");
        const runtimeRegistry = new ProviderRuntimeRegistry();
        // The runner's endpoint answers a generation with a plain completion;
        // the gateway transport reads a stream, so a 200 is re-encoded as one.
        const fetch: GatewayFetch = async (url, init) => {
          const answered = await input.fetch(new URL(String(url)), init ?? {});
          if (init?.method !== "POST" || !answered.ok) return answered;
          const body = (await answered.json()) as {
            readonly choices: ReadonlyArray<{ readonly message: { readonly content: string } }>;
          };
          return gateway.stream(body.choices[0]?.message.content ?? "");
        };
        const driver = gateway.make({
          baseUrl: configured.baseUrl,
          directory: {
            issuer: configured.issuer,
            clientId: configured.clientId,
            scope: configured.scope,
          },
          runtimeRegistry,
          storedCredential: input.storedCredential,
          broker: input.host,
          fetch,
          now: input.now,
        });
        return {
          probe: async () => {
            const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
            if (observed.readiness === "degraded" || observed.readiness === "checking") {
              throw new Error(`the probe read ${observed.readiness}`);
            }
            return {
              readiness: observed.readiness,
              ...(observed.unauthenticatedReason === undefined
                ? {}
                : { reason: observed.unauthenticatedReason }),
              capabilitiesClaimed: observed.models.length > 0,
              ...(observed.message === undefined ? {} : { message: observed.message }),
            };
          },
          send: async () => {
            const session = await driver.harnessEndpoint.open(GATEWAY_MODEL);
            try {
              await session.send(
                {
                  sessionId: decodeProviderSessionId("80000000-0000-4000-8000-000000000662"),
                  modelId: GATEWAY_MODEL,
                  system: undefined,
                  history: [{ role: "user", text: "Hello." }],
                  tools: [],
                },
                { signal: new AbortController().signal, onEvent: () => undefined },
              );
            } finally {
              session.release();
            }
          },
        };
      },
    });

    expect(evidence.cases).toEqual([
      "valid grant and binding is ready after the probe",
      "no grant is unauthenticated without the broker or endpoint",
      "near-expiry refresh happens once under concurrent requests",
      "refresh refused as expired, revoked, or reused needs a new sign-in",
      "refresh that needs the person present keeps the grant",
      "unreachable broker or directory, or a 5xx, is unavailable and keeps the grant",
      "pointer issuer, client, or scope differing from configuration is incompatible without the broker",
      "base URL off the grant's origin is incompatible without the broker",
      "broker binding refusal is incompatible",
      "missing role assignment is not-authorized",
      "401 after a usable token refreshes once and resends once",
      "no report or failure carries a token",
    ]);
  });

  it("keeps the harness endpoint promises the host's loop relies on while signed in", async () => {
    const broker = new GatewayGrantBroker();
    const answer = gatewayEndpoint(broker);
    const endpoint = gateway.make({
      runtimeRegistry: new ProviderRuntimeRegistry(),
      storedCredential: GATEWAY_POINTER,
      broker,
      fetch: async (url, init) =>
        init?.signal?.aborted === true
          ? Promise.reject(new DOMException("The request was aborted.", "AbortError"))
          : answer(url, init),
    }).harnessEndpoint;
    const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000663");

    await expect(
      runHarnessEndpointConformance({
        endpoint,
        modelId: GATEWAY_MODEL,
        request: {
          sessionId,
          modelId: GATEWAY_MODEL,
          system: undefined,
          history: [{ role: "user", text: "successful fixture prompt" }],
          tools: [],
        },
        unverifiedToolTurn: {
          sessionId,
          prompt: "Read the file",
          attachments: [],
          tools: [
            decodeProviderToolDefinition({
              name: "read_file",
              inputSchema: { type: "object", properties: {} },
            }),
          ],
        },
      }),
    ).resolves.toMatchObject({ cancelledRequestInterrupted: true, releasedSessionRefused: true });
  });

  it("runs a Chat, Work, and Code turn with a bearer resolved for each request and no key", async () => {
    for (const mode of ["chat", "work", "code"] as const) {
      const broker = new GatewayGrantBroker();
      const fetch = gatewayEndpoint(broker, { reply: `Answered in ${mode}.` });
      const runtimeRegistry = new ProviderRuntimeRegistry();
      const driver = gateway.make({
        runtimeRegistry,
        storedCredential: GATEWAY_POINTER,
        broker,
        fetch,
      });
      const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
      expect(observed, mode).toMatchObject({
        readiness: "ready",
        credentialStatus: "stored",
        directoryBinding: {
          issuer: GATEWAY_ISSUER,
          clientId: GATEWAY_CLIENT,
          endpointOrigin: GATEWAY_ORIGIN,
        },
      });

      const events = await runTurn(
        runOnNativeHarness(driver, { instanceId, runtimeRegistry }),
        mode,
      );

      expect(events.at(-1)?.kind, mode).toBe("completed");
      expect(
        events.flatMap((event) => (event.kind === "text-delta" ? [event.text] : [])).join(""),
        mode,
      ).toBe(`Answered in ${mode}.`);
      expect(fetch.authorizations.length, mode).toBeGreaterThanOrEqual(2);
      expect(fetch.authorizations.every((value) => value === `Bearer ${broker.current()}`)).toBe(
        true,
      );
    }
  });

  it("reads a 403 from the gateway as an account without access, without renewing the token", async () => {
    const broker = new GatewayGrantBroker();
    const fetch = gatewayEndpoint(broker, {
      refuse: () =>
        Response.json(
          { error: { code: "PermissionDenied", message: broker.current() } },
          { status: 403 },
        ),
    });
    const driver = gateway.make({
      runtimeRegistry: new ProviderRuntimeRegistry(),
      storedCredential: GATEWAY_POINTER,
      broker,
      fetch,
    });

    const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(observed).toMatchObject({
      readiness: "unauthenticated",
      unauthenticatedReason: "not-authorized",
      credentialStatus: "stored",
      models: [],
    });
    expect(JSON.stringify(observed)).not.toContain(broker.current());
    expect(broker.refreshes).toBe(0);
  });

  it("reads a gateway sign-in with no reachable broker as unavailable, sending nothing", async () => {
    const fetch = vi.fn<GatewayFetch>(async () => Response.json({ data: [] }));
    const driver = gateway.make({
      runtimeRegistry: new ProviderRuntimeRegistry(),
      storedCredential: GATEWAY_POINTER,
      broker: undefined,
      fetch,
    });

    const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(observed).toMatchObject({ readiness: "unavailable", credentialStatus: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends a stored API key in place of the organization sign-in", async () => {
    const fetch = vi.fn<GatewayFetch>(async () => Response.json({ data: [] }));
    const driver = gateway.make({
      runtimeRegistry: new ProviderRuntimeRegistry(),
      storedCredential: "sk-left-from-an-earlier-key",
      broker: new GatewayGrantBroker(),
      fetch,
    });

    const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(observed).toMatchObject({
      readiness: "unauthenticated",
      unauthenticatedReason: "missing",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Anthropic-compatible key instance", () => {
  it("never sends an organization sign-in's pointer left in the store as an API key", async () => {
    const fetch = vi.fn<GatewayFetch>(async () => Response.json({ data: [] }));
    const { directory: _directory, ...keyed } = anthropicGatewayConfiguration();
    const driver = makeAnthropicCompatibleDriver({
      instanceId,
      configuration: { ...keyed, authentication: "api-key" },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: storedCredential(GATEWAY_POINTER),
      fetch,
    });

    const exit = await Effect.runPromiseExit(Effect.scoped(driver.probe({ instanceId })));

    expect(failureOf(exit)).toMatchObject({ category: "unauthenticated" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function runTurn(
  driver: ReturnType<typeof runOnNativeHarness>,
  mode: "chat" | "work" | "code",
): Promise<ProviderRuntimeEvent[]> {
  const session = decodeProviderSessionId("80000000-0000-4000-8000-000000000664");
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp", mode });
        yield* connection.start({
          sessionId: session,
          modelId: GATEWAY_MODEL,
          executionPolicy: "approval-gated",
        });
        const collector = yield* Effect.fork(
          (yield* connection.subscribe).pipe(
            Stream.filter((event) => event.sessionId === session),
            Stream.takeUntil(
              (event) =>
                event.kind === "completed" ||
                event.kind === "interrupted" ||
                event.kind === "failed",
            ),
            Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          ),
        );
        yield* connection.send({
          sessionId: session,
          prompt: `A ${mode} question.`,
          attachments: [],
          tools: [],
        });
        yield* collector.await;
      }),
    ),
  );
  return events;
}

function failureOf(exit: Exit.Exit<unknown, ProviderFailure>): ProviderFailure | undefined {
  return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;
}
