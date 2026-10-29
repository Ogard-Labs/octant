import {
  NO_LISTENER_PIN,
  type HubMemberId,
  type NewMemberAlert,
  type NewMemberAlertId,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import {
  ownerActionNotice,
  readOwnerAlerts,
  runOwnerAlertAction,
  type PinnedListenerTransportPort,
  type RemoteDeviceKeyPair,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import type { GuestHubState } from "./hubGuestFlow";
import { ownerSpokesOf } from "./ownerFlow";
import { createPhoneUnlockKey } from "./ownerUnlockKey";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}` as HubMemberId;
const alert: NewMemberAlert = {
  alertId: "00000000-0000-4000-8000-0000000000a1" as NewMemberAlertId,
  memberId: id("7"),
  name: "Unknown tablet",
  role: "spoke",
  identityKeyFingerprint: "c".repeat(64),
  raisedAt: "2026-10-29T10:00:00.000Z" as NewMemberAlert["raisedAt"],
};

const member = (suffix: string, role: RosterMember["role"], address: string): RosterMember => ({
  memberId: id(suffix),
  name: `member ${suffix}`,
  role,
  identityKeyFingerprint: suffix.repeat(64).slice(0, 64),
  listenerPin: role === "guest" ? NO_LISTENER_PIN : "b".repeat(64),
  privateNames: [],
  addresses: role === "guest" ? [] : [address],
  listenerPort: 8443,
  owner: false,
});

function joinedState(owner: boolean): GuestHubState {
  const roster: SignedHubRoster = {
    roster: {
      sequence: 2,
      members: [
        member("1", "hub", "100.101.102.103"),
        member("9", "guest", ""),
        member("2", "spoke", "100.101.102.104"),
        member("3", "spoke", "100.101.102.105"),
      ],
      standbyOrder: [],
      failoverAfterSeconds: 300,
    },
    signedBy: { kind: "hub", memberId: id("1") },
    signature: "signature",
  };
  return {
    record: {
      hub: {
        memberId: String(id("1")),
        name: "Mac mini",
        origin: "https://100.101.102.103:8443",
        pin: "sha256-HUB",
        rosterSigningPublicKey: "key",
      },
      selfMemberId: String(id("9")),
      deviceKeyId: "paired-key",
      roster,
    },
    deviceLabel: "Phone",
    spokes: [],
    notAccepted: [],
    ...(owner ? { owner: true as const } : {}),
  };
}

async function world(
  options: { presence: "confirmed" | "denied"; down?: string } = { presence: "confirmed" },
) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const deviceKeyStore: RemoteDeviceKeyStore = {
    set: async () => "paired-key",
    get: async (): Promise<RemoteDeviceKeyPair | undefined> => keyPair,
    updateMetadata: async () => {},
    removeOtherApprovedForOrigin: async () => {},
    findByOrigin: async () => undefined,
    remove: async () => {},
  };
  const order: string[] = [];
  let storedPrivate: string | undefined;
  let storedPublic: string | null = null;
  const unlockKey = createPhoneUnlockKey({
    vault: {
      read: async () => {
        order.push("key-read");
        return storedPrivate === undefined
          ? { status: "missing" }
          : { status: "read", pkcs8: storedPrivate };
      },
      write: async (value) => {
        storedPrivate = value;
      },
      remove: async () => {},
    },
    publicKey: {
      get: async () => storedPublic,
      set: async (value) => {
        storedPublic = value;
      },
      remove: async () => {},
    },
    presence: {
      authenticate: async () => {
        order.push("unlock-asked");
        return options.presence;
      },
    },
  });
  await unlockKey.ensure();
  const transport: PinnedListenerTransportPort = ({ origin }) => ({
    status: "available",
    fetch: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      order.push(path);
      if (options.down !== undefined && origin.includes(options.down)) throw new Error("down");
      if (path === "/api/hub/owner/challenge") {
        return Response.json({
          challenge: {
            challengeId: "00000000-0000-4000-8000-0000000000c1",
            nonce: "nonce",
            expiresAt: 1_900_000_000_000,
          },
        });
      }
      if (path === "/api/hub/owner/alerts") return Response.json({ alerts: [alert] });
      return Response.json({ status: "removed", alertId: String(alert.alertId) });
    }) as typeof globalThis.fetch,
  });
  return { deviceKeyStore, unlockKey, transport, order };
}

describe("a phone that is an owner of its hub", () => {
  it("offers no owner actions to a phone that did not join with an owner code", async () => {
    const w = await world();
    expect(await ownerSpokesOf({ ...w, state: joinedState(false) })).toEqual([]);
  });

  it("asks for the unlock before it sends the action it was asked for", async () => {
    const w = await world();
    const [spoke] = await ownerSpokesOf({ ...w, state: joinedState(true) });
    if (spoke === undefined) throw new Error("expected an owner client");
    w.order.length = 0;

    const result = await runOwnerAlertAction(spoke, alert, "remove");

    expect(result.status).toBe("done");
    expect(w.order).toEqual([
      "/api/hub/owner/challenge",
      "unlock-asked",
      "key-read",
      "/api/hub/owner/alerts/remove",
    ]);
  });

  it("sends no action and reads no key when the person declines the unlock", async () => {
    const w = await world({ presence: "denied" });
    const [spoke] = await ownerSpokesOf({ ...w, state: joinedState(true) });
    if (spoke === undefined) throw new Error("expected an owner client");
    w.order.length = 0;

    const result = await runOwnerAlertAction(spoke, alert, "remove");

    expect(w.order).toEqual(["/api/hub/owner/challenge", "unlock-asked"]);
    expect(ownerActionNotice(result, "Removed.")).toEqual({
      tone: "problem",
      message: "Nothing changed. The unlock was cancelled.",
    });
  });

  it("lists each computer's alerts and names a computer that did not answer", async () => {
    const w = await world({ presence: "confirmed", down: "100.101.102.105" });
    const spokes = await ownerSpokesOf({ ...w, state: joinedState(true) });

    const reading = await readOwnerAlerts(spokes);

    expect(reading.rows.map((row) => [row.spoke.name, row.alert.name])).toEqual([
      ["member 2", "Unknown tablet"],
    ]);
    expect(reading.unanswered).toEqual(["member 3"]);
  });

  it("tells the person a used unlock was refused and to unlock again", () => {
    expect(
      ownerActionNotice({ status: "refused", kind: "unlock-no-such-challenge" }, "Removed."),
    ).toEqual({
      tone: "problem",
      message: "That unlock was already used or never issued. Unlock again for this action.",
    });
  });
});
