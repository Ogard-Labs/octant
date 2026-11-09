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
import { describe, expect, it, vi } from "vitest";
import type { GuestHubState } from "./hubGuestFlow";
import { pollWhileActive, type AppActivity } from "../runtime/pollWhileActive";
import { ownerSpokesOf, phoneOwnerMergeUnlock, phoneThreadMovesOf } from "./ownerFlow";
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

const TICKET = "00000000-0000-4000-8000-0000000000d1";
const heldMove = {
  confirmationId: "00000000-0000-4000-8000-0000000000e1",
  destinationMemberId: "00000000-0000-4000-8000-000000000003",
  destinationName: "member 3",
  threads: [
    {
      thread: { mode: "chat", threadId: "00000000-0000-4000-8000-0000000000f1" },
      title: "Plan the trip",
    },
  ],
  expiresAt: 1_900_000_000_000,
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
  options: {
    presence: "confirmed" | "denied";
    down?: string;
    /** Whether the spoke holds a move right now; it always does unless this says otherwise. */
    holdsMove?: () => boolean;
    /** The address of the computer that holds the move; member 2 unless this says otherwise. */
    holdingAddress?: string;
  } = { presence: "confirmed" },
) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const deviceKeyStore: RemoteDeviceKeyStore = {
    set: async () => "paired-key",
    get: async (): Promise<RemoteDeviceKeyPair | undefined> => keyPair,
    copyKey: async () => "copied-key",
    updateMetadata: async () => {},
    removeOtherApprovedForOrigin: async () => {},
    findByOrigin: async () => undefined,
    remove: async () => {},
  };
  const order: string[] = [];
  const sentTo: Array<{ readonly origin: string; readonly path: string }> = [];
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
      sentTo.push({ origin, path });
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
      if (path === "/api/hub/owner/thread-moves/confirmations") {
        return Response.json({
          status: "listed",
          confirmations:
            origin.includes(options.holdingAddress ?? "100.101.102.104") &&
            (options.holdsMove?.() ?? true)
              ? [heldMove]
              : [],
        });
      }
      if (path === "/api/hub/owner/thread-moves/ticket") {
        return Response.json({ status: "issued", ticketId: TICKET, expiresAt: 1 });
      }
      if (path === "/api/hub/owner/thread-moves/confirm") {
        return Response.json({ status: "started" });
      }
      if (path === "/api/hub/owner/held-members") {
        return Response.json({
          members: [
            {
              memberId: String(alert.memberId),
              name: alert.name,
              role: alert.role,
              identityKeyFingerprint: alert.identityKeyFingerprint,
            },
          ],
        });
      }
      return Response.json({ status: "removed", alertId: String(alert.alertId) });
    }) as typeof globalThis.fetch,
  });
  return { deviceKeyStore, unlockKey, transport, order, sentTo };
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

    const result = await runOwnerAlertAction(spoke, { member: alert, alert }, "remove");

    expect(result.status).toBe("done");
    expect(w.order).toEqual([
      "unlock-asked",
      "key-read",
      "/api/hub/owner/challenge",
      "/api/hub/owner/alerts/remove",
    ]);
  });

  it("asks the person once to confirm a member, however many signatures the confirmation needs", async () => {
    const w = await world();
    const [spoke] = await ownerSpokesOf({ ...w, state: joinedState(true) });
    if (spoke === undefined) throw new Error("expected an owner client");
    w.order.length = 0;

    const result = await runOwnerAlertAction(spoke, { member: alert, alert }, "confirm");

    expect(result.status).toBe("done");
    expect(w.order.filter((entry) => entry === "unlock-asked")).toHaveLength(1);
    expect(w.order.filter((entry) => entry === "key-read")).toHaveLength(1);
    expect(w.order).toEqual([
      "unlock-asked",
      "key-read",
      "/api/hub/owner/challenge",
      "/api/hub/owner/confirm-member",
    ]);
  });

  it("sends no action and reads no key when the person declines the unlock", async () => {
    const w = await world({ presence: "denied" });
    const [spoke] = await ownerSpokesOf({ ...w, state: joinedState(true) });
    if (spoke === undefined) throw new Error("expected an owner client");
    w.order.length = 0;

    const result = await runOwnerAlertAction(spoke, { member: alert, alert }, "remove");

    expect(w.order).toEqual(["unlock-asked"]);
    expect(ownerActionNotice(result, "Removed.")).toEqual({
      tone: "problem",
      message: "Nothing changed. The unlock was cancelled.",
    });
  });

  it("lists each computer's alerts and names a computer that did not answer", async () => {
    const w = await world({ presence: "confirmed", down: "100.101.102.105" });
    const spokes = await ownerSpokesOf({ ...w, state: joinedState(true) });

    const reading = await readOwnerAlerts(spokes);

    expect(reading.rows.map((row) => [row.spoke.name, row.member.name, row.held])).toEqual([
      ["member 2", "Unknown tablet", true],
    ]);
    expect(reading.unanswered).toEqual(["member 3"]);
  });

  it("marks an alert as confirmable only when that computer holds the member", async () => {
    const w = await world();
    const spokes = await ownerSpokesOf({ ...w, state: joinedState(true) });
    const silent = spokes.map((spoke) => ({
      ...spoke,
      client: {
        ...spoke.client,
        heldMembers: async () => ({ status: "read" as const, members: [] }),
      },
    }));

    const reading = await readOwnerAlerts(silent);

    expect(reading.rows.map((row) => row.held)).toEqual([false, false]);
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

describe("a phone's unlock for a merge its paired host asks for", () => {
  const merge = { path: "/api/code/project-pull-requests/merge", body: '{"number":12}' };

  it("asks the person once and signs a challenge from the computer that asked", async () => {
    const w = await world();
    const unlock = phoneOwnerMergeUnlock({
      ...w,
      guestHubStore: { load: async () => joinedState(true) },
    });
    w.order.length = 0;

    const result = await unlock({ hostMemberId: String(id("2")), ...merge });

    expect(result.status).toBe("signed");
    expect(w.order).toEqual(["unlock-asked", "key-read", "/api/hub/owner/challenge"]);
  });

  it("does not ask the person when the phone is not an owner or the computer is not on its hub", async () => {
    const w = await world();
    const notOwner = phoneOwnerMergeUnlock({
      ...w,
      guestHubStore: { load: async () => joinedState(false) },
    });
    const owner = phoneOwnerMergeUnlock({
      ...w,
      guestHubStore: { load: async () => joinedState(true) },
    });
    w.order.length = 0;

    expect(await notOwner({ hostMemberId: String(id("2")), ...merge })).toEqual({
      status: "no-owner-device",
    });
    expect(await owner({ hostMemberId: String(id("8")), ...merge })).toEqual({
      status: "no-owner-device",
    });
    expect(w.order).toEqual([]);
  });

  it("merges nothing when the person declines Face ID", async () => {
    const w = await world({ presence: "denied" });
    const unlock = phoneOwnerMergeUnlock({
      ...w,
      guestHubStore: { load: async () => joinedState(true) },
    });
    w.order.length = 0;

    expect(await unlock({ hostMemberId: String(id("2")), ...merge })).toMatchObject({
      status: "not-unlocked",
    });
    expect(w.order).not.toContain("/api/hub/owner/challenge");
  });
});

describe("a phone confirming a move a window holds for it", () => {
  it("lists the moves each spoke holds and confirms one with a single unlock, asking the destination for the ticket first", async () => {
    const w = await world();
    const moves = await phoneThreadMovesOf({ ...w, state: joinedState(true) });
    if (moves === undefined) throw new Error("expected the phone's moves");

    const reading = await moves.read();
    expect(
      reading.moves.map((move) => [move.source.name, move.confirmation.destinationName]),
    ).toEqual([["member 2", "member 3"]]);
    const [held] = reading.moves;
    if (held === undefined) throw new Error("expected a held move");
    w.order.length = 0;
    w.sentTo.length = 0;

    const result = await moves.confirm(held);

    expect(result.status).toBe("done");
    expect(w.order.filter((entry) => entry === "unlock-asked")).toHaveLength(1);
    expect(w.sentTo.filter((entry) => entry.path !== "/api/hub/owner/challenge")).toEqual([
      { origin: "https://100.101.102.105:8443", path: "/api/hub/owner/thread-moves/ticket" },
      { origin: "https://100.101.102.104:8443", path: "/api/hub/owner/thread-moves/confirm" },
    ]);
  });

  it("lists a move a standby computer holds, and never asks the hub, which moves nothing away", async () => {
    const w = await world({ presence: "confirmed", holdingAddress: "100.101.102.106" });
    const joined = joinedState(true);
    const state: GuestHubState = {
      ...joined,
      record: {
        ...joined.record,
        roster: {
          ...joined.record.roster,
          roster: {
            ...joined.record.roster.roster,
            members: [
              ...joined.record.roster.roster.members,
              member("4", "standby-hub", "100.101.102.106"),
            ],
          },
        },
      },
    };
    const moves = await phoneThreadMovesOf({ ...w, state });
    if (moves === undefined) throw new Error("expected the phone's moves");
    w.sentTo.length = 0;

    const reading = await moves.read();

    expect(reading.moves.map((move) => move.source.name)).toEqual(["member 4"]);
    const asked = w.sentTo
      .filter((entry) => entry.path === "/api/hub/owner/thread-moves/confirmations")
      .map((entry) => entry.origin);
    expect(asked).toContain("https://100.101.102.106:8443");
    expect(asked).not.toContain("https://100.101.102.103:8443");
  });

  it("offers nothing to a phone that did not join with an owner code", async () => {
    const w = await world();
    expect(await phoneThreadMovesOf({ ...w, state: joinedState(false) })).toBeUndefined();
  });

  it("tells the source nothing when the person declines the unlock", async () => {
    const w = await world({ presence: "denied" });
    const moves = await phoneThreadMovesOf({ ...w, state: joinedState(true) });
    const [held] = (await moves?.read())?.moves ?? [];
    if (moves === undefined || held === undefined) throw new Error("expected a held move");
    w.sentTo.length = 0;

    expect(await moves.confirm(held)).toEqual({ status: "not-unlocked", reason: "cancelled" });
    expect(w.sentTo).toEqual([]);
  });
});

describe("keeping the phone's waiting moves current while it is open", () => {
  /** An app whose foreground state the test sets. */
  function appActivity(active: boolean) {
    const listeners = new Set<(active: boolean) => void>();
    const state = { active };
    const activity: AppActivity = {
      isActive: () => state.active,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const set = (next: boolean) => {
      state.active = next;
      for (const listener of listeners) listener(next);
    };
    return { activity, set, listeners };
  }

  it("lists a move a computer starts holding after the screen opened, without opening it again", async () => {
    let holds = false;
    const w = await world({ presence: "confirmed", holdsMove: () => holds });
    const moves = await phoneThreadMovesOf({ ...w, state: joinedState(true) });
    if (moves === undefined) throw new Error("expected the phone's moves");
    const listed: string[][] = [];
    const read = () =>
      void moves
        .read()
        .then((reading) =>
          listed.push(reading.moves.map((move) => move.confirmation.confirmationId)),
        );
    const app = appActivity(true);

    read();
    const stop = pollWhileActive({ run: read, intervalMs: 10, activity: app.activity });
    await vi.waitFor(() => expect(listed[0]).toEqual([]));
    holds = true;

    await vi.waitFor(() => expect(listed.at(-1)).toEqual([heldMove.confirmationId]));
    stop();
    expect(app.listeners.size).toBe(0);
  });

  it("reads nothing while the app is in the background, and reads at once when it returns", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const app = appActivity(false);
      const stop = pollWhileActive({ run, intervalMs: 5_000, activity: app.activity });

      vi.advanceTimersByTime(20_000);
      expect(run).not.toHaveBeenCalled();
      app.set(true);
      expect(run).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(5_000);
      expect(run).toHaveBeenCalledTimes(2);

      stop();
      vi.advanceTimersByTime(20_000);
      app.set(true);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
