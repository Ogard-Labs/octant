import { describe, expect, it } from "vitest";
import {
  NO_LISTENER_PIN,
  type HubMemberId,
  type HubRoster,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import { buildPairingCode, hubRosterSigningPayload } from "@octant/domain";
import {
  acceptGuestRoster,
  admitGuestOnSpoke,
  createGuestSigner,
  guestSpokeTargets,
  joinHubAsGuest,
  joinHubAsGuestAtOrigin,
  type GuestHubRecord,
} from "./hubGuestClient";
import type { PinnedListenerTransportPort } from "./appPairingCode";
import { HOST_KEY, signTestHostHello } from "./remoteConnectionFixtures";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}` as HubMemberId;
const hubId = id("1");
const guestId = id("3");
const digest = (character: string) => character.repeat(64);

const encode = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

async function newKey() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
}

async function signRoster(
  roster: HubRoster,
  key: CryptoKeyPair,
  signedBy: SignedHubRoster["signedBy"] = { kind: "hub", memberId: hubId },
): Promise<SignedHubRoster> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(hubRosterSigningPayload(roster)),
  );
  return { roster, signedBy, signature: encode(signature) };
}

const member = (suffix: string, role: RosterMember["role"], extra: Partial<RosterMember> = {}) =>
  ({
    memberId: id(suffix),
    name: `member ${suffix}`,
    role,
    identityKeyFingerprint: digest("a"),
    listenerPin: role === "guest" ? NO_LISTENER_PIN : digest("b"),
    privateNames: [],
    addresses: [],
    owner: false,
    ...extra,
  }) satisfies RosterMember;

const rosterAt = (sequence: number, ...members: ReadonlyArray<RosterMember>): HubRoster => ({
  sequence,
  members,
  standbyOrder: [],
  failoverAfterSeconds: 300,
});

async function heldRecord(hubKey: CryptoKeyPair): Promise<GuestHubRecord> {
  return {
    hub: {
      memberId: String(hubId),
      name: "Mac mini",
      origin: "https://100.101.102.103:8443",
      pin: "sha256-AAAA",
      rosterSigningPublicKey: encode(await crypto.subtle.exportKey("spki", hubKey.publicKey)),
    },
    selfMemberId: String(guestId),
    deviceKeyId: "key-1",
    roster: await signRoster(
      rosterAt(
        2,
        member("1", "hub", { addresses: ["100.101.102.103"], listenerPort: 8443 }),
        member("3", "guest"),
      ),
      hubKey,
    ),
  };
}

describe("a guest checking the roster the hub sent", () => {
  it("accepts a newer roster signed with the hub key it recorded at join", async () => {
    const hubKey = await newKey();
    const record = await heldRecord(hubKey);
    const candidate = await signRoster(
      rosterAt(3, ...record.roster.roster.members, member("2", "spoke")),
      hubKey,
    );

    const accepted = await acceptGuestRoster({ record, candidate });

    expect(accepted.status).toBe("accepted");
    if (accepted.status === "accepted") {
      expect(accepted.record.roster.roster.members).toHaveLength(3);
      expect(record.roster.roster.sequence).toBe(2);
    }
  });

  it("refuses a roster signed with any other key, even one that names the hub", async () => {
    const hubKey = await newKey();
    const record = await heldRecord(hubKey);
    const candidate = await signRoster(rosterAt(3, member("1", "hub")), await newKey());

    expect(await acceptGuestRoster({ record, candidate })).toEqual({
      status: "refused",
      kind: "signature-invalid",
    });
  });

  it("refuses a roster whose members were changed after the hub signed it", async () => {
    const hubKey = await newKey();
    const record = await heldRecord(hubKey);
    const signed = await signRoster(rosterAt(3, ...record.roster.roster.members), hubKey);
    const candidate: SignedHubRoster = {
      ...signed,
      roster: { ...signed.roster, members: [...signed.roster.members, member("9", "spoke")] },
    };

    expect(await acceptGuestRoster({ record, candidate })).toEqual({
      status: "refused",
      kind: "signature-invalid",
    });
  });

  it("refuses an older roster and a different roster at the sequence it holds", async () => {
    const hubKey = await newKey();
    const record = await heldRecord(hubKey);
    const older = await signRoster(rosterAt(1, member("1", "hub")), hubKey);
    const sameSequence = await signRoster(rosterAt(2, member("1", "hub")), hubKey);

    expect(await acceptGuestRoster({ record, candidate: older })).toEqual({
      status: "refused",
      kind: "stale-sequence",
    });
    expect(await acceptGuestRoster({ record, candidate: sameSequence })).toEqual({
      status: "refused",
      kind: "stale-sequence",
    });
  });

  it("keeps the roster it holds when it is sent again", async () => {
    const hubKey = await newKey();
    const record = await heldRecord(hubKey);

    expect(await acceptGuestRoster({ record, candidate: record.roster })).toEqual({
      status: "unchanged",
      record,
    });
  });

  it("refuses a roster signed as a standby while it holds a roster that names none", async () => {
    const hubKey = await newKey();
    const record = await heldRecord(hubKey);
    const candidate = await signRoster(rosterAt(3, ...record.roster.roster.members), hubKey, {
      kind: "standby",
      memberId: id("2"),
    });

    expect(await acceptGuestRoster({ record, candidate })).toEqual({
      status: "refused",
      kind: "signature-invalid",
    });
  });

  it("refuses a roster signed by the hub key under a different hub's name", async () => {
    const hubKey = await newKey();
    const record = await heldRecord(hubKey);
    const candidate = await signRoster(rosterAt(3, ...record.roster.roster.members), hubKey, {
      kind: "hub",
      memberId: id("7"),
    });

    expect(await acceptGuestRoster({ record, candidate })).toEqual({
      status: "refused",
      kind: "signature-invalid",
    });
  });
});

describe("the members a guest connects to", () => {
  it("gives each spoke and the hub at the private address, port, and pin the roster names", async () => {
    const hubKey = await newKey();
    const record = {
      ...(await heldRecord(hubKey)),
      roster: await signRoster(
        rosterAt(
          4,
          member("1", "hub", { addresses: ["100.101.102.103"], listenerPort: 8443 }),
          member("2", "spoke", {
            privateNames: ["laptop.tail1234.ts.net"],
            addresses: ["100.101.102.104"],
            listenerPort: 9443,
          }),
          member("4", "spoke", { addresses: ["fd7a:115c:a1e0::1"] }),
          member("3", "guest"),
        ),
        hubKey,
      ),
    };

    const targets = guestSpokeTargets(record);

    expect(targets.map((target) => [target.name, target.origin])).toEqual([
      ["member 1", "https://100.101.102.103:8443"],
      ["member 2", "https://laptop.tail1234.ts.net:9443"],
      ["member 4", "https://[fd7a:115c:a1e0::1]"],
    ]);
    expect(targets[0]?.pin).toBe(
      `sha256-${encode(Uint8Array.from({ length: 32 }, () => 0xbb).buffer)}`,
    );
  });

  it("leaves out a member that names only a public address and never the guest itself", async () => {
    const hubKey = await newKey();
    const record = {
      ...(await heldRecord(hubKey)),
      roster: await signRoster(
        rosterAt(
          4,
          member("1", "hub", { addresses: ["203.0.113.7"] }),
          member("2", "spoke", { privateNames: ["laptop.example.com"] }),
          member("3", "guest"),
        ),
        hubKey,
      ),
    };

    expect(guestSpokeTargets(record)).toEqual([]);
  });
});

describe("a guest joining with an owner code", () => {
  const ORIGIN = "https://100.101.102.103:8443";
  const HUB_HOST_ID = "11111111-1111-4111-8111-111111111111";
  const PIN = `sha256-${Buffer.alloc(32, 9).toString("base64url")}`;

  /** A hub that approves the pairing at once and records the join request the guest sends. */
  async function joinBody(ownerUnlockPublicKey?: string): Promise<Record<string, unknown>> {
    const built = buildPairingCode({
      origin: ORIGIN,
      ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
      ticketProof: Buffer.alloc(32, 7).toString("base64url"),
      pin: PIN,
    });
    if (built.status !== "built") throw new Error(built.reason);
    let sent: Record<string, unknown> | undefined;
    const transport: PinnedListenerTransportPort = () => ({
      status: "available",
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        if (url.pathname === "/api/remote/hello") {
          return Response.json(
            signTestHostHello(HOST_KEY, {
              productId: "octant",
              hostId: HUB_HOST_ID,
              displayName: "Mac mini",
              serverBuildVersion: "0.1.0",
              supportedProtocolRange: { min: 1, max: 1 },
              authenticationProtocolVersions: [1],
              securityFloor: 1,
              remoteOrigin: ORIGIN,
              nonce: "host-nonce-1234567890",
              clientNonce: url.searchParams.get("clientNonce") ?? "",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
        }
        if (url.pathname === "/api/remote/pairing") {
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          return Response.json({
            kind: "pending",
            ticketId: body.ticketId,
            hostId: HUB_HOST_ID,
            deviceLabel: body.deviceLabel,
            deviceKeyFingerprint: body.deviceKeyFingerprint,
            origin: ORIGIN,
            sourceClass: "tailscale",
            comparisonCode: "123456",
            claimedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          });
        }
        if (url.pathname === "/api/hub/join") {
          sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ status: "refused", kind: "not-approved" }, { status: 403 });
        }
        return Response.json({
          status: "approved",
          deviceId: "00000000-0000-4000-8000-000000000002",
          credentialGeneration: 1,
        });
      },
    });

    const started = await joinHubAsGuest({
      code: built.code,
      deviceLabel: "Phone",
      transport,
      webBuildVersion: "0.1.0",
      deviceKeyStore: createInMemoryDeviceKeyStore(),
      ...(ownerUnlockPublicKey === undefined ? {} : { ownerUnlockPublicKey }),
    });
    if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
    await started.finish();
    if (sent === undefined) throw new Error("The guest sent no join request.");
    return sent;
  }

  it("sends the unlock key it made so the hub can record it as an owner's", async () => {
    const body = await joinBody("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE");

    expect(body).toMatchObject({
      asGuest: true,
      ownerUnlockPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
    });
  });

  it("sends no unlock key when the person did not choose an owner code", async () => {
    expect(await joinBody()).not.toHaveProperty("ownerUnlockPublicKey");
  });
});

describe("a browser guest joining over the origin that served the page", () => {
  const PAGE = "https://hub.tail1234.ts.net:8443";
  const HUB_HOST_ID = "11111111-1111-4111-8111-111111111111";

  it("reaches the hub only at that origin under the platform's certificate check and sends its owner key", async () => {
    const calls: Array<{ origin: string; trust: string; path: string }> = [];
    let sent: Record<string, unknown> | undefined;
    const transport: PinnedListenerTransportPort = ({ origin, trust }) => ({
      status: "available",
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        calls.push({ origin, trust: trust.current.kind, path: url.pathname });
        if (url.pathname === "/api/remote/hello") {
          return Response.json(
            signTestHostHello(HOST_KEY, {
              productId: "octant",
              hostId: HUB_HOST_ID,
              displayName: "Mac mini",
              serverBuildVersion: "0.1.0",
              supportedProtocolRange: { min: 1, max: 1 },
              authenticationProtocolVersions: [1],
              securityFloor: 1,
              remoteOrigin: PAGE,
              nonce: "host-nonce-1234567890",
              clientNonce: url.searchParams.get("clientNonce") ?? "",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
        }
        if (url.pathname === "/api/remote/pairing") {
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          return Response.json({
            kind: "pending",
            ticketId: body.ticketId,
            hostId: HUB_HOST_ID,
            deviceLabel: body.deviceLabel,
            deviceKeyFingerprint: body.deviceKeyFingerprint,
            origin: PAGE,
            sourceClass: "tailscale",
            comparisonCode: "123456",
            claimedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          });
        }
        if (url.pathname === "/api/hub/join") {
          sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ status: "refused", kind: "not-approved" }, { status: 403 });
        }
        return Response.json({
          status: "approved",
          deviceId: "00000000-0000-4000-8000-000000000002",
          credentialGeneration: 1,
        });
      },
    });

    const started = await joinHubAsGuestAtOrigin({
      origin: PAGE,
      ticket: {
        ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
        ticketProof: Buffer.alloc(32, 7).toString("base64url"),
      },
      deviceLabel: "Laptop browser",
      transport,
      webBuildVersion: "0.1.0",
      deviceKeyStore: createInMemoryDeviceKeyStore(),
      ownerUnlockPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
    });
    if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
    await started.finish();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.origin === PAGE && call.trust === "platform")).toBe(true);
    expect(calls.map((call) => call.path)).toContain("/api/hub/join");
    expect(sent).toMatchObject({
      asGuest: true,
      ownerUnlockPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
    });
  });
});

describe("a guest asking a spoke to admit it", () => {
  it("signs the request with its device key and sends it straight to the spoke held to the roster's pin", async () => {
    const signer = await createGuestSigner({ memberId: String(guestId), keyPair: await newKey() });
    const seen: Array<{
      readonly origin: string;
      readonly pin: string | undefined;
      readonly url: string;
      readonly header: string | null;
      readonly body: unknown;
    }> = [];
    const transport: PinnedListenerTransportPort = ({ origin, trust }) => ({
      status: "available",
      fetch: async (input, init) => {
        seen.push({
          origin,
          pin: trust.current.kind === "pinned" ? trust.current.pin : undefined,
          url: String(input),
          header: new Headers(init?.headers).get("x-octant-hub-link"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(
          { spokeMemberId: String(id("2")), deviceId: "11111111-1111-4111-8111-111111111111" },
          { status: 201 },
        );
      },
    });

    const admitted = await admitGuestOnSpoke({
      target: {
        memberId: String(id("2")),
        name: "Laptop",
        role: "spoke",
        origin: "https://100.101.102.104:8443",
        pin: "sha256-PIN",
      },
      signer,
      deviceLabel: "Phone",
      transport,
      now: () => 1_700_000_000_000,
    });

    expect(admitted).toMatchObject({ status: "admitted", spokeMemberId: String(id("2")) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      origin: "https://100.101.102.104:8443",
      pin: "sha256-PIN",
      url: "https://100.101.102.104:8443/api/hub/guest",
      body: { memberId: String(guestId), devicePublicKey: signer.publicKey, deviceLabel: "Phone" },
    });
    expect(seen[0]?.header).toMatch(
      new RegExp(`^v1\\.${String(guestId)}\\.1700000000000\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`),
    );
  });

  it("reports the spoke's refusal as it was said and an unreachable spoke as unreachable", async () => {
    const signer = await createGuestSigner({ memberId: String(guestId), keyPair: await newKey() });
    const target = {
      memberId: String(id("2")),
      name: "Laptop",
      role: "spoke" as const,
      origin: "https://100.101.102.104:8443",
      pin: "sha256-PIN",
    };

    const refused = await admitGuestOnSpoke({
      target,
      signer,
      deviceLabel: "Phone",
      transport: () => ({
        status: "available",
        fetch: async () =>
          Response.json({ status: "refused", kind: "guest-not-accepted" }, { status: 403 }),
      }),
    });
    const unreachable = await admitGuestOnSpoke({
      target,
      signer,
      deviceLabel: "Phone",
      transport: () => ({
        status: "available",
        fetch: async () => {
          throw new Error("down");
        },
      }),
    });

    expect(refused).toEqual({ status: "refused", httpStatus: 403, kind: "guest-not-accepted" });
    expect(unreachable).toEqual({ status: "unreachable" });
  });
});
