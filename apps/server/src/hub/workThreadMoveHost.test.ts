import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MovedThreadReference, ThreadMoveId, ThreadMoveOffer } from "@octant/contracts";
import { createThreadMoveHolds } from "./threadMoveHolds";
import { createWorkThreadMoveHost, type WorkThreadMoveHostOptions } from "./workThreadMoveHost";

const THREAD = "77777777-7777-4777-8777-777777777777";
const ARRIVING = "88888888-8888-4888-8888-888888888888";
const MOVE = "99999999-9999-4999-8999-999999999999" as ThreadMoveId;
const PROJECT = "55555555-5555-4555-8555-555555555555";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function host(overrides: Partial<WorkThreadMoveHostOptions> = {}) {
  const created: string[] = [];
  const marks: Array<{ readonly sourceLabel: string; readonly contentReference: string }> = [];
  const histories: string[] = [];
  const holds = createThreadMoveHolds();
  const moveHost = createWorkThreadMoveHost({
    readThread: (id) =>
      String(id) === THREAD || created.includes(String(id))
        ? {
            title: "Plan the offsite",
            active: true,
            providerInstanceId: "11111111-1111-4111-8111-111111111111",
            modelId: "model-a",
          }
        : undefined,
    isBusy: () => false,
    isDelegated: () => false,
    providerDriverKind: () => "codex",
    transcript: async () => [
      { role: "person", text: "Draft an agenda", occurredAt: "2026-11-08T10:00:00.000Z" as never },
    ],
    externalContentIngested: () => false,
    purge: async () => {},
    activeWorkProject: (projectId) => projectId === PROJECT,
    resolveProvider: (driverKind, modelId) =>
      driverKind === "codex"
        ? { providerInstanceId: "22222222-2222-4222-8222-222222222222", modelId }
        : undefined,
    createThread: async (input) => {
      created.push(String(input.threadId));
      if (input.inheritedMark !== undefined) marks.push(input.inheritedMark);
    },
    journalHistory: (input) => histories.push(input.threadId),
    holds,
    ...overrides,
  });
  return { moveHost, created, histories, holds, marks };
}

async function packAndOffer(moveHost: ReturnType<typeof host>["moveHost"]) {
  const folder = mkdtempSync(join(tmpdir(), "octant-work-move-"));
  folders.push(folder);
  const packed = await moveHost.source.pack({ mode: "work", threadId: THREAD }, folder, MOVE);
  if (packed.status !== "packed") throw new Error("Nothing was packed.");
  const offer = {
    moveId: MOVE,
    source: { mode: "work", threadId: THREAD },
    title: "Plan the offsite",
    destinationProjectId: PROJECT,
    manifest: {
      parts: packed.parts.map((part) => ({ ...part, bytes: 1, sha256: "a".repeat(64) })),
    },
  } as unknown as ThreadMoveOffer;
  return { offer, parts: new Map(packed.parts.map((part) => [part.partId, part.path])) };
}

const arriveWith = (
  moveHost: ReturnType<typeof host>["moveHost"],
  offer: ThreadMoveOffer,
  parts: ReadonlyMap<string, string>,
) => {
  const planned: MovedThreadReference = { mode: "work", threadId: ARRIVING };
  return moveHost.destination.arrive({
    thread: planned,
    offer,
    parts,
    origin: { memberId: "x" as never, thread: { mode: "work", threadId: THREAD } },
    ownerMemberId: "y" as never,
  });
};

describe("moving a Work thread", () => {
  it("moves the conversation and opens the thread held, with its history, in the chosen Project", async () => {
    const { moveHost, created, histories, holds } = host();
    const { offer, parts } = await packAndOffer(moveHost);
    expect(await moveHost.destination.acceptsProject(placementOf(offer))).toBe(true);

    expect(await arriveWith(moveHost, offer, parts)).toEqual({
      status: "arrived",
      thread: { mode: "work", threadId: ARRIVING },
    });
    expect(created).toEqual([ARRIVING]);
    expect(histories).toEqual([ARRIVING]);
    expect(holds.isHeld({ mode: "work", threadId: ARRIVING })).toBe(true);

    // A retried arrival after a stop opens no second thread.
    await arriveWith(moveHost, offer, parts);
    expect(created).toEqual([ARRIVING]);
  });

  it("opens the thread marked when the source thread had read outside content", async () => {
    const { moveHost, marks } = host({ externalContentIngested: () => true });
    const { offer, parts } = await packAndOffer(moveHost);
    await arriveWith(moveHost, offer, parts);
    expect(marks).toEqual([
      { sourceLabel: "moved-thread", contentReference: `moved-thread-${MOVE}` },
    ]);
  });

  it("never moves a thread a peer delegated here", async () => {
    const { moveHost } = host({ isDelegated: () => true });
    const read = await moveHost.source.read({ mode: "work", threadId: THREAD });
    expect(read.status === "found" && read.delegated).toBe(true);
  });

  it("refuses a destination without the provider kind the thread ran on", async () => {
    const { moveHost, created } = host({ resolveProvider: () => undefined });
    const { offer, parts } = await packAndOffer(moveHost);
    expect(await arriveWith(moveHost, offer, parts)).toEqual({
      status: "refused",
      reason: "no-matching-provider",
    });
    expect(created).toEqual([]);
  });

  it("keeps the history before answering when an earlier try opened the thread but stopped first", async () => {
    let stopBeforeHistory = true;
    const histories: string[] = [];
    const { moveHost, created } = host({
      journalHistory: (input) => {
        if (stopBeforeHistory) {
          stopBeforeHistory = false;
          throw new Error("The host stopped after opening the thread.");
        }
        histories.push(input.threadId);
      },
    });
    const { offer, parts } = await packAndOffer(moveHost);
    await expect(arriveWith(moveHost, offer, parts)).rejects.toThrow("stopped");

    expect(await arriveWith(moveHost, offer, parts)).toEqual({
      status: "arrived",
      thread: { mode: "work", threadId: ARRIVING },
    });
    expect(created).toEqual([ARRIVING]);
    expect(histories).toEqual([ARRIVING]);
  });
});

function placementOf(offer: ThreadMoveOffer) {
  return {
    mode: offer.source.mode,
    ...(offer.destinationProjectId === undefined
      ? {}
      : { destinationProjectId: String(offer.destinationProjectId) }),
    ...(offer.repositoryRemotes === undefined
      ? {}
      : { repositoryRemotes: offer.repositoryRemotes }),
  };
}
