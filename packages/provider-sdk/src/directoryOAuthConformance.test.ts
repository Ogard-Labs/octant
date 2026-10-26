import { describe, expect, it } from "vitest";
import {
  directoryOAuthFailure,
  directoryOAuthReadiness,
  readDirectoryOAuthCredential,
  withDirectoryOAuthBearer,
  type DirectoryOAuthAttempt,
  type DirectoryOAuthCredential,
  type DirectoryOAuthEndpoint,
} from "./directoryOAuth";
import {
  runDirectoryOAuthConformance,
  type DirectoryOAuthConformanceFixture,
  type DirectoryOAuthConformanceInput,
  type DirectoryOAuthConformanceSubject,
} from "./directoryOAuthConformance";

const AUDIENCE = "https://models.example.test";
const HOST_SUFFIXES = [".models.example.test"] as const;

/** The instance's own view of its endpoint, as a driver of either kind builds it. */
function endpointOf(
  configuration: DirectoryOAuthConformanceInput["configuration"],
): DirectoryOAuthEndpoint {
  return "tenantId" in configuration
    ? {
        tenantId: configuration.tenantId,
        clientId: configuration.clientId,
        audience: AUDIENCE,
        baseUrl: configuration.baseUrl,
        hostSuffixes: HOST_SUFFIXES,
      }
    : {
        issuer: configuration.issuer,
        clientId: configuration.clientId,
        scope: configuration.scope,
        baseUrl: configuration.baseUrl,
      };
}

/**
 * A direct endpoint's credential path written only against the seam: it reads
 * the stored pointer, resolves one bearer per request, and maps what the
 * endpoint answered.
 */
function referenceSubject(
  input: DirectoryOAuthConformanceInput,
  options: {
    readonly skipsConfigurationBinding?: boolean;
    readonly echoesBearerInFailures?: boolean;
    readonly retriesUnauthorized?: boolean;
  } = {},
): DirectoryOAuthConformanceSubject {
  const credential =
    input.storedCredential === undefined
      ? undefined
      : readDirectoryOAuthCredential(input.storedCredential);
  const endpoint = endpointOf(input.configuration);
  let lastBearer = "";
  const call = (path: string, init: RequestInit) =>
    withDirectoryOAuthBearer(
      {
        // A faulty driver that trusts the pointer instead of its own
        // configuration binds to whatever tenant the pointer names.
        credential,
        endpoint:
          options.skipsConfigurationBinding === true && credential !== undefined
            ? trustingPointer(endpoint, credential)
            : endpoint,
        host: input.host,
        now: input.now,
      },
      async (bearer): Promise<DirectoryOAuthAttempt<unknown>> => {
        lastBearer = bearer;
        const response = await input.fetch(new URL(path, input.configuration.baseUrl), {
          ...init,
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        });
        if (response.status === 401) {
          return options.retriesUnauthorized === false
            ? { kind: "forbidden" }
            : { kind: "unauthorized" };
        }
        if (response.status === 403) return { kind: "forbidden" };
        return { kind: "answered", value: await response.json() };
      },
    );
  return {
    probe: async () => {
      const outcome = await call("models", { method: "GET" });
      return {
        readiness: directoryOAuthReadiness(outcome),
        ...(outcome.kind === "unauthenticated" ? { reason: outcome.reason } : {}),
        capabilitiesClaimed: outcome.kind === "answered",
      };
    },
    send: async () => {
      const outcome = await call("chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deployment-fixture", messages: [] }),
      });
      if (outcome.kind === "answered") return;
      const failure = directoryOAuthFailure(outcome);
      throw options.echoesBearerInFailures === true
        ? { ...failure, message: `${failure.message} (${lastBearer})` }
        : failure;
    },
  };
}

/** The endpoint a faulty driver builds from its pointer instead of its configuration. */
function trustingPointer(
  endpoint: DirectoryOAuthEndpoint,
  credential: DirectoryOAuthCredential,
): DirectoryOAuthEndpoint {
  if ("tenantId" in credential) {
    return {
      ...credential,
      baseUrl: credential.endpointOrigin,
      hostSuffixes: "hostSuffixes" in endpoint ? endpoint.hostSuffixes : HOST_SUFFIXES,
    };
  }
  return { ...credential, baseUrl: credential.endpointOrigin };
}

function fixture(
  options: Parameters<typeof referenceSubject>[1] = {},
): DirectoryOAuthConformanceFixture {
  return {
    signsInTo: "tenant",
    audience: AUDIENCE,
    baseUrl: "https://fixture.models.example.test/v1/",
    otherBaseUrl: "https://other.models.example.test/v1/",
    makeSubject: (input) => referenceSubject(input, options),
  };
}

/** An organization's gateway: its own issuer and host, so no host list. */
function issuerFixture(
  options: Parameters<typeof referenceSubject>[1] = {},
): DirectoryOAuthConformanceFixture {
  return {
    signsInTo: "issuer",
    baseUrl: "https://llm.example.test/v1/",
    otherBaseUrl: "https://llm-staging.example.test/v1/",
    makeSubject: (input) => referenceSubject(input, options),
  };
}

describe("directory-oauth conformance", () => {
  it("passes a driver that binds every request, refreshes through the host, and never reports a token", async () => {
    const evidence = await runDirectoryOAuthConformance(fixture());
    expect(evidence.cases).toEqual([
      "valid grant and binding is ready after the probe",
      "no grant is unauthenticated without the broker or endpoint",
      "near-expiry refresh happens once under concurrent requests",
      "refresh refused as expired, revoked, or reused needs a new sign-in",
      "refresh that needs the person present keeps the grant",
      "unreachable broker or directory, or a 5xx, is unavailable and keeps the grant",
      "pointer tenant, client, or audience differing from configuration is incompatible without the broker",
      "base URL off the grant's origin or off the host list is incompatible without the broker",
      "broker binding refusal is incompatible",
      "missing role assignment is not-authorized",
      "401 after a usable token refreshes once and resends once",
      "no report or failure carries a token",
    ]);
  });

  it("passes a gateway driver bound to the organization's own issuer and its signed-in origin", async () => {
    const evidence = await runDirectoryOAuthConformance(issuerFixture());
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

  it("fails a gateway driver that binds to the pointer instead of its own configuration", async () => {
    await expect(
      runDirectoryOAuthConformance(issuerFixture({ skipsConfigurationBinding: true })),
    ).rejects.toThrow(
      "pointer issuer, client, or scope differing from configuration is incompatible without the broker",
    );
  });

  it("fails a driver that binds to the pointer instead of its own configuration", async () => {
    await expect(
      runDirectoryOAuthConformance(fixture({ skipsConfigurationBinding: true })),
    ).rejects.toThrow(
      "pointer tenant, client, or audience differing from configuration is incompatible without the broker",
    );
  });

  it("fails a driver that gives up on a 401 instead of refreshing once", async () => {
    await expect(
      runDirectoryOAuthConformance(fixture({ retriesUnauthorized: false })),
    ).rejects.toThrow("401 after a usable token refreshes once and resends once");
  });

  it("fails a driver whose failure message carries the bearer", async () => {
    await expect(
      runDirectoryOAuthConformance(fixture({ echoesBearerInFailures: true })),
    ).rejects.toThrow("carries a token");
  });
});
