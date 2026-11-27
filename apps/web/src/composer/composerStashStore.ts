import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type {
  ThreadPurgeTombstone,
  ThreadRetentionState,
} from "@octant/contracts/thread-retention";
import {
  composerStashRecoveryKey,
  emptyComposerStashDraft,
  hasComposerStashContent,
  type ComposerStashDraft,
  type ComposerStashLocation,
} from "./composerStashDraft";

export interface SavedComposerDraft {
  readonly id: string;
  readonly source: ComposerStashLocation;
  readonly savedAt: number;
  readonly draft: ComposerStashDraft;
}

export interface ComposerDraftRecovery {
  readonly location: ComposerStashLocation;
  readonly revision: string;
  /** Older recovery records had no date and sort below dated drafts. */
  readonly updatedAt?: number;
  /** The text the older draft store may still show if the window closed during the move. */
  readonly beforeText: string;
  readonly draft: ComposerStashDraft;
}

const DATABASE = "octant.composer.stash";
const SAVED = "saved";
const RECOVERED = "recovered";
type PurgedThread = Pick<ThreadPurgeTombstone, "mode"> & { readonly threadId: string };

function windowLock(windowId: string): string {
  return `octant.composer.window.${windowId}`;
}

async function holdWindow(windowId: string, signal: AbortSignal): Promise<void> {
  await navigator.locks?.request(windowLock(windowId), { mode: "shared", signal }, () => {
    if (signal.aborted) return;
    return new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
}

function result<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Draft storage was interrupted."));
  });
}

async function open(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    const saved = request.result.createObjectStore(SAVED, { keyPath: "id" });
    saved.createIndex("host", "source.host");
    request.result.createObjectStore(RECOVERED);
  };
  return result(request);
}

async function inDraftStorage<Value>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  use: (saved: IDBObjectStore, recovered: IDBObjectStore) => Promise<Value>,
): Promise<Value> {
  const database = await open(factory);
  try {
    const transaction = database.transaction([SAVED, RECOVERED], mode);
    const done = settled(transaction);
    void done.catch(() => undefined);
    try {
      const value = await use(transaction.objectStore(SAVED), transaction.objectStore(RECOVERED));
      await done;
      return value;
    } catch (error) {
      // A synchronous clone error does not abort IndexedDB by itself.
      try {
        transaction.abort();
      } catch {
        // A request may already have aborted the transaction.
      }
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

function recovery(
  location: ComposerStashLocation,
  beforeText: string,
  draft: ComposerStashDraft,
): ComposerDraftRecovery {
  return {
    location,
    revision: globalThis.crypto.randomUUID(),
    updatedAt: Date.now(),
    beforeText,
    draft,
  };
}

async function readRecovery(
  store: IDBObjectStore,
  key: string,
): Promise<ComposerDraftRecovery | undefined> {
  return (await result(store.get(key))) as ComposerDraftRecovery | undefined;
}

async function recoverClosedWindows(factory: IDBFactory, host: string): Promise<void> {
  const locks = globalThis.navigator?.locks;
  if (locks === undefined) return;
  const records = await inDraftStorage(
    factory,
    "readonly",
    (_, recovered) => result(recovered.getAll()) as Promise<ComposerDraftRecovery[]>,
  );
  for (const record of records) {
    const { location, draft, revision } = record;
    const { windowId } = location;
    if (
      location.host !== host ||
      location.threadId !== null ||
      windowId === undefined ||
      !hasComposerStashContent(draft)
    ) {
      continue;
    }
    // A live renderer holds a shared lock for its window. The browser releases
    // it on close or crash, and two windows cannot publish the same recovery.
    await locks.request(windowLock(windowId), { ifAvailable: true }, (lock) => {
      if (lock === null) return;
      return inDraftStorage(factory, "readwrite", async (saved, recovered) => {
        const key = composerStashRecoveryKey(location);
        if ((await readRecovery(recovered, key))?.revision !== revision) return;
        saved.add({
          id: globalThis.crypto.randomUUID(),
          source: location,
          savedAt: record.updatedAt ?? 0,
          draft,
        } satisfies SavedComposerDraft);
        recovered.delete(key);
      });
    });
  }
}

interface ComposerDraftMove {
  readonly location: ComposerStashLocation;
  readonly expectedRevision: string | undefined;
  readonly beforeText: string;
  readonly stillCurrent: () => boolean;
}

/** IndexedDB keeps the exact file bytes and serializes a move across renderer windows. */
export function createComposerStashStore(factory: IDBFactory) {
  return {
    list: async (host: string) => {
      await recoverClosedWindows(factory, host);
      return inDraftStorage(factory, "readonly", async (saved) => {
        const entries = (await result(saved.index("host").getAll(host))) as SavedComposerDraft[];
        return entries.sort((left, right) => right.savedAt - left.savedAt);
      });
    },
    readRecovery: (location: ComposerStashLocation) =>
      inDraftStorage(factory, "readonly", (_, recovered) =>
        readRecovery(recovered, composerStashRecoveryKey(location)),
      ),
    stash: (move: ComposerDraftMove, draft: ComposerStashDraft) =>
      inDraftStorage(factory, "readwrite", async (saved, recovered) => {
        const key = composerStashRecoveryKey(move.location);
        const previous = await readRecovery(recovered, key);
        if (previous?.revision !== move.expectedRevision || !move.stillCurrent()) return undefined;
        const entry: SavedComposerDraft = {
          id: globalThis.crypto.randomUUID(),
          source: move.location,
          savedAt: Date.now(),
          draft,
        };
        const cleared = recovery(move.location, move.beforeText, emptyComposerStashDraft());
        saved.add(entry);
        recovered.put(cleared, key);
        return { ...cleared, savedDraftId: entry.id };
      }),
    restore: (id: string, move: ComposerDraftMove, draft: ComposerStashDraft) =>
      inDraftStorage(factory, "readwrite", async (saved, recovered) => {
        const key = composerStashRecoveryKey(move.location);
        const [entry, previous] = await Promise.all([
          result(saved.get(id)) as Promise<SavedComposerDraft | undefined>,
          readRecovery(recovered, key),
        ]);
        if (
          entry?.source.host !== move.location.host ||
          previous?.revision !== move.expectedRevision ||
          !move.stillCurrent()
        ) {
          return undefined;
        }
        const restored = recovery(move.location, move.beforeText, draft);
        recovered.put(restored, key);
        saved.delete(id);
        return restored;
      }),
    revise: (
      previous: ComposerDraftRecovery,
      draft: ComposerStashDraft,
      beforeText: string,
      location = previous.location,
    ) =>
      inDraftStorage(factory, "readwrite", async (_, recovered) => {
        const key = composerStashRecoveryKey(previous.location);
        if ((await readRecovery(recovered, key))?.revision !== previous.revision) return undefined;
        const revised = recovery(location, beforeText, draft);
        recovered.put(revised, key);
        return revised;
      }),
    retire: (previous: ComposerDraftRecovery) =>
      inDraftStorage(factory, "readwrite", async (_, recovered) => {
        const key = composerStashRecoveryKey(previous.location);
        if ((await readRecovery(recovered, key))?.revision !== previous.revision) return false;
        recovered.delete(key);
        return true;
      }),
    discardNewTaskRecovery: (composerId: string, windowId?: string) =>
      inDraftStorage(factory, "readwrite", async (_, recovered) => {
        const records = (await result(recovered.getAll())) as ComposerDraftRecovery[];
        for (const { location } of records) {
          if (
            location.threadId === null &&
            location.composerId === composerId &&
            location.windowId === windowId
          ) {
            recovered.delete(composerStashRecoveryKey(location));
          }
        }
      }),
    discard: (id: string, host: string) =>
      inDraftStorage(factory, "readwrite", async (saved) => {
        const entry = (await result(saved.get(id))) as SavedComposerDraft | undefined;
        if (entry?.source.host === host) saved.delete(id);
      }),
    removePurgedThreads: (host: string, threads: ReadonlyArray<PurgedThread>) =>
      inDraftStorage(factory, "readwrite", async (saved, recovered) => {
        const purged = new Set(threads.map(({ mode, threadId }) => `${mode}:${threadId}`));
        const wasPurged = (location: ComposerStashLocation) =>
          location.host === host &&
          location.threadId !== null &&
          purged.has(`${location.mode}:${location.threadId}`);
        const [entries, records] = await Promise.all([
          result(saved.index("host").getAll(host)) as Promise<SavedComposerDraft[]>,
          result(recovered.getAll()) as Promise<ComposerDraftRecovery[]>,
        ]);
        for (const entry of entries) {
          if (wasPurged(entry.source)) saved.delete(entry.id);
        }
        for (const { location } of records) {
          if (wasPurged(location)) recovered.delete(composerStashRecoveryKey(location));
        }
      }),
  };
}

export type ComposerStashStore = ReturnType<typeof createComposerStashStore>;

export async function removePurgedComposerDrafts(
  host: string,
  threads: ReadonlyArray<PurgedThread>,
): Promise<void> {
  if (threads.length > 0 && globalThis.indexedDB !== undefined) {
    await createComposerStashStore(globalThis.indexedDB).removePurgedThreads(host, threads);
  }
}

export async function reconcileComposerStashPurges(
  host: string,
  readRetention: () => Promise<ThreadRetentionState | undefined>,
  signal?: AbortSignal,
): Promise<void> {
  if (globalThis.indexedDB === undefined || signal?.aborted) return;
  try {
    const retention = await readRetention();
    if (retention !== undefined && !signal?.aborted) {
      await removePurgedComposerDrafts(host, retention.tombstones);
    }
  } catch {
    // A failed read cannot establish that an existing draft may be removed.
  }
}

export function connectComposerStashWindow(
  windowId: string,
  client: Pick<HostControlClient, "readThreadRetention">,
  signal: AbortSignal,
): void {
  if (globalThis.indexedDB === undefined || signal.aborted) return;
  void holdWindow(windowId, signal).catch(() => undefined);
  const reconcilePurges = () => {
    // Navigation bootstraps can hide archived threads and Projects.
    void reconcileComposerStashPurges(LOCAL_HOST_ID, client.readThreadRetention, signal);
  };
  window.addEventListener("focus", reconcilePurges, { signal });
  reconcilePurges();
}

export async function discardComposerNewTaskRecovery(
  composerId: string,
  windowId?: string,
): Promise<void> {
  if (globalThis.indexedDB !== undefined) {
    await createComposerStashStore(globalThis.indexedDB).discardNewTaskRecovery(
      composerId,
      windowId,
    );
  }
}
