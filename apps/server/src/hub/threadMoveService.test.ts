import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  THREAD_MOVE_PARTS_LEFT_BEHIND_NAMED,
  type HubMemberId,
  type MovedThreadReference,
  type PeerGrant,
  type RosterMember,
  type ThreadMoveFailureReason,
  type ThreadMovePartLeftBehind,
} from "@octant/contracts";
import type { HubHostIdentity } from "./hubService";
import type { HubTransport } from "./pinnedHubTransport";
import type { MemberTarget } from "./spokeLinkService";
import { createThreadMoveStateStore, heldThreadsOf } from "./threadMoveStateStore";
import {
  THREAD_MOVE_ASSUMED_BYTES_PER_SECOND,
  THREAD_MOVE_CHUNK_BYTES,
  THREAD_MOVE_ROUTES,
  THREAD_MOVE_TICKET_LIFETIME_MS,
  ThreadMoveService,
  type DestinationAnswer,
  type MoveSender,
  type SignedRequest,
} from "./threadMoveService";

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const laptopId = id(3) as HubMemberId;
const miniId = id(1) as HubMemberId;
const ownerId = id(3) as HubMemberId;
const key = (n: number) => String(n).repeat(64).slice(0, 64);

const member = (memberId: HubMemberId, n: number, role: RosterMember["role"]): RosterMember => ({
  memberId,
  name: `member ${n}`,
  role,
  identityKeyFingerprint: key(n),
  listenerPin: key(n),
  privateNames: [],
  addresses: [`100.64.0.${n}`],
  owner: false,
});

const chatThread: MovedThreadReference = { mode: "chat", threadId: id(5) };

type Recorded = { readonly name: string; readonly reason?: ThreadMoveFailureReason };

interface Harness {
  readonly laptop: ThreadMoveService;
  readonly mini: ThreadMoveService;
  readonly records: { readonly laptop: Recorded[]; readonly mini: Recorded[] };
  readonly frozen: Set<string>;
  readonly erased: string[];
  readonly arrived: MovedThreadReference[];
  readonly received: ReadonlyArray<{ readonly partId: string; readonly bytes: Buffer }>;
  readonly active: string[];
  readonly discarded: string[];
  readonly network: {
    up: boolean;
    dropNextAnswerTo: string | undefined;
    dropChunkAfter: number | undefined;
    stopAfterOpening: boolean;
    /** How long each chunk takes to answer, on the shared clock. */
    chunkMs: number;
  };
  readonly clock: { now: number };
  ticket: () => string;
}

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function harness(
  options: {
    readonly grant?: Partial<PeerGrant>;
    readonly bytes?: number;
    /** Bulk parts the thread owns beside its bundle, and the ones that could not be read. */
    readonly bulk?: {
      readonly parts: ReadonlyArray<{ readonly partId: string; readonly bytes: number }>;
      readonly leftBehind: ReadonlyArray<ThreadMovePartLeftBehind>;
    };
  } = {},
): Harness {
  const laptopFolder = mkdtempSync(join(tmpdir(), "octant-move-laptop-"));
  const miniFolder = mkdtempSync(join(tmpdir(), "octant-move-mini-"));
  folders.push(laptopFolder, miniFolder);
  const records = { laptop: [] as Recorded[], mini: [] as Recorded[] };
  const frozen = new Set<string>();
  const erased: string[] = [];
  const arrived: MovedThreadReference[] = [];
  const received: Array<{ readonly partId: string; readonly bytes: Buffer }> = [];
  const active: string[] = [];
  const discarded: string[] = [];
  const network: Harness["network"] = {
    up: true,
    dropNextAnswerTo: undefined,
    dropChunkAfter: undefined,
    stopAfterOpening: false,
    chunkMs: 0,
  };
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  let sequence = 0;
  const opened = new Set<string>();
  const uuid = () => id(6 + (sequence++ % 3));
  let chunkRequests = 0;

  const recorder = (into: Recorded[]) => ({
    moveStarted: () => into.push({ name: "move-started" }),
    movedIn: () => into.push({ name: "moved-in" }),
    moveCommitted: () => into.push({ name: "move-committed" }),
    movedOut: () => into.push({ name: "moved-out" }),
    moveFailed: (input: { reason: ThreadMoveFailureReason }) =>
      into.push({ name: "move-failed", reason: input.reason }),
  });
  const identity = (): HubHostIdentity => ({
    hostId: "host" as HubHostIdentity["hostId"],
    displayName: "host",
    signing: { hostKeyFingerprint: key(2), hostPublicKey: "key", signHostPayload: () => "sig" },
  });

  const grant: PeerGrant = { memberId: laptopId, readStatus: true, moveIn: true, ...options.grant };
  const authenticate = (request: SignedRequest): MoveSender => {
    const sender = request.header?.split(".")[1];
    if (sender !== String(laptopId)) return { status: "refused" };
    return { status: "member", memberId: String(laptopId), moveIn: grant.moveIn === true };
  };

  let mini: ThreadMoveService | undefined;
  const handlers: Record<string, (request: SignedRequest) => Promise<DestinationAnswer>> = {
    [THREAD_MOVE_ROUTES.offer]: (request) => (mini as ThreadMoveService).receiveOffer(request),
    [THREAD_MOVE_ROUTES.chunk]: (request) => (mini as ThreadMoveService).receiveChunk(request),
    [THREAD_MOVE_ROUTES.finish]: (request) => (mini as ThreadMoveService).finish(request),
    [THREAD_MOVE_ROUTES.commit]: (request) => (mini as ThreadMoveService).commit(request),
    [THREAD_MOVE_ROUTES.status]: (request) => (mini as ThreadMoveService).status(request),
    [THREAD_MOVE_ROUTES.discard]: (request) => (mini as ThreadMoveService).discard(request),
    [THREAD_MOVE_ROUTES.projects]: (request) => (mini as ThreadMoveService).listProjects(request),
  };
  const transport: HubTransport = () => async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (!network.up) throw new Error("unreachable");
    if (path === THREAD_MOVE_ROUTES.chunk) {
      chunkRequests += 1;
      clock.now += network.chunkMs;
      if (network.dropChunkAfter !== undefined && chunkRequests > network.dropChunkAfter) {
        network.up = false;
        throw new Error("cut");
      }
    }
    const headers = new Headers(init?.headers);
    const handler = handlers[path];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const answer = await handler({
      header: headers.get("x-octant-hub-link"),
      publicKey: headers.get("x-octant-hub-peer-key"),
      method: "POST",
      path,
      body: String(init?.body ?? ""),
    });
    if (network.dropNextAnswerTo === path) {
      network.dropNextAnswerTo = undefined;
      throw new Error("answer lost");
    }
    return new Response(JSON.stringify(answer.body), { status: answer.httpStatus });
  };

  const bytes = options.bytes ?? 1_000;
  const laptop = new ThreadMoveService({
    state: createThreadMoveStateStore(laptopFolder),
    source: {
      read: async () => ({
        status: "found",
        title: "Plan the trip",
        busy: false,
        delegated: false,
        repositoryRemotes: [],
      }),
      freeze: (thread) => frozen.add(thread.threadId),
      unfreeze: (thread) => frozen.delete(thread.threadId),
      isFrozen: (thread) => frozen.has(thread.threadId),
      measure: async () => ({ status: "unknown" }),
      pack: async (_thread, folder) => {
        const path = join(folder, "bundle.part");
        writeFileSync(path, Buffer.alloc(bytes, 7));
        const bulk = (options.bulk?.parts ?? []).map((part, index) => {
          const partPath = join(folder, `${part.partId}.bytes`);
          writeFileSync(partPath, Buffer.alloc(part.bytes, index + 1));
          return { partId: part.partId, kind: "attachment" as const, path: partPath };
        });
        return {
          status: "packed",
          parts: [{ partId: "bundle", kind: "thread-bundle", path }, ...bulk],
          ...(options.bulk === undefined ? {} : { partsLeftBehind: options.bulk.leftBehind }),
        };
      },
      erase: async ({ thread }) => {
        erased.push(thread.threadId);
        return { worktreeKept: false };
      },
    },
    destination: {
      acceptsProject: () => true,
      arrive: async () => ({ status: "arrived", thread: { mode: "chat", threadId: id(9) } }),
      activate: async () => {},
      discard: async () => {},
    },
    record: recorder(records.laptop),
    identity,
    target: (memberId): MemberTarget =>
      memberId === String(miniId)
        ? { status: "member", self: laptopId, member: member(miniId, 1, "hub") }
        : { status: "refused", kind: "not-in-roster" },
    transport,
    authenticate: () => ({ status: "refused" }),
    ownerIsCurrent: () => true,
    projects: () => [],
    now: () => clock.now,
    uuid,
  });
  const miniHost = new ThreadMoveService({
    state: createThreadMoveStateStore(miniFolder),
    source: {
      read: async () => ({ status: "missing" }),
      freeze: () => {},
      unfreeze: () => {},
      isFrozen: () => false,
      measure: async () => ({ status: "unknown" }),
      pack: async () => ({ status: "refused", reason: "refused" }),
      erase: async () => ({ worktreeKept: false }),
    },
    destination: {
      acceptsProject: (placement) => placement.mode === "chat",
      arrive: async ({ thread, parts }) => {
        // Idempotent by the planned id, as a real host must be.
        if (opened.has(thread.threadId)) return { status: "arrived", thread };
        opened.add(thread.threadId);
        for (const [partId, path] of parts) received.push({ partId, bytes: readFileSync(path) });
        arrived.push(thread);
        if (network.stopAfterOpening) {
          network.stopAfterOpening = false;
          throw new Error("The host stopped after opening the thread.");
        }
        return { status: "arrived", thread };
      },
      activate: async (thread) => {
        active.push(thread.threadId);
      },
      discard: async (thread) => {
        discarded.push(thread.threadId);
      },
    },
    record: recorder(records.mini),
    identity,
    target: (memberId): MemberTarget =>
      memberId === String(laptopId)
        ? { status: "member", self: miniId, member: member(laptopId, 3, "spoke") }
        : { status: "refused", kind: "not-in-roster" },
    transport,
    authenticate,
    ownerIsCurrent: (owner) => owner === String(ownerId),
    projects: (mode) => [
      { projectId: id(4) as never, title: mode === "chat" ? "Trips" : "Reports" },
    ],
    now: () => clock.now,
    // Tickets and planned thread ids are kept apart, so one fixed id serves both.
    uuid: () => id(9),
  });
  mini = miniHost;
  const ticket = () => {
    const issued = miniHost.issueTicket({ ownerMemberId: ownerId, sourceMemberId: laptopId });
    if (issued.status !== "issued") throw new Error("ticket refused");
    return issued.ticketId;
  };
  return {
    laptop,
    mini: miniHost,
    records,
    frozen,
    erased,
    arrived,
    received,
    active,
    discarded,
    network,
    clock,
    ticket,
  };
}

const start = (h: Harness, ticketId = h.ticket()) =>
  h.laptop.start({
    thread: chatThread,
    targetMemberId: miniId,
    ticketId,
    principal: { kind: "local-window" },
  });

describe("estimating how long a move takes", () => {
  it("assumes the stated default for a member no full chunk has been timed to", async () => {
    const h = harness({ bytes: 1_000 });
    h.network.chunkMs = 5_000;
    await start(h);
    // One small chunk's time is mostly the round trip, so it sets no rate.
    expect(h.laptop.rateTo(miniId)).toEqual({
      basis: "assumed",
      bytesPerSecond: THREAD_MOVE_ASSUMED_BYTES_PER_SECOND,
    });
  });

  it("estimates from the rate earlier full chunks to that member reached", async () => {
    const h = harness({ bytes: THREAD_MOVE_CHUNK_BYTES * 2 + 17 });
    h.network.chunkMs = 250;
    await start(h);
    expect(h.laptop.rateTo(miniId)).toEqual({
      basis: "measured",
      bytesPerSecond: THREAD_MOVE_CHUNK_BYTES * 4,
    });
    expect(h.laptop.rateTo(laptopId).basis).toBe("assumed");
  });
});

describe("moving a thread", () => {
  it("freezes, transfers, commits on the destination, and erases the source once committed", async () => {
    const h = harness({ bytes: THREAD_MOVE_CHUNK_BYTES * 2 + 17 });
    const outcome = await start(h);
    expect(outcome).toEqual({
      status: "moved",
      destination: { mode: "chat", threadId: id(9) },
      worktreeKept: false,
    });
    expect(h.records.laptop.map((entry) => entry.name)).toEqual(["move-started", "moved-out"]);
    expect(h.records.mini.map((entry) => entry.name)).toEqual(["moved-in", "move-committed"]);
    expect(h.active).toEqual([id(9)]);
    expect(h.erased).toEqual([chatThread.threadId]);
    expect(h.frozen.size).toBe(0);
  });

  it("carries every bulk part beside the bundle and names the ones it could not read in the receipt", async () => {
    const leftBehind: ThreadMovePartLeftBehind = { kind: "attachment", name: "scan.pdf" };
    const h = harness({
      bulk: {
        parts: [
          { partId: "attachment-1", bytes: THREAD_MOVE_CHUNK_BYTES + 5 },
          { partId: "attachment-2", bytes: 3 },
        ],
        leftBehind: [leftBehind],
      },
    });
    expect((await start(h)).status).toBe("moved");
    expect(h.received.map((part) => [part.partId, part.bytes.length])).toEqual([
      ["bundle", 1_000],
      ["attachment-1", THREAD_MOVE_CHUNK_BYTES + 5],
      ["attachment-2", 3],
    ]);
    expect(h.received[1]?.bytes.every((byte) => byte === 1)).toBe(true);
    const departures = createThreadMoveStateStore(folders[0] ?? "").load().departures ?? [];
    expect(departures.map((departure) => departure.partsLeftBehind)).toEqual([[leftBehind]]);
  });

  it("finishes a move with more unreadable parts than the receipt names, naming the first and counting all", async () => {
    const leftBehind: ReadonlyArray<ThreadMovePartLeftBehind> = Array.from(
      { length: THREAD_MOVE_PARTS_LEFT_BEHIND_NAMED + 1 },
      (_, index) => ({
        kind: "browser-capture",
        // A capture's title may be longer than the receipt holds.
        name: index === 0 ? "x".repeat(1_000) : `capture ${index}`,
      }),
    );
    const h = harness({ bulk: { parts: [], leftBehind } });
    expect((await start(h)).status).toBe("moved");
    expect(h.erased).toEqual([chatThread.threadId]);
    const [departure] = createThreadMoveStateStore(folders[0] ?? "").load().departures ?? [];
    expect(departure?.partsLeftBehind).toHaveLength(THREAD_MOVE_PARTS_LEFT_BEHIND_NAMED);
    expect(departure?.partsLeftBehind?.[0]?.name).toHaveLength(512);
    expect(departure?.partsLeftBehind?.at(-1)?.name).toBe(
      `capture ${THREAD_MOVE_PARTS_LEFT_BEHIND_NAMED - 1}`,
    );
    expect(departure?.partsLeftBehindCount).toBe(THREAD_MOVE_PARTS_LEFT_BEHIND_NAMED + 1);
  });

  it("refuses an offer without the destination owner's ticket, and unfreezes with the reason", async () => {
    const h = harness();
    const outcome = await start(h, "not-a-ticket");
    expect(outcome).toEqual({ status: "failed", reason: "refused" });
    expect(h.records.laptop.at(-1)).toEqual({ name: "move-failed", reason: "refused" });
    expect(h.frozen.size).toBe(0);
    expect(h.arrived).toEqual([]);
  });

  it("refuses to move a thread a handover holds, and leaves that hold in place", async () => {
    const h = harness();
    // Handed over: the thread is frozen by its handover, not by any move.
    h.frozen.add(chatThread.threadId);

    expect(await start(h)).toEqual({ status: "failed", reason: "busy" });
    expect(h.frozen.has(chatThread.threadId)).toBe(true);
    expect(h.arrived).toEqual([]);
  });

  it("answers a member without Move in exactly as one without a ticket", async () => {
    const h = harness({ grant: { moveIn: false } });
    expect(await start(h)).toEqual({ status: "failed", reason: "refused" });
  });

  it("asks for a fresh unlock when the ticket expired before the offer came", async () => {
    const h = harness();
    const ticketId = h.ticket();
    h.clock.now += THREAD_MOVE_TICKET_LIFETIME_MS + 1_000;
    expect(await start(h, ticketId)).toEqual({ status: "failed", reason: "unlock-required" });
  });

  it("never lets a ticket open a second move", async () => {
    const h = harness();
    const ticketId = h.ticket();
    await start(h, ticketId);
    expect(await start(h, ticketId)).toEqual({ status: "failed", reason: "refused" });
  });

  it("keeps the thread frozen when the transfer is cut, then resumes and arrives once", async () => {
    const h = harness({ bytes: THREAD_MOVE_CHUNK_BYTES * 3 });
    h.network.dropChunkAfter = 1;
    const first = await start(h);
    expect(first).toEqual({ status: "interrupted" });
    expect(h.frozen.has(chatThread.threadId)).toBe(true);
    expect(h.erased).toEqual([]);

    h.network.up = true;
    h.network.dropChunkAfter = undefined;
    const [resumed] = await h.laptop.recover();
    expect(resumed?.status).toBe("moved");
    expect(h.arrived).toHaveLength(1);
    expect(h.erased).toEqual([chatThread.threadId]);
  });

  it("neither duplicates nor loses the thread when the commit answer is lost", async () => {
    const h = harness();
    h.network.dropNextAnswerTo = THREAD_MOVE_ROUTES.commit;
    expect(await start(h)).toEqual({ status: "interrupted" });
    // The destination committed; the source has not erased yet and stays frozen.
    expect(h.active).toEqual([id(9)]);
    expect(h.erased).toEqual([]);
    expect(h.frozen.has(chatThread.threadId)).toBe(true);

    const [recovered] = await h.laptop.recover();
    expect(recovered?.status).toBe("moved");
    expect(h.erased).toEqual([chatThread.threadId]);
    expect(h.records.mini.filter((entry) => entry.name === "move-committed")).toHaveLength(1);
  });

  it("unfreezes on cancel only after the destination discarded what it held", async () => {
    const h = harness({ bytes: THREAD_MOVE_CHUNK_BYTES * 3 });
    h.network.dropChunkAfter = 1;
    await start(h);

    // Unreachable: the thread stays frozen.
    const moveId = id(6);
    expect(await h.laptop.cancel(moveId)).toEqual({ status: "destination-unreachable" });
    expect(h.frozen.has(chatThread.threadId)).toBe(true);

    h.network.up = true;
    h.network.dropChunkAfter = undefined;
    expect(await h.laptop.cancel(moveId)).toEqual({ status: "cancelled" });
    expect(h.frozen.size).toBe(0);
    expect(h.erased).toEqual([]);
  });

  it("holds a thread planned for a move that was still receiving when the host stopped", async () => {
    const h = harness();
    h.network.stopAfterOpening = true;
    await start(h);
    const miniState = createThreadMoveStateStore(folders[1] ?? "");
    expect(heldThreadsOf(miniState.load())).toEqual([{ mode: "chat", threadId: id(9) }]);
  });

  it("opens one thread, not two, when the destination stopped between opening it and recording it", async () => {
    const h = harness();
    h.network.stopAfterOpening = true;
    expect(await start(h)).toEqual({ status: "interrupted" });
    expect(h.erased).toEqual([]);

    const [recovered] = await h.laptop.recover();
    expect(recovered?.status).toBe("moved");
    expect(h.arrived).toEqual([{ mode: "chat", threadId: id(9) }]);
    expect(h.active).toEqual([id(9)]);
    expect(h.erased).toEqual([chatThread.threadId]);
  });

  it("finishes the erase when a cancel learns the destination was activated anyway", async () => {
    const h = harness();
    h.network.dropNextAnswerTo = THREAD_MOVE_ROUTES.finish;
    await start(h);
    h.clock.now += 5 * 60 * 1000;
    expect((await h.mini.activateAnyway(id(6))).body.state).toBe("committed");

    expect(await h.laptop.cancel(id(6))).toEqual({ status: "already-moved" });
    expect(h.erased).toEqual([chatThread.threadId]);
    expect(h.frozen.size).toBe(0);
  });

  it("offers Activate anyway only after the source has been silent for five minutes", async () => {
    const h = harness();
    h.network.dropNextAnswerTo = THREAD_MOVE_ROUTES.finish;
    await start(h);
    // The thread arrived on the destination but the source never heard; nothing committed.
    expect(h.arrived).toHaveLength(1);
    expect(h.active).toEqual([]);
    const moveId = id(6);
    expect((await h.mini.activateAnyway(moveId)).body.status).toBe("refused");
    h.clock.now += 5 * 60 * 1000;
    expect((await h.mini.activateAnyway(moveId)).body.state).toBe("committed");
    expect(h.active).toEqual([id(9)]);
  });

  it("lists only the Projects that would take the thread, and nothing for a member without Move in", async () => {
    const h = harness();
    expect(await h.laptop.askProjects(miniId, { mode: "chat" })).toEqual({
      status: "listed",
      projects: [{ projectId: id(4), title: "Trips" }],
      noProjectAllowed: true,
    });
    // The destination lists its Work Project, but it does not take this placement.
    expect(await h.laptop.askProjects(miniId, { mode: "work" })).toEqual({
      status: "listed",
      projects: [],
      noProjectAllowed: false,
    });
    const refused = harness({ grant: { moveIn: false } });
    expect(await refused.laptop.askProjects(miniId, { mode: "chat" })).toBe("refused");
  });

  it("lets a batch ticket open one move of each thread it names, and no other", async () => {
    const other: MovedThreadReference = { mode: "chat", threadId: id(4) };
    const elsewhere = harness();
    const notNamed = elsewhere.mini.issueTicket({
      ownerMemberId: ownerId,
      sourceMemberId: laptopId,
      threads: [other],
    });
    if (notNamed.status !== "issued") throw new Error("ticket refused");
    expect(await start(elsewhere, notNamed.ticketId)).toEqual({
      status: "failed",
      reason: "refused",
    });

    const h = harness();
    const batch = h.mini.issueTicket({
      ownerMemberId: ownerId,
      sourceMemberId: laptopId,
      threads: [other, chatThread],
    });
    if (batch.status !== "issued") throw new Error("ticket refused");
    expect((await start(h, batch.ticketId)).status).toBe("moved");
  });
});
