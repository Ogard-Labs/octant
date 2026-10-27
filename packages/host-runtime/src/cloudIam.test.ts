import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCredentialBroker, type CredentialBroker } from "./credentialBroker";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import {
  DEVICE_PAGE,
  FakeCloud,
  MODEL_HOST,
  MODEL_PATH,
  OIDC_HOST,
  PORTAL_HOST,
  START_URL,
  cloudDescriptor,
} from "./fakeCloudIam.test-support";
import { sha256Hex } from "./sigV4";

function memoryStore(): CredentialStore & {
  readonly values: Map<string, string>;
  /** Make the next resolve read its value now and answer only when released, as a slow keychain does. */
  readonly holdNextResolve: () => { readonly read: Promise<void>; readonly release: () => void };
} {
  const values = new Map<string, string>();
  let held: { readonly read: () => void; readonly released: Promise<void> } | undefined;
  return {
    values,
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      const hold = held;
      held = undefined;
      if (hold !== undefined) {
        hold.read();
        await hold.released;
      }
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void values.delete(id),
    holdNextResolve: () => {
      let read = () => {};
      let release = () => {};
      const readPromise = new Promise<void>((resolve) => {
        read = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { read, released };
      return { read: readPromise, release };
    },
  };
}

const open: CredentialBroker[] = [];

afterEach(async () => {
  for (const broker of open.splice(0)) await broker.close();
});

const BODY = JSON.stringify({ messages: [{ role: "user", content: [{ text: "Hello" }] }] });

function modelRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    host: MODEL_HOST,
    path: MODEL_PATH,
    query: [],
    headers: { "content-type": "application/json", accept: "application/json" },
    payloadHash: sha256Hex(BODY),
    ...overrides,
  };
}

interface Scene {
  readonly broker: CredentialBroker;
  readonly cloud: FakeCloud;
  readonly store: ReturnType<typeof memoryStore>;
  readonly clock: { now: number };
  /** Every broker answer body, for the secret-absence check. */
  readonly answers: string[];
  /** Every wait the broker asked for between device-code polls, in order. */
  readonly waits: number[];
  readonly call: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
}

async function scene(): Promise<Scene> {
  const clock = { now: Date.parse("2026-10-27T09:00:00.000Z") };
  const cloud = new FakeCloud(() => clock.now);
  const store = memoryStore();
  const waits: number[] = [];
  const broker = await startCredentialBroker(store, undefined, {
    fetch: cloud.fetch as typeof fetch,
    now: () => clock.now,
    sleep: (ms) => {
      waits.push(ms);
      return new Promise((resolve) => setTimeout(resolve, 1));
    },
  });
  open.push(broker);
  const answers: string[] = [];
  const call = async (path: string, body: unknown) => {
    const response = await broker.fetchForTest(
      new Request(new URL(path, broker.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": broker.token,
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text) as unknown };
  };
  return { broker, cloud, store, clock, answers, waits, call };
}

async function begin(
  current: Scene,
  descriptor: unknown = cloudDescriptor(),
): Promise<{ status: number; body: unknown }> {
  return current.call("/v1/cloud-iam/begin", {
    descriptor,
    actorId: randomUUID(),
    termsAcknowledgedAt: "2026-10-27T09:00:00.000Z",
  });
}

async function settled(current: Scene, attemptId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const { body } = await current.call("/v1/cloud-iam/status", { attemptId });
    const state = body as Record<string, unknown>;
    if (state.kind !== "awaiting-consent" || Date.now() > deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function signedIn(current: Scene): Promise<string> {
  const started = await begin(current);
  const attempt = started.body as { attemptId: string };
  current.cloud.approve();
  const state = await settled(current, attempt.attemptId);
  if (state.kind !== "signed-in" || typeof state.credentialRef !== "string") {
    throw new Error(`expected a sign-in, got ${String(state.kind)}`);
  }
  return state.credentialRef;
}

async function sign(
  current: Scene,
  credentialRef: string,
  request: unknown = modelRequest(),
  extra: Record<string, unknown> = {},
) {
  return current.call("/v1/cloud-iam/sign", { credentialRef, request, ...extra });
}

/** Send the signed request to the fake model endpoint as a driver would. */
async function send(
  current: Scene,
  headers: Readonly<Record<string, string>>,
  overrides: Partial<{
    method: string;
    url: string;
    body: string;
    extraHeaders: Record<string, string>;
  }> = {},
): Promise<number> {
  const response = await current.cloud.fetch(
    overrides.url ?? `https://${MODEL_HOST}${MODEL_PATH}`,
    {
      method: overrides.method ?? "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
        ...overrides.extraHeaders,
      },
      body: overrides.body ?? BODY,
    },
  );
  return response.status;
}

describe("cloud single sign-on", () => {
  it("signs in with a device code at the portal's own page and mints the role before storing anything", async () => {
    const current = await scene();
    const started = await begin(current);
    expect(started.body).toMatchObject({
      kind: "awaiting-consent",
      flow: "device-code",
      verificationUri: DEVICE_PAGE,
      userCode: expect.stringMatching(/^ABCD-\d{4}$/),
    });
    expect(current.store.values.size).toBe(0);

    current.cloud.approve();
    const state = await settled(current, (started.body as { attemptId: string }).attemptId);
    expect(state).toMatchObject({ kind: "signed-in", descriptorId: "amazon-bedrock-cloud-iam" });
    expect(Object.keys(state).sort()).toEqual([
      "attemptId",
      "credentialRef",
      "descriptorId",
      "kind",
    ]);
    expect(current.cloud.count(PORTAL_HOST, "/federation/credentials")).toBe(1);
    expect(current.store.values.size).toBe(1);
    // Only the portal's OIDC service and its credential endpoint were asked.
    expect(new Set(current.cloud.requests().map((request) => request.url.host))).toEqual(
      new Set([OIDC_HOST, PORTAL_HOST]),
    );
    const register = current.cloud.requests()[0];
    expect(JSON.parse(register?.body ?? "{}")).toEqual({
      clientName: "Octant",
      clientType: "public",
      scopes: ["sso:account:access"],
    });
  });

  it("stores nothing for a declined code, an expired code, or a person without the role", async () => {
    for (const outcome of ["declined", "expired", "no-role"] as const) {
      const current = await scene();
      const started = await begin(current);
      if (outcome === "declined") current.cloud.decline();
      if (outcome === "expired") current.cloud.expireCodes();
      if (outcome === "no-role") {
        current.cloud.answerMintWith("forbidden");
        current.cloud.approve();
      }
      const state = await settled(current, (started.body as { attemptId: string }).attemptId);
      expect(state).toMatchObject({
        kind: "refused",
        reason: { declined: "denied", expired: "timeout", "no-role": "not-authorized" }[outcome],
      });
      expect(current.store.values.size).toBe(0);
    }
  });

  it("keeps polling through a portal outage with a growing wait and signs in once the code is entered", async () => {
    const current = await scene();
    current.cloud.failDevicePolls("server-error", "throttled", "unreachable");
    const started = await begin(current);
    current.cloud.approve();

    const state = await settled(current, (started.body as { attemptId: string }).attemptId);

    expect(state).toMatchObject({ kind: "signed-in" });
    expect(current.cloud.count(OIDC_HOST, "/token")).toBeGreaterThanOrEqual(4);
    // The portal asks for a poll every second; each failure in a row doubles
    // the wait, and the first answer after the outage resets it.
    expect(current.waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(current.waits.slice(4).every((wait) => wait === 1_000)).toBe(true);
    expect(current.store.values.size).toBe(1);
  });

  it("gives up on a portal poll that never answers and polls again, so a stalled connection cannot hold an attempt open", async () => {
    // Each portal request carries its own deadline; the test shortens it so
    // the stalled poll is abandoned at once instead of after the real bound.
    const timeouts: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return timeout(5);
    });
    try {
      const current = await scene();
      current.cloud.failDevicePolls("hangs");
      const started = await begin(current);
      current.cloud.approve();

      const state = await settled(current, (started.body as { attemptId: string }).attemptId);

      expect(state).toMatchObject({ kind: "signed-in" });
      expect(current.waits.slice(0, 2)).toEqual([1_000, 2_000]);
      expect(timeouts.length).toBeGreaterThan(0);
      expect(timeouts.every((ms) => ms > 0 && ms <= 60_000)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("ends an attempt whose code ran out while the portal was failing as unavailable, storing nothing", async () => {
    const current = await scene();
    current.cloud.failDevicePolls(...Array.from({ length: 1_000 }, () => "server-error" as const));
    const started = await begin(current);
    const deadline = Date.now() + 2_000;
    while (current.cloud.count(OIDC_HOST, "/token") < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(current.cloud.count(OIDC_HOST, "/token")).toBeGreaterThanOrEqual(2);

    current.clock.now += 11 * 60_000;

    expect(await settled(current, (started.body as { attemptId: string }).attemptId)).toMatchObject(
      { kind: "refused", reason: "unavailable" },
    );
    expect(current.store.values.size).toBe(0);
    // The wait never grows past a minute however long the outage lasts.
    expect(Math.max(...current.waits)).toBeLessThanOrEqual(60_000);
  });

  it("forgets a settled attempt a while after its code ran out", async () => {
    const current = await scene();
    const first = await begin(current);
    const attemptId = (first.body as { attemptId: string }).attemptId;
    current.cloud.decline();
    expect(await settled(current, attemptId)).toMatchObject({ kind: "refused", reason: "denied" });

    // Still readable just past expiry, for a command that polls late.
    current.clock.now += 11 * 60_000;
    await begin(current);
    expect((await current.call("/v1/cloud-iam/status", { attemptId })).body).toMatchObject({
      kind: "refused",
      reason: "denied",
    });

    current.clock.now += 5 * 60_000;
    await begin(current);
    expect((await current.call("/v1/cloud-iam/status", { attemptId })).body).toEqual({
      kind: "unknown",
    });
  });

  it("refuses a page off the portal's own hosts before any code is shown", async () => {
    for (const page of [
      "https://device.sso.us-east-1.amazonaws.com.evil.example/",
      "https://contoso-example.awsapps.com:8443/start/#/device",
      "http://device.sso.us-east-1.amazonaws.com/",
      "https://device.sso.eu-west-1.amazonaws.com/",
      "https://device.sso.us-east-1.amazonaws.com/\u001b[2J",
    ]) {
      const current = await scene();
      current.cloud.setVerificationUri(page);
      expect((await begin(current)).body).toEqual({ kind: "refused", reason: "exchange-refused" });
    }
    const portal = await scene();
    portal.cloud.setVerificationUri(`${START_URL}/#/device`);
    expect((await begin(portal)).body).toMatchObject({ kind: "awaiting-consent" });
  });

  it("reads a refused device authorization as refused and an unreachable one as unavailable", async () => {
    const refused = await scene();
    refused.cloud.setDeviceAnswer("refused");
    expect((await begin(refused)).body).toEqual({ kind: "refused", reason: "exchange-refused" });
    const down = await scene();
    down.cloud.setDeviceAnswer("unavailable");
    expect((await begin(down)).body).toEqual({ kind: "refused", reason: "unavailable" });
  });

  it("refuses a sign-in for anything outside the closed signing table before any request", async () => {
    const outside = [
      cloudDescriptor({ scope: { service: "iam" } }),
      cloudDescriptor({ scope: { host: "iam.amazonaws.com" } }),
      cloudDescriptor({ scope: { host: "bedrock-runtime.us-east-1.amazonaws.com" } }),
      cloudDescriptor({
        scope: { region: "cn-north-1", host: "bedrock-runtime.cn-north-1.amazonaws.com" },
      }),
      cloudDescriptor({ scope: { pathPrefix: "/" } }),
      cloudDescriptor({ scope: { method: "GET" } }),
      cloudDescriptor({ scope: { partition: "aws-us-gov" } }),
      cloudDescriptor({
        source: { startUrl: "https://contoso-example.awsapps.com.evil.example/start" },
      }),
      cloudDescriptor({ source: { ssoRegion: "us-gov-west-1" } }),
      cloudDescriptor({ source: { accountId: "12345" } }),
      { ...cloudDescriptor(), flow: "authorization-code-pkce" },
      { ...cloudDescriptor(), tokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token" },
    ];
    for (const descriptor of outside) {
      const current = await scene();
      expect((await begin(current, descriptor)).status).toBe(400);
      expect(current.cloud.requests()).toHaveLength(0);
    }
  });
});

describe("cloud request signing", () => {
  it("signs a model request the endpoint verifies, with no key in the answer", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    const signed = await sign(current, credentialRef);
    expect(signed.status).toBe(200);
    const body = signed.body as { kind: string; headers: Record<string, string> };
    expect(body.kind).toBe("signed");
    expect(Object.keys(body.headers).sort()).toEqual([
      "authorization",
      "x-amz-date",
      "x-amz-security-token",
    ]);
    expect(body.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIA[0-9A-F]{16}\/20261027\/us-west-2\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    expect(await send(current, body.headers)).toBe(200);
  });

  it("refuses a request outside the grant's scope without renewing or signing", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    const before = current.cloud.requests().length;
    for (const request of [
      modelRequest({ method: "GET" }),
      modelRequest({ host: "bedrock-runtime.us-east-1.amazonaws.com" }),
      modelRequest({ host: "bedrock.us-west-2.amazonaws.com" }),
      modelRequest({ host: "iam.amazonaws.com" }),
      modelRequest({ path: "/guardrail/abc" }),
      modelRequest({ path: "/model/../guardrail/x" }),
      // A URL parser reads an escaped dot segment as one, so `fetch` would
      // send these to `/guardrail/x` and `/async-invoke`.
      modelRequest({ path: "/model/%2E%2E/guardrail/x" }),
      modelRequest({ path: "/model/.%2E/async-invoke" }),
      modelRequest({ path: "/model/%2E/converse" }),
      modelRequest({ path: "/model//converse" }),
      modelRequest({ path: "/model/a%2/converse" }),
      modelRequest({ path: "/model/a b/converse" }),
      modelRequest({ headers: { authorization: "AWS4-HMAC-SHA256 forged" } }),
      modelRequest({ headers: { "x-amz-date": "20991231T000000Z" } }),
      modelRequest({ headers: { "x-amz-security-token": "other" } }),
      modelRequest({
        headers: { "x-amz-target": "AWSSecurityTokenServiceV20110615.GetCallerIdentity" },
      }),
      modelRequest({ payloadHash: "UNSIGNED-PAYLOAD" }),
    ]) {
      const answer = await sign(current, credentialRef, request);
      expect(answer.body).toEqual({ kind: "outside-scope" });
    }
    expect(current.cloud.requests().length).toBe(before);
  });

  it("refuses a sign request that brings its own digest, date, or scope", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    const before = current.cloud.requests().length;
    for (const extra of [
      { stringToSign: "AWS4-HMAC-SHA256\n20261027T090000Z\n..." },
      { canonicalRequestHash: "0".repeat(64) },
      { digest: "0".repeat(64) },
      { amzDate: "20991231T000000Z" },
      { scope: { region: "us-east-1", service: "iam" } },
      { region: "us-east-1" },
      { service: "sts" },
    ]) {
      const outer = await sign(current, credentialRef, modelRequest(), extra);
      expect(outer.status).toBe(400);
      const inner = await sign(current, credentialRef, modelRequest(extra));
      expect(inner.status).toBe(400);
      expect([outer.body, inner.body]).toEqual([
        { error: "invalid-request" },
        { error: "invalid-request" },
      ]);
    }
    expect(current.cloud.requests().length).toBe(before);
  });

  it("produces a signature that fails for any changed method, host, path, query, signed header, or payload", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    const { headers } = (await sign(current, credentialRef)).body as {
      headers: Record<string, string>;
    };
    expect(await send(current, headers)).toBe(200);
    const replays = [
      { method: "PUT" },
      { url: `https://${MODEL_HOST}/model/anthropic.claude-opus-4-20250514-v1%3A0/converse` },
      { url: `https://${MODEL_HOST}${MODEL_PATH}?trace=1` },
      { url: `https://${MODEL_HOST}${MODEL_PATH.replace("converse", "converse-stream")}` },
      { extraHeaders: { "content-type": "text/plain" } },
      { extraHeaders: { accept: "application/vnd.amazon.eventstream" } },
      { body: BODY.replace("Hello", "Goodbye") },
    ];
    for (const replay of replays) {
      expect(await send(current, headers, replay)).toBe(403);
    }
    // Another host does not verify it either: the fake answers only its own.
    expect(
      current.cloud.verify({
        method: "POST",
        url: new URL(`https://bedrock-runtime.us-east-1.amazonaws.com${MODEL_PATH}`),
        headers: new Headers({
          "content-type": "application/json",
          accept: "application/json",
          ...headers,
        }),
        body: BODY,
      }),
    ).toBe("invalid");
  });

  it("renews role credentials near their end once for concurrent signatures", async () => {
    const current = await scene();
    current.cloud.setRoleLifetimeMs(10 * 60_000);
    const credentialRef = await signedIn(current);
    current.clock.now += 6 * 60_000;
    const answers = await Promise.all([
      sign(current, credentialRef),
      sign(current, credentialRef),
      sign(current, credentialRef),
    ]);
    for (const answer of answers) expect(answer.body).toMatchObject({ kind: "signed" });
    expect(current.cloud.count(PORTAL_HOST, "/federation/credentials")).toBe(2);
  });

  it("signs with the credentials another signature just renewed when it read the grant before them", async () => {
    const current = await scene();
    current.cloud.setRoleLifetimeMs(10 * 60_000);
    const credentialRef = await signedIn(current);
    current.clock.now += 6 * 60_000;
    // The late signature reads the grant before the renewal stores new
    // credentials, and resumes only after that renewal has finished.
    const hold = current.store.holdNextResolve();
    const late = sign(current, credentialRef);
    await hold.read;
    expect((await sign(current, credentialRef)).body).toMatchObject({ kind: "signed" });
    hold.release();
    expect((await late).body).toMatchObject({ kind: "signed" });
    expect(current.store.values.has(credentialRef)).toBe(true);
  });

  it("renews the portal session when it has ended and keeps signing", async () => {
    const current = await scene();
    current.cloud.setSessionLifetimeSeconds(60 * 60);
    current.cloud.setRoleLifetimeMs(10 * 60_000);
    const credentialRef = await signedIn(current);
    current.clock.now += 2 * 60 * 60_000;
    const answer = await sign(current, credentialRef);
    expect(answer.body).toMatchObject({ kind: "signed" });
    expect(current.cloud.count(OIDC_HOST, "/token")).toBe(2);
    expect(await send(current, (answer.body as { headers: Record<string, string> }).headers)).toBe(
      200,
    );
  });

  it("ends the grant when the portal session ends or is withdrawn, and keeps it through outages", async () => {
    const cases = [
      ["invalid_grant", { kind: "sign-in-again", reason: "expired" }, false],
      ["invalid_client", { kind: "sign-in-again", reason: "revoked" }, false],
      ["access_denied", { kind: "sign-in-again", reason: "revoked" }, false],
      ["server-error", { kind: "unavailable" }, true],
      ["unreachable", { kind: "unavailable" }, true],
    ] as const;
    for (const [answer, expected, kept] of cases) {
      const current = await scene();
      current.cloud.setSessionLifetimeSeconds(60 * 60);
      current.cloud.setRoleLifetimeMs(10 * 60_000);
      const credentialRef = await signedIn(current);
      current.clock.now += 2 * 60 * 60_000;
      current.cloud.answerRefreshWith(answer);
      expect((await sign(current, credentialRef)).body).toEqual(expected);
      expect(current.store.values.has(credentialRef)).toBe(kept);
    }
  });

  it("ends a session without a refresh token when it expires", async () => {
    const current = await scene();
    current.cloud.setGrantsRefreshToken(false);
    current.cloud.setSessionLifetimeSeconds(60 * 60);
    current.cloud.setRoleLifetimeMs(10 * 60_000);
    const credentialRef = await signedIn(current);
    current.clock.now += 2 * 60 * 60_000;
    expect((await sign(current, credentialRef)).body).toEqual({
      kind: "sign-in-again",
      reason: "expired",
    });
    expect(current.store.values.has(credentialRef)).toBe(false);
  });

  it("keeps the grant when the portal stops giving the role, and ends it when the session is refused twice", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    current.cloud.answerMintWith("forbidden");
    expect(
      (await sign(current, credentialRef, modelRequest(), { renewCredentials: true })).body,
    ).toEqual({ kind: "not-authorized" });
    expect(current.store.values.has(credentialRef)).toBe(true);
    expect(
      (await sign(current, credentialRef, modelRequest(), { renewCredentials: true })).body,
    ).toMatchObject({ kind: "signed" });

    // The portal refuses the session, a renewed session is refused as well:
    // only a new sign-in can change that.
    current.cloud.answerMintWith("unauthorized", "unauthorized");
    expect(
      (await sign(current, credentialRef, modelRequest(), { renewCredentials: true })).body,
    ).toEqual({ kind: "sign-in-again", reason: "revoked" });
    expect(current.cloud.count(OIDC_HOST, "/token")).toBe(2);
    expect(current.store.values.has(credentialRef)).toBe(false);
  });

  it("ends the grant when an administrator ends the portal session", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    current.cloud.revokeSessions();
    // The portal answers a withdrawn refresh token as an invalid grant, the
    // same answer a session that ran its course gets.
    expect(
      (await sign(current, credentialRef, modelRequest(), { renewCredentials: true })).body,
    ).toEqual({ kind: "sign-in-again", reason: "expired" });
    expect(current.store.values.has(credentialRef)).toBe(false);
  });

  it("renews credentials on request after the endpoint refused them", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    const first = (await sign(current, credentialRef)).body as { headers: Record<string, string> };
    current.cloud.expireRoleCredentials();
    expect(await send(current, first.headers)).toBe(403);
    const renewed = (await sign(current, credentialRef, modelRequest(), { renewCredentials: true }))
      .body as { headers: Record<string, string> };
    expect(await send(current, renewed.headers)).toBe(200);
  });

  it("reads a reference to no grant as signed out and another kind's grant as outside the scope", async () => {
    const current = await scene();
    expect((await sign(current, randomUUID())).body).toEqual({
      kind: "sign-in-again",
      reason: "expired",
    });
    const foreign = randomUUID();
    current.store.values.set(foreign, JSON.stringify({ kind: "host-oauth-grant", version: 1 }));
    expect((await sign(current, foreign)).body).toEqual({ kind: "outside-scope" });
  });

  it("does not read a stored grant whose scope left the closed table", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    const stored = JSON.parse(current.store.values.get(credentialRef) ?? "{}") as {
      scope: Record<string, string>;
    };
    stored.scope = { ...stored.scope, service: "sts", host: "sts.amazonaws.com" };
    current.store.values.set(credentialRef, JSON.stringify(stored));
    expect(
      (await sign(current, credentialRef, modelRequest({ host: "sts.amazonaws.com" }))).body,
    ).toEqual({ kind: "outside-scope" });
  });
});

describe("cloud grants in the broker", () => {
  it("never releases a cloud grant through a raw resolve", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    const answer = await current.call("/v1/credentials/resolve", {
      providerInstanceId: credentialRef,
    });
    expect(answer).toEqual({ status: 403, body: { error: "cloud-iam-material" } });
  });

  it("refuses a browser, tokenless, or remote caller on every cloud route", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    const before = current.cloud.requests().length;
    const routes: ReadonlyArray<readonly [string, unknown]> = [
      [
        "/v1/cloud-iam/begin",
        { descriptor: cloudDescriptor(), actorId: randomUUID(), termsAcknowledgedAt: "now" },
      ],
      ["/v1/cloud-iam/sign", { credentialRef, request: modelRequest() }],
      ["/v1/cloud-iam/revoke", { credentialRef }],
    ];
    for (const [path, body] of routes) {
      const request = (headers: Record<string, string>) =>
        new Request(new URL(path, current.broker.url), {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      const token = { "x-octant-credential-broker-token": current.broker.token };
      for (const [answer, peer] of [
        [request({}), "127.0.0.1"],
        [request({ ...token, origin: "https://evil.example" }), "127.0.0.1"],
        [request(token), "192.168.1.20"],
      ] as const) {
        expect((await current.broker.fetchForTest(answer, peer)).status).toBe(401);
      }
    }
    expect(current.cloud.requests().length).toBe(before);
    expect(current.store.values.has(credentialRef)).toBe(true);
  });

  it("signs out by asking the portal to end the session and deleting the grant, even when the portal is down", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    expect((await current.call("/v1/cloud-iam/revoke", { credentialRef })).body).toEqual({
      kind: "revoked",
    });
    expect(current.cloud.count(PORTAL_HOST, "/logout")).toBe(1);
    expect(current.store.values.has(credentialRef)).toBe(false);

    const down = await scene();
    const kept = await signedIn(down);
    down.cloud.setReachable(false);
    expect((await down.call("/v1/cloud-iam/revoke", { credentialRef: kept })).body).toEqual({
      kind: "revoked",
    });
    expect(down.store.values.has(kept)).toBe(false);
  });

  it("answers with no client secret, device code, portal token, or role key anywhere", async () => {
    const current = await scene();
    const credentialRef = await signedIn(current);
    current.cloud.setRoleLifetimeMs(1);
    await sign(current, credentialRef);
    await sign(current, credentialRef, modelRequest({ method: "GET" }));
    await current.call("/v1/credentials/resolve", { providerInstanceId: credentialRef });
    await current.call("/v1/cloud-iam/revoke", { credentialRef });
    const answered = current.answers.join("\n");
    expect(current.cloud.secrets().length).toBeGreaterThan(5);
    for (const secret of current.cloud.secrets()) expect(answered).not.toContain(secret);
  });
});
