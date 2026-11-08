// Two spokes and an owner phone on loopback, joined through a hub: a thread
// moves from one spoke to the other over the real member routes, against a
// ticket the phone made on the destination with a fresh unlock.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubMemberId, type MovedThreadReference } from "@octant/contracts";
import { ownerUnlockSigningPayload } from "@octant/domain";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicKeyFingerprint } from "./hubCrypto";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { HUB_OWNER_ROUTES } from "./hubOwnerRoutes";
import {
  ownerCall,
  softwareAuthenticator,
  type SoftwareAuthenticator,
} from "./hubOwner.test-support";
import type { ThreadMoveDestinationHost, ThreadMoveSourceHost } from "./threadMoveService";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const THREAD: MovedThreadReference = {
  mode: "chat",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const ARRIVED: MovedThreadReference = {
  mode: "chat",
  threadId: "88888888-8888-4888-8888-888888888888",
};
const CONVERSATION = JSON.stringify({ title: "Plan the trip", turns: ["Where should we go?"] });

/** A computer holding one Chat thread it can move away, and nothing it can receive. */
function leavingThreads(folder: string) {
  const frozen = new Set<string>();
  const erased: string[] = [];
  const turn = { running: false };
  const source: ThreadMoveSourceHost = {
    read: async (thread) =>
      thread.threadId === THREAD.threadId && !erased.includes(thread.threadId)
        ? {
            status: "found",
            title: "Plan the trip",
            busy: turn.running,
            delegated: false,
            repositoryRemotes: [],
          }
        : { status: "missing" },
    freeze: (thread) => frozen.add(thread.threadId),
    unfreeze: (thread) => frozen.delete(thread.threadId),
    isFrozen: (thread) => frozen.has(thread.threadId),
    pack: async (_thread, partsFolder) => {
      mkdirSync(partsFolder, { recursive: true });
      const path = join(partsFolder, "thread.json");
      writeFileSync(path, CONVERSATION);
      return { status: "packed", parts: [{ partId: "thread", kind: "thread-bundle", path }] };
    },
    erase: async ({ thread }) => {
      erased.push(thread.threadId);
      return { worktreeKept: false };
    },
  };
  const destination: ThreadMoveDestinationHost = {
    acceptsProject: () => false,
    arrive: async () => ({ status: "refused", reason: "no-eligible-project" }),
    activate: async () => {},
    discard: async () => {},
  };
  void folder;
  return { hosts: { source, destination }, frozen, erased, turn };
}

/** A computer that opens Chat threads moved to it. */
function arrivingThreads() {
  const opened: string[] = [];
  const active: string[] = [];
  const destination: ThreadMoveDestinationHost = {
    acceptsProject: (placement) => placement.mode === "chat",
    arrive: async ({ parts }) => {
      const { readFile } = await import("node:fs/promises");
      for (const path of parts.values()) opened.push(await readFile(path, "utf8"));
      return { status: "arrived", thread: ARRIVED };
    },
    activate: async (thread) => {
      active.push(thread.threadId);
    },
    discard: async () => {},
  };
  const source: ThreadMoveSourceHost = {
    read: async () => ({ status: "missing" }),
    freeze: () => {},
    unfreeze: () => {},
    isFrozen: () => false,
    pack: async () => ({ status: "refused", reason: "refused" }),
    erase: async () => ({ worktreeKept: false }),
  };
  return { hosts: { source, destination }, opened, active };
}

async function joinHub(
  hub: HubTestHost,
  device: HubTestHost,
  input: { readonly owner: boolean; readonly unlockPublicKey?: string },
) {
  const minted = hub.hub.mintJoinCode({ owner: input.owner });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await device.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const pending = hub.administration.listPendingPairings().at(-1);
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await device.spoke.finishJoin(
    window,
    input.unlockPublicKey === undefined ? {} : { unlockPublicKey: input.unlockPublicKey },
  );
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

function listAsOwner(spoke: HubTestHost, phone: HubTestHost, authenticator: SoftwareAuthenticator) {
  const listed = spoke.spoke.addOwners(
    [
      {
        memberId: decodeMemberId(phone.hostId),
        identityKeyFingerprint: publicKeyFingerprint(phone.hostPublicKey),
        unlockKeyFingerprint: authenticator.fingerprint,
      },
    ],
    window,
  );
  if (listed.status !== "changed") throw new Error(JSON.stringify(listed));
}

async function startWorld(options: { readonly laptopIsOwner?: boolean } = {}) {
  const network = new HubTestNetwork();
  const leaving = leavingThreads("laptop");
  const arriving = arrivingThreads();
  const hub = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network,
    cleanups,
  });
  const laptop = await startHubTestHost({
    name: "Laptop",
    address: "100.101.102.104",
    network,
    cleanups,
    threadMoveHosts: leaving.hosts,
  });
  const desktop = await startHubTestHost({
    name: "Desktop",
    address: "100.101.102.105",
    network,
    cleanups,
    threadMoveHosts: arriving.hosts,
  });
  const phone = await startHubTestHost({
    name: "Phone",
    address: "100.101.102.106",
    network,
    cleanups,
  });
  const authenticator = softwareAuthenticator();
  // This Mac's own unlock key (Touch ID), for a move started at its window.
  const laptopUnlock = softwareAuthenticator();
  hub.hub.enable(window);
  await joinHub(hub, phone, { owner: true, unlockPublicKey: authenticator.publicKey });
  await joinHub(hub, laptop, { owner: true, unlockPublicKey: laptopUnlock.publicKey });
  await joinHub(hub, desktop, { owner: false });
  await vi.waitFor(() => {
    for (const [spoke, other] of [
      [laptop, desktop],
      [desktop, laptop],
    ] as const) {
      const held = spoke.spoke.status();
      if (held.membership !== "member") throw new Error("Not a member.");
      expect(held.acceptedMemberIds).toContain(other.hostId);
      expect(held.roster.roster.members.map((member) => member.name)).toContain("Phone");
    }
  });
  listAsOwner(desktop, phone, authenticator);
  if (options.laptopIsOwner === true) listAsOwner(desktop, laptop, laptopUnlock);
  const unlock = { authenticator, shape: "raw" } as const;
  const ticket = async (withUnlock = true) =>
    ownerCall({
      device: phone,
      network,
      target: desktop,
      route: HUB_OWNER_ROUTES.threadMoveTicket,
      body: { sourceMemberId: laptop.hostId },
      ...(withUnlock ? { unlock } : {}),
    });
  return { laptop, desktop, leaving, arriving, ticket, laptopUnlock };
}

/** What this Mac's Touch ID prompt signs: exactly the destination's challenge. */
async function unlockAtWindow(
  laptop: HubTestHost,
  desktop: HubTestHost,
  key: SoftwareAuthenticator,
): Promise<{ readonly challengeId: string; readonly signature: string }> {
  const asked = await laptop.threadMovesFromWindow.challenge(desktop.hostId);
  if (asked.status !== "challenge") throw new Error(JSON.stringify(asked));
  return {
    challengeId: asked.challenge.challengeId,
    signature: key.sign(ownerUnlockSigningPayload(asked.challenge)),
  };
}

describe("moving a thread between two of the person's computers", () => {
  it("moves the thread over the member routes and erases it on the source only after the destination committed", async () => {
    const { laptop, desktop, leaving, arriving, ticket } = await startWorld();
    const issued = await ticket();
    expect(issued.status).toBe(200);
    const ticketId = (issued.json as { ticketId: string }).ticketId;

    const outcome = await laptop.threadMoves.start({
      thread: THREAD,
      targetMemberId: desktop.hostId,
      ticketId,
      principal: window,
    });

    expect(outcome).toEqual({ status: "moved", destination: ARRIVED, worktreeKept: false });
    expect(arriving.opened).toEqual([CONVERSATION]);
    expect(arriving.active).toEqual([ARRIVED.threadId]);
    expect(leaving.erased).toEqual([THREAD.threadId]);
    expect(leaving.frozen.size).toBe(0);
    expect(laptop.threadMoveRecords).toEqual(["move-started", "moved-out"]);
    expect(desktop.threadMoveRecords).toEqual(["moved-in", "move-committed"]);
  }, 60_000);

  it("issues no ticket without the owner's own fresh unlock, so nothing can move", async () => {
    const { laptop, desktop, leaving, arriving, ticket } = await startWorld();
    const refused = await ticket(false);
    expect(refused.json).toEqual({ status: "refused", kind: "unlock-required" });

    const outcome = await laptop.threadMoves.start({
      thread: THREAD,
      targetMemberId: desktop.hostId,
      ticketId: "no-ticket",
      principal: window,
    });

    expect(outcome).toEqual({ status: "failed", reason: "refused" });
    expect(arriving.opened).toEqual([]);
    expect(leaving.erased).toEqual([]);
    expect(leaving.frozen.size).toBe(0);
    expect(laptop.threadMoveRecords).toEqual(["move-started", "move-failed"]);
  }, 60_000);

  it("moves a thread from its window with this Mac's own unlock on the destination", async () => {
    const { laptop, desktop, leaving, arriving, laptopUnlock } = await startWorld({
      laptopIsOwner: true,
    });
    const listed = await laptop.threadMovesFromWindow.destinations(THREAD);
    expect(listed.destinations.find((entry) => entry.name === "Desktop")).toMatchObject({
      reachable: true,
      noProjectAllowed: true,
    });

    const started = await laptop.threadMovesFromWindow.start({
      thread: THREAD,
      destinationMemberId: decodeMemberId(desktop.hostId),
      timing: "now",
      unlock: await unlockAtWindow(laptop, desktop, laptopUnlock),
    });

    expect(started).toEqual({ status: "started" });
    await vi.waitFor(() =>
      expect(laptop.threadMovesFromWindow.status(THREAD).departed).toMatchObject({
        destinationName: "Desktop",
        destinationThread: ARRIVED,
      }),
    );
    expect(arriving.opened).toEqual([CONVERSATION]);
    expect(leaving.erased).toEqual([THREAD.threadId]);
  }, 60_000);

  it("waits for the running turn to end, then moves without asking again", async () => {
    const { laptop, desktop, leaving, laptopUnlock } = await startWorld({ laptopIsOwner: true });
    leaving.turn.running = true;

    const started = await laptop.threadMovesFromWindow.start({
      thread: THREAD,
      destinationMemberId: decodeMemberId(desktop.hostId),
      timing: "after-turn",
      unlock: await unlockAtWindow(laptop, desktop, laptopUnlock),
    });

    expect(started).toEqual({ status: "waiting-for-turn" });
    expect(laptop.threadMovesFromWindow.status(THREAD).waiting?.destinationName).toBe("Desktop");
    expect(leaving.frozen.size).toBe(0);
    leaving.turn.running = false;
    await vi.waitFor(() => expect(leaving.erased).toEqual([THREAD.threadId]));
  }, 60_000);

  it("refuses a Mac that is not an owner on the destination, and says so on the thread until dismissed", async () => {
    const { laptop, desktop, leaving, arriving } = await startWorld();
    expect(await laptop.threadMovesFromWindow.challenge(desktop.hostId)).toEqual({
      status: "refused",
      kind: "unlock-required",
    });

    const started = await laptop.threadMovesFromWindow.start({
      thread: THREAD,
      destinationMemberId: decodeMemberId(desktop.hostId),
      timing: "now",
      unlock: { challengeId: "12345678-1234-4234-8234-123456789012", signature: "AAAA" },
    });

    expect(started).toEqual({ status: "refused", reason: "unlock-required" });
    expect(laptop.threadMovesFromWindow.status(THREAD).failure?.reason).toBe("unlock-required");
    expect(arriving.opened).toEqual([]);
    expect(leaving.frozen.size).toBe(0);
    laptop.threadMovesFromWindow.dismiss(THREAD);
    expect(laptop.threadMovesFromWindow.status(THREAD).failure).toBeUndefined();
  }, 60_000);
});
