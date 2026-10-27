import {
  decodeCloudAccountId,
  decodeCloudIamRegion,
  decodeCloudIamStartUrl,
  decodeCloudRoleName,
  decodeProviderFailure,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  decodeProviderToolDefinition,
  type AmazonBedrockProviderConfiguration,
  type ProviderFailure,
} from "@octant/contracts";
import { amazonBedrockSigningScope } from "@octant/domain";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import {
  encodeCloudIamCredential,
  type CloudIamHost,
  type CloudIamRequest,
} from "@octant/provider-sdk/cloud-iam";
import { runCloudIamConformance } from "@octant/provider-sdk/cloud-iam-conformance";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runHarnessEndpointConformance } from "@octant/provider-sdk/harness-endpoint-conformance";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import { makeAmazonBedrockDriver } from "./amazonBedrockDriver";
import type { BedrockFetch } from "./bedrockConverse";
import { converseStreamResponse, textReply } from "./bedrockConverse.test-support";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000a21");
const interruptedSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000a22");
const successfulSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000a24");
const modelId = decodeProviderModelId("anthropic.claude-sonnet-4-20250514-v1:0");
const credentialRef = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

const configuration: AmazonBedrockProviderConfiguration = {
  kind: "amazon-bedrock-converse-http",
  region: decodeCloudIamRegion("us-west-2"),
  authentication: "cloud-iam",
  cloudIam: {
    startUrl: decodeCloudIamStartUrl("https://contoso.awsapps.com/start"),
    ssoRegion: decodeCloudIamRegion("us-east-1"),
    accountId: decodeCloudAccountId("123456789012"),
    roleName: decodeCloudRoleName("BedrockInvoke"),
  },
  manualModelIds: [modelId],
};

const pointer = encodeCloudIamCredential({
  kind: "cloud-iam",
  credentialRef,
  source: configuration.cloudIam,
  scope: amazonBedrockSigningScope(configuration.region),
});

const storedPointer = { has: async () => true, resolve: async () => pointer };

/** A signer that answers every request in scope with fixture headers, and counts them. */
function signer(): CloudIamHost & { readonly signed: CloudIamRequest[] } {
  const signed: CloudIamRequest[] = [];
  return {
    signed,
    sign: async (_credentialRef, request) => {
      signed.push(request);
      return {
        kind: "signed",
        headers: {
          authorization: `AWS4-HMAC-SHA256 Credential=ASIAFIXTURE/20261027/us-west-2/bedrock/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=${"0".repeat(64)}`,
          "x-amz-date": "20261027T090000Z",
          "x-amz-security-token": "fixture-session-token",
        },
      };
    },
  };
}

function hangingResponse(signal: AbortSignal | null | undefined): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(new Error("private abort")));
      },
    }),
    { headers: { "content-type": "application/vnd.amazon.eventstream" } },
  );
}

describe("Amazon Bedrock provider conformance", () => {
  it("passes successful, cancellation, and cleanup conformance on the harness with a signature per request", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    let released = false;
    let completed = 0;
    const host = signer();
    const fetch: BedrockFetch = async (_url, init) => {
      completed += 1;
      if (completed === 2) return hangingResponse(init.signal);
      return converseStreamResponse(textReply("Hello from Bedrock."));
    };
    const driver = runOnNativeHarness(
      makeAmazonBedrockDriver({
        instanceId,
        configuration,
        runtimeRegistry,
        credentialResolver: storedPointer,
        cloudIam: host,
        fetch,
        clock: () => "2026-10-27T09:00:00.000Z",
      }),
      {
        instanceId,
        runtimeRegistry,
        onConnectionReleased: () => {
          released = true;
        },
        clock: () => "2026-10-27T09:00:00.000Z",
        correlationId: () => "80000000-0000-4000-8000-000000000a23",
      },
    );
    expect(driver.kind).toBe("amazon-bedrock");

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-bedrock-conformance", mode: "chat" },
      successfulTurn: {
        sessionStart: {
          sessionId: successfulSessionId,
          modelId,
          executionPolicy: "approval-gated",
        },
        turn: {
          sessionId: successfulSessionId,
          prompt: "successful fixture prompt",
          attachments: [],
          tools: [],
        },
        expectedEventKinds: ["text-delta", "text-delta", "usage", "completed"],
        expectedStreaming: "supported",
        observed: () => runtimeRegistry.observedState(instanceId),
      },
      sessionStart: { sessionId: interruptedSessionId, modelId, executionPolicy: "approval-gated" },
      turn: {
        sessionId: interruptedSessionId,
        prompt: "interrupt fixture prompt",
        attachments: [],
        tools: [],
      },
      resume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "amazon-bedrock", value: interruptedSessionId },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "amazon-bedrock", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: { sessionId: interruptedSessionId, requestId: "unknown", approved: false },
      unknownUserInput: { sessionId: interruptedSessionId, requestId: "unknown", answer: "none" },
      expectedEventKinds: ["interrupted"],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "unsupported",
        unknownUserInput: "unsupported",
      },
      isReleased: () => released,
    });
    const chatEvidence = await runProviderChatConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-bedrock-conformance", mode: "chat" },
      sessionStart: { sessionId: successfulSessionId, modelId, executionPolicy: "approval-gated" },
      turn: {
        sessionId: successfulSessionId,
        prompt: "hello",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "diagram.png",
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
        tools: [],
      },
      isReleased: () => released,
    });
    recordProviderConformanceEvidence("amazon-bedrock", evidence);
    recordProviderChatConformanceEvidence("amazon-bedrock", chatEvidence);

    expect(evidence).toMatchObject({
      capabilityHonest: true,
      usageCapabilityHonest: true,
      streamedInOrder: true,
      interrupted: true,
      released: true,
    });
    expect(chatEvidence).toMatchObject({ nativeAttachmentHonest: true, released: true });
    expect(runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    // Every model request went out signed by the broker for exactly its own
    // fields, on the region's own host.
    expect(host.signed.length).toBeGreaterThan(1);
    for (const request of host.signed) {
      expect(request).toMatchObject({
        method: "POST",
        host: "bedrock-runtime.us-west-2.amazonaws.com",
        path: "/model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse-stream",
      });
    }
  });

  it("keeps the harness endpoint promises the host's loop relies on", async () => {
    const endpoint = makeAmazonBedrockDriver({
      instanceId,
      configuration,
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: storedPointer,
      cloudIam: signer(),
      fetch: async () => converseStreamResponse(textReply("Hello.")),
    }).harnessEndpoint;

    await expect(
      runHarnessEndpointConformance({
        endpoint,
        modelId,
        request: {
          sessionId: successfulSessionId,
          modelId,
          system: undefined,
          history: [{ role: "user", text: "successful fixture prompt" }],
          tools: [],
        },
        unverifiedToolTurn: {
          sessionId: successfulSessionId,
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

  it("passes every driver-facing cloud-iam conformance case", async () => {
    const evidence = await runCloudIamConformance({
      scopeFor: (region) => amazonBedrockSigningScope(region),
      answer: () => converseStreamResponse(textReply("Hello from Bedrock.")),
      makeSubject: (input) => {
        const runtimeRegistry = new ProviderRuntimeRegistry();
        const driver = makeAmazonBedrockDriver({
          instanceId,
          configuration: {
            ...configuration,
            region: input.configuration.region,
            cloudIam: input.configuration.cloudIam,
          },
          runtimeRegistry,
          credentialResolver: {
            has: async () => input.storedCredential !== undefined,
            resolve: async () => {
              if (input.storedCredential === undefined) {
                throw { category: "unauthenticated", message: "missing" };
              }
              return input.storedCredential;
            },
          },
          cloudIam: input.host,
          fetch: (url, init) => input.fetch(new URL(url), init),
        });
        return {
          probe: async () => {
            const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
            return {
              readiness:
                observed.readiness === "ready" ||
                observed.readiness === "unauthenticated" ||
                observed.readiness === "unavailable" ||
                observed.readiness === "incompatible"
                  ? observed.readiness
                  : "unavailable",
              ...(observed.unauthenticatedReason === "missing" ||
              observed.unauthenticatedReason === "expired" ||
              observed.unauthenticatedReason === "revoked" ||
              observed.unauthenticatedReason === "not-authorized"
                ? { reason: observed.unauthenticatedReason }
                : {}),
              capabilitiesClaimed: observed.models.length > 0,
              ...(observed.message === undefined ? {} : { message: observed.message }),
            };
          },
          send: async () => {
            const session = await driver.harnessEndpoint.open(modelId);
            try {
              await session.send(
                {
                  sessionId: successfulSessionId,
                  modelId,
                  system: undefined,
                  history: [{ role: "user", text: "Hello" }],
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
    expect(evidence.cases).toHaveLength(10);
  });
});

describe("Amazon Bedrock cloud signing", () => {
  async function sendFailure(
    options: Omit<Partial<Parameters<typeof makeAmazonBedrockDriver>[0]>, "cloudIam"> & {
      readonly cloudIam?: CloudIamHost | "none";
    },
  ): Promise<ProviderFailure | undefined> {
    const { cloudIam = signer(), ...rest } = options;
    const driver = makeAmazonBedrockDriver({
      instanceId,
      configuration,
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: storedPointer,
      fetch: async () => converseStreamResponse(textReply("Hello.")),
      ...rest,
      ...(cloudIam === "none" ? {} : { cloudIam }),
    });
    try {
      const session = await driver.harnessEndpoint.open(modelId);
      await session.send(
        {
          sessionId: successfulSessionId,
          modelId,
          system: undefined,
          history: [{ role: "user", text: "Hello" }],
          tools: [],
        },
        { signal: new AbortController().signal, onEvent: () => undefined },
      );
      return undefined;
    } catch (error) {
      return decodeProviderFailure(error);
    }
  }

  it("never sends a stored key or another kind's pointer, and reads no broker as unavailable", async () => {
    let sent = 0;
    const fetch: BedrockFetch = async () => {
      sent += 1;
      return converseStreamResponse(textReply("never"));
    };
    for (const stored of ["AKIAFIXTUREKEY", JSON.stringify({ kind: "directory-oauth" })]) {
      expect(
        await sendFailure({
          credentialResolver: { has: async () => true, resolve: async () => stored },
          fetch,
        }),
      ).toMatchObject({ category: "unauthenticated" });
    }
    expect(await sendFailure({ cloudIam: "none", fetch })).toMatchObject({
      category: "unavailable",
    });
    expect(sent).toBe(0);
  });

  it("reads a missing permission as no access without renewing, and renews refused credentials once", async () => {
    const host = signer();
    let renewals = 0;
    const counting: CloudIamHost = {
      sign: async (ref, request, options) => {
        if (options.renewCredentials) renewals += 1;
        return host.sign(ref, request, options);
      },
    };
    const denied = await sendFailure({
      cloudIam: counting,
      fetch: async () =>
        Response.json(
          { message: "You don't have access to the model with the specified model ID." },
          { status: 403, headers: { "x-amzn-errortype": "AccessDeniedException:http://x" } },
        ),
    });
    expect(denied).toMatchObject({ category: "unauthenticated" });
    expect(denied?.message).toContain("no access");
    expect(renewals).toBe(0);

    let attempts = 0;
    const renewed = await sendFailure({
      cloudIam: counting,
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? Response.json(
              { message: "The security token included in the request is expired" },
              { status: 403, headers: { "x-amzn-errortype": "ExpiredTokenException" } },
            )
          : converseStreamResponse(textReply("Hello again."));
      },
    });
    expect(renewed).toBeUndefined();
    expect(renewals).toBe(1);
  });

  it("probes by asking for a signature and sends nothing to Bedrock", async () => {
    let sent = 0;
    const host = signer();
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const observed = await Effect.runPromise(
      Effect.scoped(
        makeAmazonBedrockDriver({
          instanceId,
          configuration,
          runtimeRegistry,
          credentialResolver: storedPointer,
          cloudIam: host,
          fetch: async () => {
            sent += 1;
            return converseStreamResponse(textReply("never"));
          },
        }).probe({ instanceId }),
      ),
    );
    expect(observed).toMatchObject({ readiness: "ready", credentialStatus: "stored" });
    expect(observed.models.map((model) => model.id)).toEqual([modelId]);
    // The transport sends no attachments, so no model reads as taking images.
    expect(observed.models[0]?.inputModalities).toEqual(["text"]);
    expect(host.signed).toHaveLength(1);
    expect(sent).toBe(0);
  });
});
