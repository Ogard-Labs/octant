import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCredentialBroker, type CredentialBroker } from "./credentialBroker";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { makeFakeOnePassword, type FakeOnePassword } from "./fakeOnePassword.test-support";
import { makeLinkedSecretStores, makeOnePasswordAdapter } from "./linkedSecretStores";

const KEY_ID_REFERENCE = "op://Private/AWS/access key id";
const SECRET_REFERENCE = "op://Private/AWS/secret access key";
const LONG_LIVED_KEY_ID = "AKIAFIXTURE0000LONG";
const LONG_LIVED_SECRET = "fixtureLongLivedSecret/0123456789abcdefghij";
const SESSION = {
  accessKeyId: "ASIAFIXTURE00SESSION",
  secretAccessKey: "fixtureSessionSecret/abcdefghij0123456789",
  sessionToken: "FwoGZXIvYXdzEFixtureSessionToken0123456789+/=",
};
const START = Date.parse("2026-11-01T12:00:00Z");

function memoryStore(): CredentialStore {
  const entries = new Map<string, string>();
  return {
    set: async (id, value) => void entries.set(id, value),
    has: async (id) => entries.has(id),
    resolve: async (id) => {
      const value = entries.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void entries.delete(id),
  };
}

function stsAnswer(expiration: string): string {
  return `<GetSessionTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetSessionTokenResult><Credentials>
    <SessionToken>${SESSION.sessionToken}</SessionToken>
    <SecretAccessKey>${SESSION.secretAccessKey}</SecretAccessKey>
    <Expiration>${expiration}</Expiration>
    <AccessKeyId>${SESSION.accessKeyId}</AccessKeyId>
  </Credentials></GetSessionTokenResult>
</GetSessionTokenResponse>`;
}

interface Harness {
  readonly op: FakeOnePassword;
  readonly requests: Array<{ url: string; headers: Headers; body: string }>;
  readonly clock: { now: number };
  readonly sts: { status: number };
  readonly post: (path: string, body?: unknown) => Promise<{ status: number; text: string }>;
}

const brokers: CredentialBroker[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

async function harness(): Promise<Harness> {
  const op = makeFakeOnePassword();
  op.addItem(KEY_ID_REFERENCE, LONG_LIVED_KEY_ID);
  op.addItem(SECRET_REFERENCE, LONG_LIVED_SECRET);
  const requests: Harness["requests"] = [];
  const clock = { now: START };
  const sts = { status: 200 };
  const linked = makeLinkedSecretStores({
    statePath: join(mkdtempSync(join(tmpdir(), "octant-aws-cli-")), "state.json"),
    adapters: [makeOnePasswordAdapter({ executablePath: op.executablePath, env: op.env })],
  });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    const expiration = new Date(clock.now + 3_600_000).toISOString();
    return new Response(sts.status === 200 ? stsAnswer(expiration) : "<Error/>", {
      status: sts.status,
    });
  }) as typeof fetch;
  const store = memoryStore();
  const broker = await startCredentialBroker(
    store,
    undefined,
    { fetch: fakeFetch, now: () => clock.now },
    store,
    store,
    store,
    store,
    store,
    store,
    linked,
  );
  brokers.push(broker);
  return {
    op,
    requests,
    clock,
    sts,
    post: async (path, body = {}) => {
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
      return { status: response.status, text: await response.text() };
    },
  };
}

const pointer = {
  store: "onepassword",
  accessKeyIdReference: KEY_ID_REFERENCE,
  secretAccessKeyReference: SECRET_REFERENCE,
};

async function linkedHarness(): Promise<Harness> {
  const h = await harness();
  expect(
    JSON.parse((await h.post("/v1/secret-stores/link", { store: "onepassword" })).text),
  ).toEqual({ status: "linked" });
  return h;
}

describe("AWS command-line sessions from a linked store", () => {
  it("points only at two items that resolve now, and answers the pointer without its values", async () => {
    const h = await linkedHarness();

    const missing = await h.post("/v1/cloud-cli/aws/point", {
      ...pointer,
      secretAccessKeyReference: "op://Private/AWS/nothing here",
    });
    expect(JSON.parse(missing.text)).toEqual({ status: "missing" });
    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/reference")).text)).toEqual({
      status: "none",
    });

    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/point", pointer)).text)).toEqual({
      status: "pointed",
    });
    const reference = await h.post("/v1/cloud-cli/aws/reference");
    expect(JSON.parse(reference.text)).toEqual({ status: "linked", ...pointer });
    expect(reference.text).not.toContain(LONG_LIVED_SECRET);
    expect(reference.text).not.toContain(LONG_LIVED_KEY_ID);
  });

  it("hands out a signed one-hour session and never the long-lived key pair", async () => {
    const h = await linkedHarness();
    await h.post("/v1/cloud-cli/aws/point", pointer);

    const answer = await h.post("/v1/cloud-cli/aws/session");

    expect(JSON.parse(answer.text)).toEqual({
      status: "issued",
      ...SESSION,
      expiration: new Date(START + 3_600_000).toISOString(),
    });
    expect(answer.text).not.toContain(LONG_LIVED_SECRET);
    expect(answer.text).not.toContain(LONG_LIVED_KEY_ID);
    const [request] = h.requests;
    expect(request?.url).toBe("https://sts.amazonaws.com/");
    expect(request?.body).toBe("Action=GetSessionToken&DurationSeconds=3600&Version=2011-06-15");
    expect(request?.headers.get("authorization")).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${LONG_LIVED_KEY_ID}/20261101/us-east-1/sts/aws4_request, `,
      ),
    );
    expect(request?.headers.get("authorization")).not.toContain(LONG_LIVED_SECRET);
  });

  it("reuses a session while a quarter hour is left, then asks AWS again", async () => {
    const h = await linkedHarness();
    await h.post("/v1/cloud-cli/aws/point", pointer);

    await h.post("/v1/cloud-cli/aws/session");
    h.clock.now += 40 * 60_000;
    await h.post("/v1/cloud-cli/aws/session");
    expect(h.requests).toHaveLength(1);

    h.clock.now += 10 * 60_000;
    await h.post("/v1/cloud-cli/aws/session");
    expect(h.requests).toHaveLength(2);
  });

  it("fails closed with a value when the store is unlinked, locked, or AWS refuses the key", async () => {
    const h = await linkedHarness();
    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/session")).text)).toEqual({
      status: "none",
    });
    await h.post("/v1/cloud-cli/aws/point", pointer);

    h.sts.status = 403;
    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/session")).text)).toEqual({
      status: "refused",
    });

    h.sts.status = 200;
    h.op.setMode("locked");
    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/session")).text)).toEqual({
      status: "locked",
    });

    h.op.setMode("ready");
    await h.post("/v1/cloud-cli/aws/session");
    await h.post("/v1/secret-stores/unlink", { store: "onepassword" });
    // A session issued before the unlink is not handed out after it.
    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/session")).text)).toEqual({
      status: "not-linked",
    });
    // Unlinking keeps the pointer, as it does a provider key's.
    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/reference")).text)).toMatchObject({
      status: "linked",
    });
  });

  it("clears the pointer and forgets the session it issued", async () => {
    const h = await linkedHarness();
    await h.post("/v1/cloud-cli/aws/point", pointer);
    await h.post("/v1/cloud-cli/aws/session");

    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/clear")).text)).toEqual({
      status: "cleared",
      ...pointer,
    });
    expect(JSON.parse((await h.post("/v1/cloud-cli/aws/session")).text)).toEqual({
      status: "none",
    });
  });

  it("refuses a request with a field it does not name", async () => {
    const h = await linkedHarness();
    expect((await h.post("/v1/cloud-cli/aws/point", { ...pointer, value: "x" })).status).toBe(400);
    expect((await h.post("/v1/cloud-cli/aws/session", { cloud: "aws" })).status).toBe(400);
  });
});
