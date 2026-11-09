// The Work side of a thread move, on both computers. A Work thread moves its
// conversation, its bulk parts, and the files of the folder it works in when
// that folder is its own (workThreadMoveFolder.ts says which folder that is
// and what in it stays). The destination opens the thread in a Work Project
// the person picked there, working in the folder its files landed in. The
// conversation travels as a moved transcript the new thread's first turn
// carries once.
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
  type ThreadWorkingDirectory,
} from "@octant/contracts";
import { Schema } from "effect";
import {
  MovedThreadParts,
  measureThreadParts,
  packThreadParts,
  rehomeThreadParts,
  threadMoveSize,
  type MeasuredPartKind,
  type ThreadPartsDestination,
  type ThreadPartsSource,
} from "./movedThreadParts";
import type { ThreadMoveHolds } from "./threadMoveHolds";
import type {
  ErasedThread,
  PackedPart,
  ThreadMoveDestinationHost,
  ThreadMoveSourceHost,
} from "./threadMoveService";
import {
  captureWorkFolderForMove,
  landWorkFolderFromMove,
  measureWorkFolderForMove,
  MovedWorkFolder,
  movedAsideFolder,
  settleMovedWorkFolder,
  type WorkThreadFolder,
} from "./workThreadMoveFolder";

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
  /** The files of the thread's own folder; absent when its folder stays where it is. */
  folder: Schema.optional(MovedWorkFolder),
}).annotations(strict);
type MovedWorkThread = typeof MovedWorkThread.Type;

const decodeMovedWorkThread = Schema.decodeUnknownSync(MovedWorkThread);
const decodeWorkThreadId = Schema.decodeUnknownSync(WorkThreadId);

/**
 * What the source keeps beside a move's parts and never sends: the folder the
 * files came from and what travelled, so the erase can compare the folder
 * with it, and what that erase decided, so an erase run again after a stop
 * reports the same and removes nothing twice.
 */
const WorkFolderOnSource = Schema.Struct({
  folder: Schema.NonEmptyString,
  index: MovedWorkFolder,
  /** The erase's clean-up has started, setting files aside in this folder. */
  settling: Schema.optional(Schema.Struct({ setAside: Schema.NonEmptyString }).annotations(strict)),
  settled: Schema.optional(
    Schema.Union(
      Schema.Struct({ status: Schema.Literal("removed") }).annotations(strict),
      Schema.Struct({
        status: Schema.Literal("kept"),
        keptFiles: Schema.Array(Schema.String),
      }).annotations(strict),
    ),
  ),
}).annotations(strict);
type WorkFolderOnSource = typeof WorkFolderOnSource.Type;
const encodeWorkFolderOnSource = Schema.encodeSync(WorkFolderOnSource);
const decodeWorkFolderOnSource = Schema.decodeUnknownSync(WorkFolderOnSource);
const WORK_FOLDER_ON_SOURCE = "work-folder.json";
const WORK_FILES_PART = "work-files";

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
  /** Whether the thread is the only user of the folder it works in, judged now. */
  readonly ownFolder: (threadId: WorkThreadId) => WorkThreadFolder;
  /** Where this host keeps a move's parts: the folder `pack` is given. */
  readonly partsDirectory: (moveId: string) => string;
  readonly providerDriverKind: (providerInstanceId: string) => string | undefined;
  readonly transcript: (threadId: WorkThreadId) => Promise<ReadonlyArray<MovedHistoryEntry>>;
  readonly externalContentIngested: (threadId: string) => boolean;
  readonly purge: (threadId: WorkThreadId) => Promise<void>;
  readonly activeWorkProject: (projectId: string) => boolean;
  /** The main folder of an active Work Project here, where moved files land. */
  readonly landingRoot: (projectId: string) => string | undefined;
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
    /** Where the moved files landed, under the Project's main folder; absent for the folder itself. */
    readonly workingDirectory?: ThreadWorkingDirectory;
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

  /** The thread as its part carries it, short of its files; undefined when it cannot move. */
  const movedOf = async (thread: MovedThreadReference): Promise<MovedWorkThread | undefined> => {
    const id = idOf(thread);
    const work = id === undefined ? undefined : options.readThread(id);
    const driverKind =
      work === undefined ? undefined : options.providerDriverKind(work.providerInstanceId);
    if (id === undefined || work === undefined || driverKind === undefined) return undefined;
    return {
      format: MOVED_WORK_THREAD_FORMAT,
      title: work.title,
      providerDriverKind: driverKind,
      modelId: work.modelId as MovedWorkThread["modelId"],
      externalContentIngested: options.externalContentIngested(thread.threadId),
      entries: await options.transcript(id),
    };
  };

  /**
   * Clears what travelled from the folder the files came from, deleting only
   * what it proves travelled, and keeps the folder, listing what is left,
   * when anything is. A folder another thread has started working in since
   * the move packed is kept as it is, unless an earlier erase's clean-up had
   * already started there. Nothing is reported when no folder travelled.
   */
  const settleFolder = async (
    id: WorkThreadId,
    moveId: string,
  ): Promise<Pick<ErasedThread, "keptFolder" | "keptFiles">> => {
    const path = join(options.partsDirectory(moveId), WORK_FOLDER_ON_SOURCE);
    let onSource: WorkFolderOnSource;
    try {
      onSource = decodeWorkFolderOnSource(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return {};
    }
    const save = (note: WorkFolderOnSource) =>
      writeFile(path, JSON.stringify(encodeWorkFolderOnSource(note)), { mode: 0o600 });
    let settled = onSource.settled;
    if (settled === undefined) {
      const own = options.ownFolder(id);
      // A clean-up already started must finish, whatever the folder's use
      // now: an earlier run may have set files aside that only it can put back.
      if (
        onSource.settling !== undefined ||
        (own.status === "own" && own.folder === onSource.folder)
      ) {
        // Recorded before the first file is set aside, so the note says
        // where an interrupted clean-up left them.
        if (onSource.settling === undefined) {
          await save({
            ...onSource,
            settling: { setAside: movedAsideFolder(onSource.folder, moveId) },
          });
        }
        // Not caught: a clean-up that fails partway records no outcome, so
        // the erase runs again and the next clean-up settles what it left.
        settled = await settleMovedWorkFolder({
          folder: onSource.folder,
          index: onSource.index,
          moveId,
        });
      } else {
        settled = { status: "kept", keptFiles: [] };
      }
      await save({ ...onSource, settled });
    }
    return settled.status === "kept"
      ? { keptFolder: onSource.folder, keptFiles: settled.keptFiles }
      : {};
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
    measure: async (thread) => {
      const moved = await movedOf(thread);
      const id = idOf(thread);
      if (moved === undefined || id === undefined) return { status: "unknown" };
      // The very text pack writes, short of the lines that list the bulk
      // parts and the folder's files.
      const bytes = Buffer.byteLength(JSON.stringify(moved));
      // The files row is present exactly when the folder is the thread's own,
      // even with nothing in it, so the move sheet can say the files move.
      const own = options.ownFolder(id);
      const files: ReadonlyArray<MeasuredPartKind> =
        own.status !== "own"
          ? []
          : [
              await measureWorkFolderForMove(own.folder).then(
                (filesBytes): MeasuredPartKind => ({
                  status: "measured",
                  kind: "work-files",
                  bytes: filesBytes,
                }),
                (): MeasuredPartKind => ({ status: "unknown", kind: "work-files" }),
              ),
            ];
      return threadMoveSize([
        { status: "measured", kind: "thread-bundle", bytes },
        ...files,
        ...measureThreadParts(thread, options.parts.source),
      ]);
    },
    pack: async (thread, folder) => {
      const conversation = await movedOf(thread);
      const id = idOf(thread);
      if (conversation === undefined || id === undefined) {
        return { status: "refused", reason: "refused" };
      }
      const bulk = await packThreadParts(thread, folder, options.parts.source);
      const own = options.ownFolder(id);
      let files: MovedWorkFolder | undefined;
      const filesParts: PackedPart[] = [];
      if (own.status === "own") {
        const partPath = join(folder, `${WORK_FILES_PART}.part`);
        try {
          files = (
            await captureWorkFolderForMove({
              folder: own.folder,
              workingDirectory: own.workingDirectory,
              partId: WORK_FILES_PART,
              partPath,
            })
          ).index;
        } catch {
          return { status: "refused", reason: "transfer-failed" };
        }
        if (files.partId !== undefined) {
          filesParts.push({ partId: files.partId, kind: "work-files", path: partPath });
        }
        // Kept here before anything is sent, so the erase always finds it.
        await writeFile(
          join(folder, WORK_FOLDER_ON_SOURCE),
          JSON.stringify(encodeWorkFolderOnSource({ folder: own.folder, index: files })),
          { mode: 0o600 },
        );
      }
      const moved: MovedWorkThread = {
        ...conversation,
        ...(bulk.index === undefined ? {} : { parts: bulk.index }),
        ...(files === undefined ? {} : { folder: files }),
      };
      const path = join(folder, "thread.json");
      await writeFile(path, JSON.stringify(moved), { mode: 0o600 });
      const part: PackedPart = { partId: "thread", kind: "thread-bundle", path };
      return {
        status: "packed",
        parts: [part, ...filesParts, ...bulk.parts],
        ...(bulk.partsLeftBehind.length === 0 ? {} : { partsLeftBehind: bulk.partsLeftBehind }),
      };
    },
    erase: async ({ thread, moveId }) => {
      const id = idOf(thread);
      if (id === undefined) return { worktreeKept: false };
      // Settled before the purge, because judging the folder reads the thread.
      const kept = await settleFolder(id, String(moveId));
      await options.purge(id);
      // A Work thread owns no managed worktree; a kept folder is its own record.
      return { worktreeKept: false, ...kept };
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
      // That try landed the files before opening the thread, and may have
      // stopped before the history was kept or every part re-homed, so they
      // are now (a second import keeps the first), before the source is told
      // it arrived and erases the only other copy.
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
      let workingDirectory: ThreadWorkingDirectory | undefined;
      if (moved.folder !== undefined) {
        const filesPartId = moved.folder.partId;
        const filesPart =
          filesPartId === undefined
            ? undefined
            : offer.manifest.parts.find(
                (part) => part.partId === filesPartId && part.kind === "work-files",
              );
        const root = options.landingRoot(String(offer.destinationProjectId));
        if (root === undefined) return { status: "refused", reason: "no-eligible-project" };
        if (filesPartId !== undefined && filesPart === undefined) {
          return { status: "refused", reason: "transfer-failed" };
        }
        // Landed before the thread opens: a retry that finds the thread
        // knows its files are in place, and one that does not finds this
        // landing and uses it rather than landing a second copy.
        const landed = await landWorkFolderFromMove({
          root,
          index: moved.folder,
          partPath: filesPart === undefined ? undefined : parts.get(filesPart.partId),
          moveId: String(offer.moveId),
        }).catch(() => ({ status: "refused" as const }));
        if (landed.status === "refused") return { status: "refused", reason: "transfer-failed" };
        workingDirectory = landed.workingDirectory;
      }
      options.holds.hold(planned);
      try {
        await options.createThread({
          threadId: id,
          projectId: String(offer.destinationProjectId),
          title: moved.title,
          provider,
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
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
