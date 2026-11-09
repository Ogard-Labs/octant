// Two spokes and an owner phone on loopback, joined through a hub: a thread
// moves from one spoke to the other over the real member routes, against a
// ticket the phone made on the destination with a fresh unlock.

import { createHash } from "node:crypto";
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
  type OwnerUnlockChoice,
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
const SECOND: MovedThreadReference = {
  mode: "chat",
  threadId: "99999999-9999-4999-8999-999999999999",
};
const CONVERSATION = JSON.stringify({ title: "Plan the trip", turns: ["Where should we go?"] });
/** An attachment larger than one chunk, so it crosses several chunk requests. */
const ATTACHMENT = Buffer.alloc(1_300_000, "itinerary ");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A computer holding one Chat thread it can move away, and nothing it can receive. */
function leavingThreads(folder: string) {
  const frozen = new Set<string>();
  const erased: string[] = [];
  const turn = { running: false };
  /** Set when the thread owns an attachment beside its conversation, and one that cannot be read. */
  const bulk = { carried: false };
  const source: ThreadMoveSourceHost = {
    read: async (thread) =>
      (thread.threadId === THREAD.threadId || thread.threadId === SECOND.threadId) &&
      !erased.includes(thread.threadId)
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
    measure: async () => ({ status: "unknown" }),
    pack: async (_thread, partsFolder) => {
      mkdirSync(partsFolder, { recursive: true });
      const path = join(partsFolder, "thread.json");
      writeFileSync(path, CONVERSATION);
      if (!bulk.carried) {
        return { status: "packed", parts: [{ partId: "thread", kind: "thread-bundle", path }] };
      }
      const attachmentPath = join(partsFolder, "attachment-1.part");
      writeFileSync(attachmentPath, ATTACHMENT);
      return {
        status: "packed",
        parts: [
          { partId: "thread", kind: "thread-bundle", path },
          { partId: "attachment-1", kind: "attachment", path: attachmentPath },
        ],
        partsLeftBehind: [{ kind: "attachment", name: "scan.pdf" }],
      };
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
  const listThreads = async () =>
    [THREAD, SECOND]
      .filter((thread) => !erased.includes(thread.threadId))
      .map((thread) => ({
        thread,
        title: thread === THREAD ? "Plan the trip" : "Pack the bags",
        busy: false,
        delegated: false,
        open: true,
        lastActivityAt: Date.now(),
        repositoryRemotes: [],
      }));
  return { hosts: { source, destination, listThreads }, frozen, erased, turn, bulk };
}

/** A computer that opens Chat threads moved to it. */
function arrivingThreads() {
  const opened: string[] = [];
  const received = new Map<string, string>();
  const active: string[] = [];
  const destination: ThreadMoveDestinationHost = {
    acceptsProject: (placement) => placement.mode === "chat",
    arrive: async ({ parts }) => {
      const { readFile } = await import("node:fs/promises");
      for (const [partId, path] of parts) {
        if (partId === "thread") opened.push(await readFile(path, "utf8"));
        received.set(partId, sha256(await readFile(path)));
      }
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
    measure: async () => ({ status: "unknown" }),
    pack: async () => ({ status: "refused", reason: "refused" }),
    erase: async () => ({ worktreeKept: false }),
  };
  return { hosts: { source, destination }, opened, received, active };
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
  const atHub = arrivingThreads();
  const hub = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network,
    cleanups,
    threadMoveHosts: atHub.hosts,
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
  return {
    hub,
    laptop,
    desktop,
    phone,
    network,
    authenticator,
    leaving,
    arriving,
    atHub,
    ticket,
    laptopUnlock,
  };
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

  it("carries the thread's bulk parts over the member routes byte for byte and names the one left behind", async () => {
    const { laptop, desktop, leaving, arriving, ticket } = await startWorld();
    leaving.bulk.carried = true;
    const issued = await ticket();
    const ticketId = (issued.json as { ticketId: string }).ticketId;

    const outcome = await laptop.threadMoves.start({
      thread: THREAD,
      targetMemberId: desktop.hostId,
      ticketId,
      principal: window,
    });

    expect(outcome.status).toBe("moved");
    expect(arriving.received.get("attachment-1")).toBe(sha256(ATTACHMENT));
    expect(laptop.threadMovesFromWindow.status(THREAD).departed?.partsLeftBehind).toEqual([
      { kind: "attachment", name: "scan.pdf" },
    ]);
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

  it("moves a thread to the hub, which takes it while Accept moved threads is on", async () => {
    const { hub, laptop, leaving, atHub, laptopUnlock } = await startWorld();
    const listed = await laptop.threadMovesFromWindow.destinations(THREAD);
    expect(listed.destinations.find((entry) => entry.name === "Mac mini")).toMatchObject({
      role: "hub",
      reachable: true,
      noProjectAllowed: true,
    });

    const started = await laptop.threadMovesFromWindow.start({
      thread: THREAD,
      destinationMemberId: decodeMemberId(hub.hostId),
      timing: "now",
      unlock: await unlockAtWindow(laptop, hub, laptopUnlock),
    });

    expect(started).toEqual({ status: "started" });
    await vi.waitFor(() => expect(leaving.erased).toEqual([THREAD.threadId]));
    expect(atHub.opened).toEqual([CONVERSATION]);
    expect(atHub.active).toEqual([ARRIVED.threadId]);
    expect(hub.threadMoveRecords).toEqual(["moved-in", "move-committed"]);
  }, 60_000);

  it("refuses every move once a window on the hub turns Accept moved threads off", async () => {
    const { hub, laptop, leaving, atHub, laptopUnlock } = await startWorld();
    expect(hub.hub.setAcceptMovedThreads(false, window)).toEqual({
      status: "changed",
      enabled: false,
    });
    const listed = await laptop.threadMovesFromWindow.destinations(THREAD);
    expect(listed.destinations.find((entry) => entry.name === "Mac mini")?.refusal).toBe("refused");

    const started = await laptop.threadMovesFromWindow.start({
      thread: THREAD,
      destinationMemberId: decodeMemberId(hub.hostId),
      timing: "now",
      unlock: await unlockAtWindow(laptop, hub, laptopUnlock),
    });

    expect(started).toEqual({ status: "started" });
    await vi.waitFor(() =>
      expect(laptop.threadMovesFromWindow.status(THREAD).failure?.reason).toBe("refused"),
    );
    expect(atHub.opened).toEqual([]);
    expect(leaving.erased).toEqual([]);
    expect(leaving.frozen.size).toBe(0);
  }, 60_000);

  it("moves every chosen thread to one computer with a single unlock when preparing to shut down", async () => {
    const { laptop, desktop, leaving, arriving, laptopUnlock } = await startWorld({
      laptopIsOwner: true,
    });
    const listing = await laptop.threadMovesFromWindow.shutdownListing();
    expect(listing.rows.map((row) => row.title)).toEqual(["Plan the trip", "Pack the bags"]);
    const toDesktop = listing.rows.map((row) =>
      row.placements.find((placement) => placement.memberId === desktop.hostId),
    );
    expect(toDesktop.every((placement) => placement?.reason === undefined)).toBe(true);

    const threads = [THREAD, SECOND];
    const asked = await laptop.threadMovesFromWindow.shutdownChallenge({
      destinationMemberId: decodeMemberId(desktop.hostId),
      threads,
    });
    if (asked.status !== "challenge") throw new Error(JSON.stringify(asked));
    const started = await laptop.threadMovesFromWindow.shutdownStart({
      destinationMemberId: decodeMemberId(desktop.hostId),
      rows: threads.map((thread) => ({ thread, timing: "now" as const })),
      unlock: {
        challengeId: asked.challenge.challengeId,
        signature: laptopUnlock.sign(ownerUnlockSigningPayload(asked.challenge)),
      },
    });

    expect(started).toEqual({ status: "started" });
    await vi.waitFor(() =>
      expect([...leaving.erased].sort()).toEqual([THREAD.threadId, SECOND.threadId].sort()),
    );
    expect(arriving.opened).toHaveLength(2);
  }, 60_000);
});

describe("confirming a move on an owner phone", () => {
  /** A world where the phone is an owner on the source as well as on the destination. */
  async function phoneWorld() {
    const world = await startWorld();
    listAsOwner(world.laptop, world.phone, world.authenticator);
    const unlock = { authenticator: world.authenticator, shape: "raw" } as const;
    const asPhone = (
      target: HubTestHost,
      route: string,
      input: {
        readonly body?: unknown;
        readonly method?: "GET" | "POST";
        readonly unlock?: OwnerUnlockChoice;
        readonly session?: string;
      } = {},
    ) =>
      ownerCall({
        device: world.phone,
        network: world.network,
        target,
        route,
        ...input,
      });
    const waiting = async () => {
      const listed = await asPhone(world.laptop, HUB_OWNER_ROUTES.threadMoveConfirmations, {
        method: "GET",
      });
      const confirmations = (
        listed.json as {
          confirmations?: ReadonlyArray<{
            confirmationId: string;
            destinationName: string;
            threads: ReadonlyArray<{ thread: MovedThreadReference; title: string }>;
          }>;
        }
      ).confirmations;
      const first = confirmations?.[0];
      if (first === undefined) throw new Error(JSON.stringify(listed));
      return first;
    };
    /** The destination's ticket for exactly these threads, after the phone's own fresh unlock there. */
    const ticketFor = async (threads: ReadonlyArray<MovedThreadReference>) => {
      const issued = await asPhone(world.desktop, HUB_OWNER_ROUTES.threadMoveTicket, {
        body: { sourceMemberId: world.laptop.hostId, threads },
        unlock,
      });
      const ticketId = (issued.json as { ticketId?: string }).ticketId;
      if (ticketId === undefined) throw new Error(JSON.stringify(issued));
      return ticketId;
    };
    const confirm = (confirmationId: string, ticketId: string) =>
      asPhone(world.laptop, HUB_OWNER_ROUTES.threadMoveConfirm, {
        body: { confirmationId, ticketId },
        unlock,
      });
    const askPhone = () =>
      world.laptop.threadMovesFromWindow.askPhone({
        thread: THREAD,
        destinationMemberId: decodeMemberId(world.desktop.hostId),
        timing: "now",
      });
    return { ...world, unlock, asPhone, waiting, ticketFor, confirm, askPhone };
  }

  it("moves a thread its window held for the phone once the phone unlocks on the destination", async () => {
    const { laptop, desktop, leaving, arriving, waiting, ticketFor, confirm, askPhone } =
      await phoneWorld();

    expect(await askPhone()).toMatchObject({ status: "waiting-for-phone" });
    expect(laptop.threadMovesFromWindow.status(THREAD).waitingForPhone?.destinationName).toBe(
      "Desktop",
    );
    // Nothing is frozen or sent while the move waits for the phone.
    expect(leaving.frozen.size).toBe(0);

    const held = await waiting();
    expect(held.destinationName).toBe("Desktop");
    expect(held.threads).toEqual([{ thread: THREAD, title: "Plan the trip" }]);
    const confirmed = await confirm(
      held.confirmationId,
      await ticketFor(held.threads.map((entry) => entry.thread)),
    );

    expect(confirmed).toMatchObject({ status: 200, json: { status: "started" } });
    await vi.waitFor(() => expect(leaving.erased).toEqual([THREAD.threadId]));
    expect(arriving.opened).toEqual([CONVERSATION]);
    expect(desktop.threadMoveRecords).toEqual(["moved-in", "move-committed"]);
    expect(laptop.threadMovesFromWindow.status(THREAD).waitingForPhone).toBeUndefined();
  }, 60_000);

  it("refuses a phone that is not an owner on the source, which neither reads nor confirms the wait", async () => {
    const { laptop, desktop, phone, network, authenticator, leaving } = await startWorld();
    expect(
      await laptop.threadMovesFromWindow.askPhone({
        thread: THREAD,
        destinationMemberId: decodeMemberId(desktop.hostId),
        timing: "now",
      }),
    ).toMatchObject({ status: "waiting-for-phone" });

    const listed = await ownerCall({
      device: phone,
      network,
      target: laptop,
      route: HUB_OWNER_ROUTES.threadMoveConfirmations,
      method: "GET",
    });
    const confirmed = await ownerCall({
      device: phone,
      network,
      target: laptop,
      route: HUB_OWNER_ROUTES.threadMoveConfirm,
      body: {
        confirmationId: "12345678-1234-4234-8234-123456789012",
        ticketId: "12345678-1234-4234-8234-123456789013",
      },
      unlock: { authenticator, shape: "raw" },
    });

    expect(listed).toMatchObject({ status: 403, json: { kind: "not-an-owner" } });
    expect(confirmed).toMatchObject({ status: 403, json: { kind: "not-an-owner" } });
    expect(laptop.threadMovesFromWindow.status(THREAD).waitingForPhone).toBeDefined();
    expect(leaving.frozen.size).toBe(0);
  }, 60_000);

  it("asks the phone for an unlock on the source too, and spends a confirmation once", async () => {
    const { laptop, leaving, asPhone, waiting, ticketFor, confirm, askPhone } = await phoneWorld();
    await askPhone();
    const held = await waiting();
    const ticketId = await ticketFor([THREAD]);

    const unsigned = await asPhone(laptop, HUB_OWNER_ROUTES.threadMoveConfirm, {
      body: { confirmationId: held.confirmationId, ticketId },
    });
    expect(unsigned).toMatchObject({ status: 403, json: { kind: "unlock-required" } });
    expect(laptop.threadMovesFromWindow.status(THREAD).waitingForPhone).toBeDefined();

    expect(await confirm(held.confirmationId, ticketId)).toMatchObject({ status: 200 });
    const again = await confirm(held.confirmationId, ticketId);

    expect(again).toMatchObject({
      status: 409,
      json: { status: "refused", kind: "no-such-confirmation" },
    });
    await vi.waitFor(() => expect(leaving.erased).toEqual([THREAD.threadId]));
  }, 60_000);

  it("issues no ticket for a challenge bound to another body, or under an administration session", async () => {
    const { laptop, desktop, asPhone, unlock, askPhone } = await phoneWorld();
    await askPhone();
    const body = { sourceMemberId: laptop.hostId, threads: [THREAD] };

    const otherBody = await asPhone(desktop, HUB_OWNER_ROUTES.threadMoveTicket, {
      body,
      unlock: {
        ...unlock,
        boundTo: {
          route: HUB_OWNER_ROUTES.threadMoveTicket,
          body: JSON.stringify({ sourceMemberId: laptop.hostId, threads: [SECOND] }),
        },
      },
    });
    const opened = await asPhone(desktop, HUB_OWNER_ROUTES.session, { unlock });
    const sessionId = (opened.json as { session?: { sessionId?: string } }).session?.sessionId;
    if (sessionId === undefined) throw new Error(JSON.stringify(opened));
    const underSession = await asPhone(desktop, HUB_OWNER_ROUTES.threadMoveTicket, {
      body,
      session: sessionId,
    });

    expect(otherBody).toMatchObject({ status: 403, json: { kind: "unlock-action-mismatch" } });
    expect(underSession).toMatchObject({ status: 403, json: { kind: "own-unlock-required" } });
  }, 60_000);

  it("moves nothing on a ticket the destination issued for other threads", async () => {
    const { laptop, leaving, arriving, waiting, ticketFor, confirm, askPhone } = await phoneWorld();
    await askPhone();
    const held = await waiting();

    const confirmed = await confirm(held.confirmationId, await ticketFor([SECOND]));

    expect(confirmed).toMatchObject({ status: 200 });
    await vi.waitFor(() =>
      expect(laptop.threadMovesFromWindow.status(THREAD).failure?.reason).toBe("refused"),
    );
    expect(arriving.opened).toEqual([]);
    expect(leaving.erased).toEqual([]);
    expect(leaving.frozen.size).toBe(0);
  }, 60_000);

  it("refuses the move once the phone is no longer an owner on the destination", async () => {
    const { laptop, desktop, phone, leaving, arriving, waiting, ticketFor, confirm, askPhone } =
      await phoneWorld();
    await askPhone();
    const held = await waiting();
    const ticketId = await ticketFor([THREAD]);

    desktop.spoke.removeOwner(phone.hostId, window);
    await confirm(held.confirmationId, ticketId);

    await vi.waitFor(() =>
      expect(laptop.threadMovesFromWindow.status(THREAD).failure?.reason).toBe("refused"),
    );
    expect(arriving.opened).toEqual([]);
    expect(leaving.erased).toEqual([]);
  }, 60_000);

  it("moves a Prepare to shut down batch with one confirmation on the phone", async () => {
    const { laptop, desktop, leaving, arriving, waiting, ticketFor, confirm } = await phoneWorld();
    const threads = [THREAD, SECOND];
    expect(
      await laptop.threadMovesFromWindow.shutdownAskPhone({
        destinationMemberId: decodeMemberId(desktop.hostId),
        rows: threads.map((thread) => ({ thread, timing: "now" as const })),
      }),
    ).toMatchObject({ status: "waiting-for-phone" });

    const held = await waiting();
    expect(held.threads.map((entry) => entry.thread)).toEqual(threads);
    await confirm(held.confirmationId, await ticketFor(held.threads.map((entry) => entry.thread)));

    await vi.waitFor(() =>
      expect([...leaving.erased].sort()).toEqual([THREAD.threadId, SECOND.threadId].sort()),
    );
    expect(arriving.opened).toHaveLength(2);
  }, 60_000);
});
