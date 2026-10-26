import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCredentialBroker, type CredentialBroker } from "./credentialBroker";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import {
  BINDING,
  OTHER_TENANT_ID,
  directoryDescriptor,
  startFakeDirectory,
  type FakeDirectory,
  type FakeRefreshAnswer,
} from "./fakeDirectory.test-support";
import { issuerDescriptor, startFakeIssuer } from "./fakeIssuer.test-support";

/**
 * Directory sign-in secret-absence harness.
 *
 * Every code and token the fake directory issues, and every PKCE verifier the
 * broker sent, is material that must stay in the broker. The server journals
 * and logs only what the broker's routes answer, so this proves no answer
 * carries any of it except the one access token `access` releases under its
 * binding, and that nothing the broker writes to the console does either. The
 * directory's own error text echoes the refresh token on purpose: no answer
 * may repeat it.
 */

const surfacesChecked: ReadonlyArray<string> = [
  "sign-in begin and status answers, loopback and device code (the server journals from these)",
  "refresh answers for every directory reply",
  "access refusals and the granted access answer",
  "sign-out answers",
  "refusals of malformed, unauthorized, and raw-resolve requests",
  "console output",
  "token requests (no client secret or assertion exists to leak)",
];

const open: Array<{ readonly close: () => Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of open.splice(0)) await resource.close();
});

function memoryStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void values.delete(id),
  };
}

describe("Directory sign-in secret-absence harness", () => {
  it("checks every surface a directory credential could reach", () => {
    expect(surfacesChecked).toHaveLength(7);
  });

  it("keeps directory tokens, codes, and verifiers out of every broker answer and the console", async () => {
    const consoleOutput: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args);
      });
    }
    const fake = await startFakeDirectory();
    open.push(fake);
    const broker = await startCredentialBroker(memoryStore(), undefined, {
      fetch: fake.fetch,
      timeoutMs: 5_000,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    open.push(broker);
    const answers: Array<{ readonly surface: string; readonly body: string }> = [];
    const answer = async (surface: string, path: string, body: unknown, token = broker.token) => {
      const response = await post(broker, path, body, token);
      const text = await response.text();
      answers.push({ surface, body: text });
      return JSON.parse(text) as Record<string, unknown>;
    };

    const credentialRef = await signInThroughBroker(fake, answer);
    // A refused sign-in, so a refused attempt's status is checked too.
    fake.flawExchangeIdToken("other-tenant");
    await signInThroughBroker(fake, answer).catch(() => undefined);
    fake.flawExchangeIdToken(undefined);
    // A device-code sign-in: the device code is the directory's, never an answer's.
    await signInWithDeviceCode(fake, answer);

    const replies: ReadonlyArray<FakeRefreshAnswer> = [
      { kind: "tokens", idToken: "same-subject" },
      { kind: "unreachable" },
      { kind: "status", status: 503 },
      { kind: "error", error: "interaction_required" },
      { kind: "error", error: "invalid_grant", errorCodes: [50076] },
    ];
    for (const reply of replies) {
      fake.answerRefreshWith(reply);
      await answer(`refresh (${reply.kind})`, "/v1/oauth/refresh", { credentialRef });
    }

    await answer("access under another tenant", "/v1/oauth/access", {
      credentialRef,
      binding: { ...BINDING, tenantId: OTHER_TENANT_ID },
    });
    await answer("access without a binding", "/v1/oauth/access", { credentialRef });
    await answer("malformed access", "/v1/oauth/access", { credentialRef, binding: "x" });
    await answer("unauthorized access", "/v1/oauth/access", { credentialRef }, "");
    await answer("raw resolve", "/v1/credentials/resolve", { providerInstanceId: credentialRef });
    const granted = await post(broker, "/v1/oauth/access", { credentialRef, binding: BINDING });
    const grantedText = await granted.text();

    // A refresh the directory ends: its error text names the refresh token.
    fake.answerRefreshWith({ kind: "error", error: "invalid_grant", errorCodes: [50173] });
    await answer("refresh (revoked)", "/v1/oauth/refresh", { credentialRef });
    await answer("access after the grant ended", "/v1/oauth/access", {
      credentialRef,
      binding: BINDING,
    });
    await answer("sign out", "/v1/oauth/revoke", { credentialRef });

    const verifiers = fake
      .tokenRequests()
      .flatMap((form) => (form.code_verifier === undefined ? [] : [form.code_verifier]));
    const material = [...fake.issued(), ...verifiers];
    expect(material.length).toBeGreaterThan(10);

    for (const { surface, body } of answers) {
      for (const secret of material) {
        expect(body.includes(secret), `${surface} carries directory material`).toBe(false);
      }
    }
    const serializedConsole = JSON.stringify(consoleOutput);
    for (const secret of material) {
      expect(serializedConsole.includes(secret), "console output carries directory material").toBe(
        false,
      );
    }

    // The granted answer releases one access token and nothing else.
    const released = material.filter((secret) => grantedText.includes(secret));
    expect(released).toHaveLength(1);
    expect(released[0]).toMatch(/^fake-directory-access-/);
    expect(Object.keys(JSON.parse(grantedText) as object).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "kind",
      "tokenType",
    ]);

    for (const form of fake.tokenRequests()) {
      expect(form).not.toHaveProperty("client_secret");
      expect(form).not.toHaveProperty("client_assertion");
      expect(form).not.toHaveProperty("client_assertion_type");
    }
  });

  it("keeps an organization issuer's tokens, codes, and verifiers out of every broker answer and the console", async () => {
    const consoleOutput: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args);
      });
    }
    const fake = await startFakeIssuer();
    open.push(fake);
    const broker = await startCredentialBroker(memoryStore(), undefined, {
      fetch: fake.fetch,
      timeoutMs: 5_000,
    });
    open.push(broker);
    const answers: string[] = [];
    const answer = async (path: string, body: unknown) => {
      const text = await (await post(broker, path, body)).text();
      answers.push(text);
      return JSON.parse(text) as Record<string, unknown>;
    };

    const started = await answer("/v1/oauth/begin", {
      actorId: randomUUID(),
      termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
      descriptor: issuerDescriptor(),
    });
    if (typeof started.authorizationUrl !== "string") throw new Error("expected an attempt");
    await fake.consent(started.authorizationUrl);
    const status = await answer("/v1/oauth/status", { attemptId: started.attemptId });
    const credentialRef = status.credentialRef;
    if (typeof credentialRef !== "string") throw new Error("expected a sign-in");
    for (const reply of [
      { kind: "tokens", idToken: "same-subject" },
      { kind: "status", status: 503 },
      { kind: "error", error: "interaction_required" },
    ] as const) {
      fake.answerRefreshWith(reply);
      await answer("/v1/oauth/refresh", { credentialRef });
    }
    await answer("/v1/oauth/access", { credentialRef });
    await answer("/v1/credentials/resolve", { providerInstanceId: credentialRef });
    // The issuer's error text names the refresh token: no answer repeats it.
    fake.answerRefreshWith({ kind: "error", error: "invalid_grant" });
    await answer("/v1/oauth/refresh", { credentialRef });
    await answer("/v1/oauth/revoke", { credentialRef });

    const verifiers = fake
      .tokenRequests()
      .flatMap((form) => (form.code_verifier === undefined ? [] : [form.code_verifier]));
    const material = [...fake.issued(), ...verifiers];
    expect(material.length).toBeGreaterThan(6);
    const surfaces = [...answers, JSON.stringify(consoleOutput)].join("\n");
    for (const secret of material) {
      expect(surfaces.includes(secret), "an answer or the console carries issuer material").toBe(
        false,
      );
    }
  });
});

async function signInThroughBroker(
  fake: FakeDirectory,
  answer: (surface: string, path: string, body: unknown) => Promise<Record<string, unknown>>,
): Promise<string> {
  const started = await answer("begin", "/v1/oauth/begin", {
    actorId: randomUUID(),
    termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
    descriptor: directoryDescriptor(),
  });
  if (typeof started.authorizationUrl !== "string") throw new Error("expected an attempt");
  await fake.consent(started.authorizationUrl);
  const status = await answer("status", "/v1/oauth/status", { attemptId: started.attemptId });
  if (typeof status.credentialRef !== "string") throw new Error("expected a sign-in");
  return status.credentialRef;
}

async function signInWithDeviceCode(
  fake: FakeDirectory,
  answer: (surface: string, path: string, body: unknown) => Promise<Record<string, unknown>>,
): Promise<void> {
  const started = await answer("device-code begin", "/v1/oauth/begin", {
    actorId: randomUUID(),
    termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
    descriptor: directoryDescriptor({ flow: "device-code" }),
  });
  if (typeof started.userCode !== "string") throw new Error("expected a device-code attempt");
  await answer("device-code status while pending", "/v1/oauth/status", {
    attemptId: started.attemptId,
  });
  fake.settleDeviceCode(started.userCode, "approved");
  const deadline = Date.now() + 3_000;
  let status = await answer("device-code status", "/v1/oauth/status", {
    attemptId: started.attemptId,
  });
  while (status.kind === "awaiting-consent" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = await answer("device-code status", "/v1/oauth/status", {
      attemptId: started.attemptId,
    });
  }
  if (status.kind !== "signed-in") throw new Error("expected a device-code sign-in");
}

function post(
  broker: CredentialBroker,
  path: string,
  body: unknown,
  token: string = broker.token,
): Promise<Response> {
  return broker.fetchForTest(
    new Request(new URL(path, broker.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-credential-broker-token": token,
      },
      body: JSON.stringify(body),
    }),
  );
}
