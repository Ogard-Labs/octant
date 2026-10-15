import { describe, expect, it } from "vitest";
import type { RemoteServerGrantSource } from "@octant/contracts";
import { RemoteConnectionError, type RemoteSessionFacts } from "./remoteConnection";
import { createRemoteServerProxyClient } from "./remoteServerProxyClient";

const ORIGIN = "https://192.168.1.20:9443";
const GRANT_ID = `rsg_${"ab".repeat(32)}`;
const OTHER_GRANT_ID = `rsg_${"cd".repeat(32)}`;
const THREAD_ID = "77777777-7777-4777-8777-777777777777";
const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SOURCE: RemoteServerGrantSource = {
  surface: "running-services",
  listenerId: `lsn_${"0".repeat(31)}1`,
} as RemoteServerGrantSource;

function facts(sessionId: string): RemoteSessionFacts {
  return {
    hostId: "11111111-1111-4111-8111-111111111111",
    deviceId: "22222222-2222-4222-8222-222222222222",
    sessionId,
    credentialGeneration: 1,
    origin: ORIGIN,
    protocolVersion: 1,
    authenticationVersion: 1,
    capabilityDigest: "a".repeat(64),
    csrfToken: `csrf-${sessionId}`,
    issuedAt: "2026-10-15T09:00:00.000Z",
    idleExpiresAt: "2026-10-15T09:15:00.000Z",
    absoluteExpiresAt: "2026-10-15T17:00:00.000Z",
  };
}

function opened(grantId = GRANT_ID): Response {
  return Response.json({
    kind: "remote-server-grant-opened",
    requestId: "33333333-3333-4333-8333-333333333333",
    grant: { grantId, threadId: THREAD_ID, port: 5173 },
  });
}

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function harness(answers: Array<Response | Error>, sessions: Array<RemoteSessionFacts | Error>) {
  const sent: Sent[] = [];
  const signed: string[] = [];
  let issued = 0;
  const client = createRemoteServerProxyClient({
    origin: ORIGIN,
    hostName: "Studio Mac",
    fetch: async (input, init) => {
      sent.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      const next = answers.shift();
      if (next === undefined) throw new Error("No answer left.");
      if (next instanceof Error) throw next;
      return next;
    },
    issueSession: async () => {
      issued += 1;
      const next = sessions.shift();
      if (next === undefined) throw new Error("No session left.");
      if (next instanceof Error) throw next;
      return next;
    },
    sign: async (payload) => {
      signed.push(payload);
      return "signature";
    },
  });
  return { client, sent, signed, issued: () => issued };
}

function proofOf(headers: Readonly<Record<string, string>>): Record<string, unknown> {
  const encoded = headers["x-octant-device-proof"] ?? "";
  const json = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return JSON.parse(json) as Record<string, unknown>;
}

describe("a device's grants to open another computer's dev server", () => {
  it("mints a proxy session and asks for the grant under it, with the proxy cookie and proof", async () => {
    const { client, sent } = harness([opened()], [facts("proxy-1")]);
    const opening = await client.openGrant(SOURCE);
    expect(opening).toEqual({
      status: "opened",
      grant: { grantId: GRANT_ID, threadId: THREAD_ID, port: 5173 },
    });
    expect(sent[0]?.url).toBe(`${ORIGIN}/api/server-proxy/grants`);
    expect(sent[0]?.headers).toMatchObject({
      origin: ORIGIN,
      cookie: "__Secure-octant-server-proxy-session=proxy-1",
      "x-octant-csrf": "csrf-proxy-1",
    });
    expect(proofOf(sent[0]?.headers ?? {})).toMatchObject({
      method: "POST",
      canonicalPathQuery: "/api/server-proxy/grants",
    });
  });

  it("shows the host's own refusal in the host's words", async () => {
    const { client } = harness(
      [
        Response.json({
          kind: "remote-server-grant-refused",
          requestId: "33333333-3333-4333-8333-333333333333",
          refusal: { reason: "not-octant-owned", message: "Octant didn't start this server." },
        }),
      ],
      [facts("proxy-1")],
    );
    expect(await client.openGrant(SOURCE)).toEqual({
      status: "refused",
      reason: "not-octant-owned",
      message: "Octant didn't start this server.",
    });
  });

  it("refuses with a reason when the host revoked this device", async () => {
    const revokedAnswer = harness(
      [Response.json({ reasonCode: "revoked" }, { status: 401 })],
      [facts("proxy-1")],
    );
    expect(await revokedAnswer.client.openGrant(SOURCE)).toEqual({
      status: "refused",
      reason: "device-revoked",
      message:
        "This computer no longer has access to Studio Mac. Pair it again to open servers there.",
    });
    const revokedSession = harness(
      [],
      [new RemoteConnectionError("unauthorized", "revoked", "revoked")],
    );
    expect((await revokedSession.client.openGrant(SOURCE)).status).toBe("refused");
    expect(revokedSession.sent).toEqual([]);
  });

  it("refuses with a reason when the host cannot be reached or is busy", async () => {
    const offline = harness([new TypeError("fetch failed")], [facts("proxy-1")]);
    expect(await offline.client.openGrant(SOURCE)).toMatchObject({
      status: "refused",
      reason: "host-unreachable",
    });
    const busy = harness([new Response("", { status: 503 })], [facts("proxy-1")]);
    expect(await busy.client.openGrant(SOURCE)).toMatchObject({
      status: "refused",
      reason: "host-busy",
    });
  });

  it("mints a new session once when the host forgot the old one, and drops the old grants", async () => {
    const { client, issued } = harness(
      [opened(), new Response("{}", { status: 401 }), opened(OTHER_GRANT_ID)],
      [facts("proxy-1"), facts("proxy-2")],
    );
    await client.openGrant(SOURCE);
    expect(await client.openGrant(SOURCE)).toMatchObject({ status: "opened" });
    expect(issued()).toBe(2);
    expect(
      await client.signRelayRequest({
        grantId: GRANT_ID,
        method: "GET",
        pathQuery: `/api/server-proxy/${GRANT_ID}/`,
        bodyDigest: DIGEST,
      }),
    ).toEqual({ status: "refused", reason: "grant-not-held" });
  });
});

describe("signing a page's request", () => {
  async function holding() {
    const built = harness([opened()], [facts("proxy-1")]);
    await built.client.openGrant(SOURCE);
    return built;
  }

  it("signs a request on the proxy route of a grant it holds", async () => {
    const { client } = await holding();
    const signing = await client.signRelayRequest({
      grantId: GRANT_ID,
      method: "POST",
      pathQuery: `/api/server-proxy/${GRANT_ID}/api/items?b=2&a=1`,
      bodyDigest: DIGEST,
    });
    expect(signing.status).toBe("signed");
    if (signing.status !== "signed") return;
    expect(signing.headers.cookie).toBe("__Secure-octant-server-proxy-session=proxy-1");
    expect(signing.headers["x-octant-csrf"]).toBe("csrf-proxy-1");
    expect(proofOf(signing.headers)).toMatchObject({
      method: "POST",
      canonicalPathQuery: `/api/server-proxy/${GRANT_ID}/api/items?a=1&b=2`,
      bodyDigest: DIGEST,
    });
  });

  it("refuses anything but the proxy route of a grant it holds", async () => {
    const { client, signed } = await holding();
    const before = signed.length;
    const refusals = await Promise.all([
      client.signRelayRequest({
        grantId: OTHER_GRANT_ID,
        method: "GET",
        pathQuery: `/api/server-proxy/${OTHER_GRANT_ID}/`,
        bodyDigest: DIGEST,
      }),
      client.signRelayRequest({
        grantId: GRANT_ID,
        method: "GET",
        pathQuery: "/api/code/bootstrap",
        bodyDigest: DIGEST,
      }),
      client.signRelayRequest({
        grantId: GRANT_ID,
        method: "POST",
        pathQuery: `/api/server-proxy/${GRANT_ID}/../grants`,
        bodyDigest: DIGEST,
      }),
      client.signRelayRequest({
        grantId: GRANT_ID,
        method: "GET",
        pathQuery: `/api/server-proxy/${OTHER_GRANT_ID}/`,
        bodyDigest: DIGEST,
      }),
      client.signRelayRequest({
        grantId: GRANT_ID,
        method: "GET",
        pathQuery: `/api/server-proxy/${GRANT_ID}/`,
        bodyDigest: "not-a-digest",
      }),
    ]);
    expect(refusals.map((refusal) => refusal.status === "refused" && refusal.reason)).toEqual([
      "grant-not-held",
      "outside-grant",
      "outside-grant",
      "outside-grant",
      "invalid-request",
    ]);
    expect(signed.length).toBe(before);
  });

  it("signs nothing after the host is forgotten", async () => {
    const { client } = await holding();
    client.forget();
    expect(
      await client.signRelayRequest({
        grantId: GRANT_ID,
        method: "GET",
        pathQuery: `/api/server-proxy/${GRANT_ID}/`,
        bodyDigest: DIGEST,
      }),
    ).toEqual({ status: "refused", reason: "grant-not-held" });
  });
});
