// The Work side of a thread move, on both computers. A Work thread moves its
// conversation and its bulk parts, not its folder: the files the thread worked
// on stay where they are, and the destination opens the thread in a Work
// Project the person picked there. The conversation travels as a moved
// transcript the new thread's first turn carries once.
//
// A Work thread a peer delegated to this host belongs to that delegation and
// never moves.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MovedHistoryEntry,
  ProviderModelId,
  WorkThreadId,
  type MovedThreadReference,
} from "@octant/contracts";
import { Schema } from "effect";
import {
  MovedThreadParts,
  packThreadParts,
  rehomeThreadParts,
  type ThreadPartsDestination,
  type ThreadPartsSource,
} from "./movedThreadParts";
import type { ThreadMoveHolds } from "./threadMoveHolds";
import type {
  PackedPart,
  ThreadMoveDestinationHost,
  ThreadMoveSourceHost,
} from "./threadMoveService";

export const MOVED_WORK_THREAD_FORMAT = "octant.thread-move.work/1" as const;

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const MovedWorkThread = Schema.Struct({
  format: Schema.Literal(MOVED_WORK_THREAD_FORMAT),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  providerDriverKind: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  modelId: ProviderModelId,
  externalContentIngested: Schema.Boolean,
  entries: Schema.Array(MovedHistoryEntry).pipe(Schema.maxItems(10_000)),
  parts: Schema.optional(MovedThreadParts),
}).annotations(strict);
type MovedWorkThread = typeof MovedWorkThread.Type;

const decodeMovedWorkThread = Schema.decodeUnknownSync(MovedWorkThread);
const decodeWorkThreadId = Schema.decodeUnknownSync(WorkThreadId);

/** A Work thread as far as a move reads it. */
export interface MovableWorkThread {
  readonly title: string;
  readonly active: boolean;
  readonly providerInstanceId: string;
  readonly modelId: string;
}

export interface WorkThreadMoveHostOptions {
  readonly readThread: (threadId: WorkThreadId) => MovableWorkThread | undefined;
  readonly isBusy: (threadId: WorkThreadId) => boolean;
  /** Whether a peer delegated the thread to this host. */
  readonly isDelegated: (threadId: WorkThreadId) => boolean;
  readonly providerDriverKind: (providerInstanceId: string) => string | undefined;
  readonly transcript: (threadId: WorkThreadId) => Promise<ReadonlyArray<MovedHistoryEntry>>;
  readonly externalContentIngested: (threadId: string) => boolean;
  readonly purge: (threadId: WorkThreadId) => Promise<void>;
  readonly activeWorkProject: (projectId: string) => boolean;
  readonly resolveProvider: (
    driverKind: string,
    modelId: string,
  ) => { readonly providerInstanceId: string; readonly modelId: string } | undefined;
  /** Opens a Work thread in a Project under the host's own scope. */
  readonly createThread: (input: {
    readonly threadId: WorkThreadId;
    readonly projectId: string;
    readonly title: string;
    readonly provider: { readonly providerInstanceId: string; readonly modelId: string };
    /** Set when the source thread had read outside content; the new thread starts marked too. */
    readonly inheritedMark?: { readonly sourceLabel: string; readonly contentReference: string };
  }) => Promise<void>;
  readonly journalHistory: (input: {
    readonly threadId: string;
    readonly moveId: string;
    readonly entries: ReadonlyArray<MovedHistoryEntry>;
  }) => void;
  readonly holds: ThreadMoveHolds;
  readonly parts: {
    readonly source: ThreadPartsSource;
    readonly destination: ThreadPartsDestination;
  };
}

export function createWorkThreadMoveHost(options: WorkThreadMoveHostOptions): {
  readonly source: ThreadMoveSourceHost;
  readonly destination: ThreadMoveDestinationHost;
} {
  const idOf = (thread: MovedThreadReference): WorkThreadId | undefined => {
    if (thread.mode !== "work") return undefined;
    try {
      return decodeWorkThreadId(thread.threadId);
    } catch {
      return undefined;
    }
  };
  const workThreadOf = (thread: MovedThreadReference) => {
    const id = idOf(thread);
    return id === undefined ? undefined : options.readThread(id);
  };

  const source: ThreadMoveSourceHost = {
    read: async (thread) => {
      const id = idOf(thread);
      const work = id === undefined ? undefined : options.readThread(id);
      if (id === undefined || work === undefined || !work.active) return { status: "missing" };
      return {
        status: "found",
        title: work.title,
        busy: options.isBusy(id),
        delegated: options.isDelegated(id),
        repositoryRemotes: [],
      };
    },
    freeze: (thread) => options.holds.hold(thread),
    unfreeze: (thread) => options.holds.release(thread),
    isFrozen: (thread) => options.holds.isHeld(thread),
    pack: async (thread, folder) => {
      const id = idOf(thread);
      const work = id === undefined ? undefined : options.readThread(id);
      const driverKind =
        work === undefined ? undefined : options.providerDriverKind(work.providerInstanceId);
      if (id === undefined || work === undefined || driverKind === undefined) {
        return { status: "refused", reason: "refused" };
      }
      const bulk = await packThreadParts(thread, folder, options.parts.source);
      const moved: MovedWorkThread = {
        format: MOVED_WORK_THREAD_FORMAT,
        title: work.title,
        providerDriverKind: driverKind,
        modelId: work.modelId as MovedWorkThread["modelId"],
        externalContentIngested: options.externalContentIngested(thread.threadId),
        entries: await options.transcript(id),
        ...(bulk.index === undefined ? {} : { parts: bulk.index }),
      };
      const path = join(folder, "thread.json");
      await writeFile(path, JSON.stringify(moved), { mode: 0o600 });
      const part: PackedPart = { partId: "thread", kind: "thread-bundle", path };
      return {
        status: "packed",
        parts: [part, ...bulk.parts],
        ...(bulk.partsLeftBehind.length === 0 ? {} : { partsLeftBehind: bulk.partsLeftBehind }),
      };
    },
    erase: async ({ thread }) => {
      const id = idOf(thread);
      if (id !== undefined) await options.purge(id);
      // A Work thread owns no worktree; its folder is the person's.
      return { worktreeKept: false };
    },
  };

  const destination: ThreadMoveDestinationHost = {
    acceptsProject: (placement) =>
      placement.mode === "work" &&
      placement.destinationProjectId !== undefined &&
      options.activeWorkProject(placement.destinationProjectId),
    arrive: async ({ thread: planned, offer, parts }) => {
      const id = idOf(planned);
      if (id === undefined || offer.destinationProjectId === undefined) {
        return { status: "refused", reason: "transfer-failed" };
      }
      const bundle = offer.manifest.parts.find((part) => part.kind === "thread-bundle");
      const path = bundle === undefined ? undefined : parts.get(bundle.partId);
      if (path === undefined) return { status: "refused", reason: "transfer-failed" };
      let moved: MovedWorkThread;
      try {
        moved = decodeMovedWorkThread(JSON.parse(await readFile(path, "utf8")));
      } catch {
        return { status: "refused", reason: "transfer-failed" };
      }
      const history = {
        threadId: planned.threadId,
        moveId: String(offer.moveId),
        entries: moved.entries,
      };
      // Bulk parts are re-homed under ids the move derives, so a second try
      // records nothing twice.
      const rehome = async () =>
        (
          await rehomeThreadParts({
            index: moved.parts,
            parts,
            moveId: String(offer.moveId),
            thread: planned,
            projectId: String(offer.destinationProjectId),
            destination: options.parts.destination,
          })
        ).status === "carried"
          ? ({ status: "arrived", thread: planned } as const)
          : ({ status: "refused", reason: "transfer-failed" } as const);
      // A thread already opened under the planned id was opened by an earlier
      // try that stopped before it was recorded: hold it and open no second.
      // That try may have stopped before the history was kept or every part
      // re-homed, so they are now (a second import keeps the first), before
      // the source is told it arrived and erases the only other copy.
      if (workThreadOf(planned) !== undefined) {
        options.holds.hold(planned);
        options.journalHistory(history);
        return rehome();
      }
      if (!options.activeWorkProject(String(offer.destinationProjectId))) {
        return { status: "refused", reason: "no-eligible-project" };
      }
      const provider = options.resolveProvider(moved.providerDriverKind, String(moved.modelId));
      if (provider === undefined) return { status: "refused", reason: "no-matching-provider" };
      options.holds.hold(planned);
      try {
        await options.createThread({
          threadId: id,
          projectId: String(offer.destinationProjectId),
          title: moved.title,
          provider,
          ...(moved.externalContentIngested
            ? {
                inheritedMark: {
                  sourceLabel: "moved-thread",
                  contentReference: `moved-thread-${String(offer.moveId)}`,
                },
              }
            : {}),
        });
      } catch {
        options.holds.release(planned);
        return { status: "refused", reason: "transfer-failed" };
      }
      options.journalHistory(history);
      return rehome();
    },
    activate: async (thread) => options.holds.release(thread),
    discard: async (thread) => {
      options.holds.release(thread);
      const id = idOf(thread);
      if (id !== undefined && options.readThread(id) !== undefined) await options.purge(id);
    },
  };

  return { source, destination };
}
