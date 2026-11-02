import { Server } from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCredentialBroker, type CredentialBroker } from "./credentialBroker";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { makeLinkedSecretStores } from "./linkedSecretStores";

const email = "command-account@example-project.iam.gserviceaccount.com";
const reference = "op://Private/Cloud service account/credential";
const scopes = ["https://www.googleapis.com/auth/cloud-platform.read-only"];
const pointer = { store: "onepassword", reference, serviceAccountEmail: email, scopes };
const now = Date.parse("2026-11-02T23:00:00.000Z");
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" });
const material = JSON.stringify({
  type: "service_account",
  client_email: email,
  private_key: privateKey,
  private_key_id: "fixture-key",
  token_uri: "https://untrusted.invalid/token",
  sub: "never-impersonate@example.com",
});
const directories: string[] = [];
const brokers: CredentialBroker[] = [];
// The sandbox cannot bind even loopback. Only the HTTP listener is substituted;
// requests below still cross the real broker's authenticated fetchForTest boundary.
beforeEach(() => {
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
    queueMicrotask(() => this.emit("listening"));
    return this;
  });
  vi.spyOn(Server.prototype, "address").mockReturnValue({
    address: "127.0.0.1",
    family: "IPv4",
    port: 13773,
  });
});
afterEach(async () => {
  try {
    await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  } finally {
    vi.restoreAllMocks();
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});

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
async function harness(timeoutMs = 10000) {
  const clock = { now };
  const directory = await mkdtemp(join(tmpdir(), "octant-google-cli-"));
  directories.push(directory);
  const item = {
    value: material,
    status: "read" as "read" | "locked",
    reads: 0,
    gate: Promise.resolve(),
  };
  const linked = makeLinkedSecretStores({
    statePath: join(directory, "linked.json"),
    adapters: [
      {
        kind: "onepassword",
        label: "Fixture linked store",
        isValidReference: (value) => value.startsWith("op://"),
        probe: async () => "ready",
        read: async (requested) => {
          item.reads += 1;
          await item.gate;
          return requested !== reference
            ? { status: "missing" }
            : item.status === "locked"
              ? { status: "locked" }
              : { status: "read", value: item.value };
        },
      },
    ],
  });
  await linked.link("onepassword");
  const requests: { url: string; init?: RequestInit }[] = [];
  const endpoint = {
    status: 200,
    gate: Promise.resolve(),
    body: { access_token: "fixture-short-token-12345", token_type: "Bearer", expires_in: 3600 },
  };
  const fetchPort = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    await endpoint.gate;
    return Response.json(endpoint.body, { status: endpoint.status });
  });
  const store = memoryStore();
  const broker = await startCredentialBroker(
    store,
    undefined,
    { fetch: fetchPort, now: () => clock.now, timeoutMs },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    linked,
  );
  brokers.push(broker);
  const post = async (operation: string, body: unknown = {}) => {
    const response = await broker.fetchForTest(
      new Request(new URL(`/v1/cloud-cli/google/${operation}`, broker.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": broker.token,
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  return { post, requests, endpoint, item, linked, clock, directory, broker };
}

describe("Google command-line sessions from an explicitly selected linked account", () => {
  it("keeps pending and cached sessions unusable after clear, expiry, or unlink", async () => {
    const h = await harness();
    await h.post("point", pointer);
    const gate = Promise.withResolvers<void>();
    h.endpoint.gate = gate.promise;
    const pending = h.post("session");
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    await h.post("clear");
    gate.resolve();
    expect((await pending).body).toEqual({ status: "none" });
    await h.post("point", pointer);
    expect((await h.post("session")).body).toMatchObject({ status: "issued" });
    h.clock.now += 3600000;
    expect((await h.post("session")).body).toMatchObject({ status: "issued" });
    expect(h.requests).toHaveLength(3);
    await h.linked.unlink("onepassword");
    expect((await h.post("session")).body).toEqual({ status: "not-linked" });
  });
  it("does not exchange an old account's late linked item after it was cleared", async () => {
    const h = await harness();
    await h.post("point", pointer);
    const gate = Promise.withResolvers<void>();
    h.item.gate = gate.promise;
    const before = h.item.reads;
    const pending = h.post("session");
    await vi.waitFor(() => expect(h.item.reads).toBeGreaterThan(before));
    await h.post("clear");
    gate.resolve();
    expect((await pending).body).toEqual({ status: "none" });
    expect(h.requests).toHaveLength(0);
  });
  it("bounds a non-answering linked store and token endpoint without a late grant", async () => {
    const h = await harness(50);
    const blocked = Promise.withResolvers<void>();
    h.item.gate = blocked.promise;
    expect((await h.post("point", pointer)).body).toEqual({ status: "unavailable" });
    blocked.resolve();
    expect((await h.post("reference")).body).toEqual({ status: "none" });
    await h.post("point", pointer);
    const endpoint = Promise.withResolvers<void>();
    h.endpoint.gate = endpoint.promise;
    expect((await h.post("session")).body).toEqual({ status: "unavailable" });
    endpoint.resolve();
    await h.post("clear");
    expect((await h.post("session")).body).toEqual({ status: "none" });
  });
  it.each(["wrong-account", "delegated-kind", "invalid-key"])(
    "refuses %s material without an exchange",
    async (failure) => {
      const h = await harness();
      const account = JSON.parse(material);
      if (failure === "wrong-account")
        account.client_email = "other@example.iam.gserviceaccount.com";
      if (failure === "delegated-kind") account.type = "authorized_user";
      if (failure === "invalid-key") account.private_key = "not a signing key";
      h.item.value = JSON.stringify(account);
      expect((await h.post("point", pointer)).body).toEqual({ status: "refused" });
      expect((await h.post("reference")).body).toEqual({ status: "none" });
      expect(h.requests).toHaveLength(0);
    },
  );
  it("refuses a token response whose scopes disagree with the person's selection", async () => {
    const h = await harness();
    await h.post("point", pointer);
    h.endpoint.body.scope = "https://www.googleapis.com/auth/cloud-platform";
    expect((await h.post("session")).body).toEqual({ status: "refused" });
  });
  it("preserves independent pointer and unlink writes in the same real metadata file", async () => {
    const h = await harness();
    const aws = {
      store: "onepassword" as const,
      accessKeyIdReference: "op://Private/AWS/id",
      secretAccessKeyReference: "op://Private/AWS/key",
    };
    await Promise.all([
      h.linked.setGoogleCliPointer?.({ ...pointer, store: "onepassword" }),
      h.linked.setAwsCliPointer(aws),
    ]);
    expect(await h.linked.googleCliPointer?.()).toEqual(pointer);
    expect(await h.linked.awsCliPointer()).toEqual(aws);
    await Promise.all([
      h.linked.setGoogleCliPointer?.({ ...pointer, store: "onepassword" }),
      h.linked.unlink("onepassword"),
    ]);
    expect(await h.linked.isLinked("onepassword")).toBe(false);
    expect(await h.linked.googleCliPointer?.()).toEqual(pointer);
  });
  it("does not resurrect a pending account selection after the person cleared it", async () => {
    const h = await harness();
    expect((await h.post("point", pointer)).body).toEqual({ status: "pointed" });
    const gate = Promise.withResolvers<void>();
    h.item.gate = gate.promise;
    const before = h.item.reads;
    const pending = h.post("point", {
      ...pointer,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    await vi.waitFor(() => expect(h.item.reads).toBeGreaterThan(before));
    expect((await h.post("clear")).body).toMatchObject({ status: "cleared" });
    gate.resolve();
    expect((await pending).body).toMatchObject({ status: "superseded" });
    expect((await h.post("reference")).body).toEqual({ status: "none" });
  });
  it("keeps the exact account/scopes pointer and returns only its short-lived token from a fixed exchange", async () => {
    const h = await harness();
    expect(await h.post("point", pointer)).toEqual({ status: 200, body: { status: "pointed" } });
    expect(await h.post("reference")).toEqual({
      status: 200,
      body: { status: "linked", ...pointer },
    });
    const session = await h.post("session");
    expect(session).toEqual({
      status: 200,
      body: {
        status: "issued",
        accessToken: "fixture-short-token-12345",
        expiration: new Date(now + 3600000).toISOString(),
        serviceAccountEmail: email,
        scopes,
      },
    });
    expect(JSON.stringify(session)).not.toContain("PRIVATE KEY");
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0];
    expect(request?.url).toBe("https://oauth2.googleapis.com/token");
    expect(request?.init?.redirect).toBe("error");
    const body = new URLSearchParams(String(request?.init?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = body.get("assertion") ?? "";
    const [header, claims, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "fixture-key",
    });
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({
      iss: email,
      scope: scopes.join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${claims}`),
        key.publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });
});
