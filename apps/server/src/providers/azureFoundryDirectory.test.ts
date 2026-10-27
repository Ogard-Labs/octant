import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  decodeProviderToolDefinition,
  type ProviderFailure,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { AZURE_FOUNDRY_DIRECTORY_SIGN_IN } from "@octant/domain";
import { runDirectoryOAuthConformance } from "@octant/provider-sdk/directory-oauth-conformance";
import { runHarnessEndpointConformance } from "@octant/provider-sdk/harness-endpoint-conformance";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import { makeAzureFoundryDriver } from "./azureFoundryDriver";
import {
  FOUNDRY_CLIENT,
  FOUNDRY_DEPLOYMENT,
  FOUNDRY_POINTER,
  FOUNDRY_TENANT,
  FoundryGrantBroker,
  chatStream,
  foundryDirectoryConfiguration,
  foundryEndpoint,
} from "./foundryDirectory.test-support";
import type { CompatibleFetch } from "./openAiCompatibleEndpoint";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000651");

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

describe("Azure AI Foundry organization sign-in", () => {
  it("passes every directory sign-in conformance case through the Foundry driver", async () => {
    const evidence = await runDirectoryOAuthConformance({
      signsInTo: "tenant",
      audience: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.audience,
      baseUrl: "https://fixture.openai.azure.com/openai/v1/",
      otherBaseUrl: "https://other.services.ai.azure.com/openai/v1/",
      makeSubject: (input) => {
        const configured = input.configuration;
        if (!("tenantId" in configured)) throw new Error("expected a tenant configuration");
        const runtimeRegistry = new ProviderRuntimeRegistry();
        // The runner's endpoint answers a generation with a plain completion;
        // the Foundry transport reads a stream, so a 200 is re-encoded as one.
        const fetch: CompatibleFetch = async (url, init) => {
          const answered = await input.fetch(new URL(String(url)), init ?? {});
          if (init?.method !== "POST" || !answered.ok) return answered;
          const body = (await answered.json()) as {
            readonly choices: ReadonlyArray<{ readonly message: { readonly content: string } }>;
          };
          return chatStream(body.choices[0]?.message.content ?? "");
        };
        const driver = makeAzureFoundryDriver({
          instanceId,
          configuration: {
            ...foundryDirectoryConfiguration(),
            baseUrl: configured.baseUrl,
            directory: { tenantId: configured.tenantId, clientId: configured.clientId },
          },
          runtimeRegistry,
          credentialResolver: storedCredential(input.storedCredential),
          directoryOAuth: input.host,
          fetch,
          clock: () => new Date(input.now()).toISOString(),
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
            const session = await driver.harnessEndpoint.open(FOUNDRY_DEPLOYMENT);
            try {
              await session.send(
                {
                  sessionId: decodeProviderSessionId("80000000-0000-4000-8000-000000000652"),
                  modelId: FOUNDRY_DEPLOYMENT,
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

    expect(evidence.cases).toHaveLength(12);
  });

  it("keeps the harness endpoint promises the host's loop relies on while signed in", async () => {
    const broker = new FoundryGrantBroker();
    const answer = foundryEndpoint(broker);
    const endpoint = makeAzureFoundryDriver({
      instanceId,
      configuration: foundryDirectoryConfiguration(),
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: storedCredential(FOUNDRY_POINTER),
      directoryOAuth: broker,
      fetch: async (url, init) =>
        init?.signal?.aborted === true
          ? Promise.reject(new DOMException("The request was aborted.", "AbortError"))
          : answer(url, init),
    }).harnessEndpoint;
    const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000654");

    await expect(
      runHarnessEndpointConformance({
        endpoint,
        modelId: FOUNDRY_DEPLOYMENT,
        request: {
          sessionId,
          modelId: FOUNDRY_DEPLOYMENT,
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
      const broker = new FoundryGrantBroker();
      const fetch = foundryEndpoint(broker, { reply: `Answered in ${mode}.` });
      const runtimeRegistry = new ProviderRuntimeRegistry();
      const endpoint = makeAzureFoundryDriver({
        instanceId,
        configuration: foundryDirectoryConfiguration(),
        runtimeRegistry,
        credentialResolver: storedCredential(FOUNDRY_POINTER),
        directoryOAuth: broker,
        fetch,
      });
      const observed = await Effect.runPromise(Effect.scoped(endpoint.probe({ instanceId })));
      expect(observed, mode).toMatchObject({
        readiness: "ready",
        directoryBinding: {
          tenantId: FOUNDRY_TENANT,
          clientId: FOUNDRY_CLIENT,
          endpointOrigin: "https://contoso.openai.azure.com",
        },
      });

      const events = await runTurn(
        runOnNativeHarness(endpoint, { instanceId, runtimeRegistry }),
        mode,
        "80000000-0000-4000-8000-000000000653",
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

  it("reads a token the endpoint attributes to another tenant as incompatible, without renewing it", async () => {
    const broker = new FoundryGrantBroker();
    const fetch = foundryEndpoint(broker, {
      refuse: () =>
        Response.json(
          {
            error: {
              code: "InvalidAuthenticationTokenTenant",
              message: `The access token is from the wrong issuer ${broker.current()}`,
            },
          },
          { status: 401 },
        ),
    });
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: foundryDirectoryConfiguration(),
      runtimeRegistry,
      credentialResolver: storedCredential(FOUNDRY_POINTER),
      directoryOAuth: broker,
      fetch,
    });

    const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(observed).toMatchObject({ readiness: "incompatible", models: [] });
    expect(observed.message).toBe(
      "This endpoint's organization sign-in does not match its directory, client, or address. Sign in again for this endpoint.",
    );
    expect(JSON.stringify(observed)).not.toContain(broker.current());
    expect(broker.refreshes).toBe(0);
    expect(fetch.authorizations).toHaveLength(1);
  });

  it("reads a 401 that names a missing role as not authorized, without renewing the token", async () => {
    const broker = new FoundryGrantBroker();
    const fetch = foundryEndpoint(broker, {
      refuse: () =>
        Response.json(
          { error: { code: "PermissionDenied", message: "Principal does not have access." } },
          { status: 401 },
        ),
    });
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: foundryDirectoryConfiguration(),
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: storedCredential(FOUNDRY_POINTER),
      directoryOAuth: broker,
      fetch,
    });

    const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(observed).toMatchObject({
      readiness: "unauthenticated",
      unauthenticatedReason: "not-authorized",
      credentialStatus: "stored",
    });
    expect(broker.refreshes).toBe(0);
  });

  it("never sends a directory pointer left in the store as an API key", async () => {
    const fetch = vi.fn<CompatibleFetch>(async () => Response.json({ data: [] }));
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://contoso.openai.azure.com/openai/v1/",
        authentication: "api-key",
        protocol: "chat-completions",
        manualModelIds: [FOUNDRY_DEPLOYMENT],
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: storedCredential(FOUNDRY_POINTER),
      fetch,
    });

    const exit = await Effect.runPromiseExit(Effect.scoped(driver.probe({ instanceId })));

    expect(failureOf(exit)).toMatchObject({ category: "unauthenticated" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a directory instance with no reachable broker as unavailable, sending nothing", async () => {
    const fetch = vi.fn<CompatibleFetch>(async () => Response.json({ data: [] }));
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: foundryDirectoryConfiguration(),
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: storedCredential(FOUNDRY_POINTER),
      fetch,
    });

    const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(observed).toMatchObject({ readiness: "unavailable", credentialStatus: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function runTurn(
  driver: ReturnType<typeof runOnNativeHarness>,
  mode: "chat" | "work" | "code",
  sessionId: string,
): Promise<ProviderRuntimeEvent[]> {
  const session = decodeProviderSessionId(sessionId);
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp", mode });
        yield* connection.start({
          sessionId: session,
          modelId: FOUNDRY_DEPLOYMENT,
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
