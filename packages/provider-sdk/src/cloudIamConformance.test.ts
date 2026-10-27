import { createHash } from "node:crypto";
import type { CloudIamRegion, CloudIamSigningScope } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  cloudIamFailure,
  cloudIamReadiness,
  readCloudIamCredential,
  resolveCloudIamSignature,
  withCloudIamSignature,
  type CloudIamAttempt,
  type CloudIamEndpoint,
  type CloudIamRequest,
} from "./cloudIam";
import {
  runCloudIamConformance,
  type CloudIamConformanceFixture,
  type CloudIamConformanceInput,
  type CloudIamConformanceSubject,
} from "./cloudIamConformance";

function scopeFor(region: CloudIamRegion): CloudIamSigningScope {
  return {
    partition: "aws",
    region,
    service: "bedrock",
    host: `bedrock-runtime.${String(region)}.amazonaws.com`,
    pathPrefix: "/model/",
    method: "POST",
  };
}

const BODY = JSON.stringify({ messages: [{ role: "user", content: [{ text: "Hello" }] }] });

/**
 * A cloud-signed endpoint's credential path written only against the seam: it
 * reads the stored pointer, asks for one signature per request with the
 * request's own fields, and maps what the endpoint answered.
 */
function referenceSubject(
  input: CloudIamConformanceInput,
  options: {
    readonly skipsConfigurationBinding?: boolean;
    readonly renewsRefusedCredentials?: boolean;
    readonly echoesSignatureInFailures?: boolean;
    readonly sendsAnotherBody?: boolean;
  } = {},
): CloudIamConformanceSubject {
  const credential =
    input.storedCredential === undefined
      ? undefined
      : readCloudIamCredential(input.storedCredential);
  const configured: CloudIamEndpoint = {
    source: input.configuration.cloudIam,
    scope: scopeFor(input.configuration.region),
  };
  // A faulty driver that trusts the pointer instead of its own configuration
  // signs for whatever account and region the pointer names.
  const endpoint =
    options.skipsConfigurationBinding === true && credential !== undefined
      ? { source: credential.source, scope: credential.scope }
      : configured;
  const request: CloudIamRequest = {
    method: "POST",
    host: endpoint.scope.host,
    path: "/model/fixture-model/converse",
    query: [],
    headers: { "content-type": "application/json" },
    payloadHash: createHash("sha256").update(BODY).digest("hex"),
  };
  let lastAuthorization = "";
  return {
    probe: async () => {
      const resolved = await resolveCloudIamSignature({
        credential,
        endpoint,
        host: input.host,
        request,
      });
      return {
        readiness: cloudIamReadiness(resolved),
        ...(resolved.kind === "unauthenticated" ? { reason: resolved.reason } : {}),
        capabilitiesClaimed: resolved.kind === "signature",
      };
    },
    send: async () => {
      const outcome = await withCloudIamSignature(
        { credential, endpoint, host: input.host, request },
        async (headers): Promise<CloudIamAttempt<unknown>> => {
          lastAuthorization = headers.authorization ?? "";
          const response = await input.fetch(new URL(`https://${request.host}${request.path}`), {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: options.sendsAnotherBody === true ? `${BODY} ` : BODY,
          });
          if (response.status === 403) {
            const type = response.headers.get("x-amzn-errortype") ?? "";
            return type.startsWith("AccessDeniedException") ||
              options.renewsRefusedCredentials === false
              ? { kind: "forbidden" }
              : { kind: "unauthorized" };
          }
          return { kind: "answered", value: await response.json() };
        },
      );
      if (outcome.kind === "answered") return;
      const failure = cloudIamFailure(outcome);
      throw options.echoesSignatureInFailures === true
        ? { ...failure, message: `${failure.message} (${lastAuthorization})` }
        : failure;
    },
  };
}

function fixture(options: Parameters<typeof referenceSubject>[1] = {}): CloudIamConformanceFixture {
  return {
    scopeFor,
    answer: () => Response.json({ output: { message: { content: [{ text: "Hello." }] } } }),
    makeSubject: (input) => referenceSubject(input, options),
  };
}

describe("cloud-iam conformance", () => {
  it("passes a driver that checks its configuration, signs each request through the host, and never reports a secret", async () => {
    const evidence = await runCloudIamConformance(fixture());
    expect(evidence.cases).toEqual([
      "valid grant and scope is ready after the probe and every request verifies at the endpoint",
      "no grant is unauthenticated without the broker or endpoint",
      "sign-in that ended or was withdrawn needs a new sign-in",
      "role the portal no longer gives is not-authorized and keeps the grant",
      "unreachable broker is unavailable",
      "pointer portal, account, role, or region differing from configuration is incompatible without the broker",
      "broker scope refusal is incompatible",
      "endpoint refusing the role's permission is not-authorized",
      "refused credentials renew once and resend once",
      "no report or failure carries a secret, token, or signature",
    ]);
  });

  it("fails a driver that binds to the pointer instead of its own configuration", async () => {
    await expect(
      runCloudIamConformance(fixture({ skipsConfigurationBinding: true })),
    ).rejects.toThrow(
      "pointer portal, account, role, or region differing from configuration is incompatible without the broker",
    );
  });

  it("fails a driver that sends a body other than the one it had signed", async () => {
    await expect(runCloudIamConformance(fixture({ sendsAnotherBody: true }))).rejects.toThrow(
      "valid grant and scope is ready after the probe and every request verifies at the endpoint",
    );
  });

  it("fails a driver that gives up on refused credentials instead of renewing once", async () => {
    await expect(
      runCloudIamConformance(fixture({ renewsRefusedCredentials: false })),
    ).rejects.toThrow("refused credentials renew once and resend once");
  });

  it("fails a driver whose failure message carries the signature", async () => {
    await expect(
      runCloudIamConformance(fixture({ echoesSignatureInFailures: true })),
    ).rejects.toThrow("carries a signature");
  });
});

describe("cloud-iam pointer", () => {
  it("reads only a pointer of exactly its own fields and closed scope", () => {
    const pointer = {
      kind: "cloud-iam",
      credentialRef: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
      source: {
        startUrl: "https://contoso.awsapps.com/start",
        ssoRegion: "us-east-1",
        accountId: "123456789012",
        roleName: "ModelInvoke",
      },
      scope: {
        partition: "aws",
        region: "us-west-2",
        service: "bedrock",
        host: "bedrock-runtime.us-west-2.amazonaws.com",
        pathPrefix: "/model/",
        method: "POST",
      },
    };
    expect(readCloudIamCredential(JSON.stringify(pointer))).toBeDefined();
    for (const flawed of [
      { ...pointer, accessKeyId: "ASIAEXAMPLE" },
      { ...pointer, scope: { ...pointer.scope, host: "sts.amazonaws.com" } },
      { ...pointer, scope: { ...pointer.scope, service: "sts" } },
      { ...pointer, scope: { ...pointer.scope, method: "GET" } },
      { ...pointer, source: { ...pointer.source, extra: "x" } },
      { ...pointer, source: { ...pointer.source, startUrl: "https://contoso.example/start" } },
      { ...pointer, kind: "directory-oauth" },
    ]) {
      expect(readCloudIamCredential(JSON.stringify(flawed))).toBeUndefined();
    }
    expect(readCloudIamCredential("sk-a-stored-api-key")).toBeUndefined();
  });

  it("refuses a request outside its scope and a signature of foreign headers without sending", async () => {
    const credential = readCloudIamCredential(
      JSON.stringify({
        kind: "cloud-iam",
        credentialRef: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
        source: {
          startUrl: "https://contoso.awsapps.com/start",
          ssoRegion: "us-east-1",
          accountId: "123456789012",
          roleName: "ModelInvoke",
        },
        scope: scopeFor("us-west-2" as CloudIamRegion),
      }),
    );
    if (credential === undefined) throw new Error("the pointer did not read");
    const endpoint = { source: credential.source, scope: credential.scope };
    let asked = 0;
    const host = {
      sign: async () => {
        asked += 1;
        return { kind: "signed" as const, headers: { authorization: "x", "x-api-key": "leak" } };
      },
    };
    const request: CloudIamRequest = {
      method: "POST",
      host: "bedrock-runtime.us-west-2.amazonaws.com",
      path: "/model/m/converse",
      query: [],
      headers: {},
      payloadHash: "0".repeat(64),
    };
    for (const outside of [
      { ...request, method: "GET" },
      { ...request, host: "bedrock.us-west-2.amazonaws.com" },
      { ...request, path: "/guardrail/g" },
    ]) {
      expect(
        await resolveCloudIamSignature({ credential, endpoint, host, request: outside }),
      ).toEqual({ kind: "incompatible" });
    }
    expect(asked).toBe(0);
    // An answer that is not exactly a signature is never sent.
    expect(await resolveCloudIamSignature({ credential, endpoint, host, request })).toEqual({
      kind: "unavailable",
    });
  });
});
