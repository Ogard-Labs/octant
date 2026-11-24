import {
  composerStashRecoveryKey,
  emptyComposerStashDraft,
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
  /** The text the older draft store may still show if the window closed during the move. */
  readonly beforeText: string;
  readonly draft: ComposerStashDraft;
}

const DATABASE = "octant.composer.stash";
const SAVED = "saved";
const RECOVERED = "recovered";

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
    saved.createIndex("thread", "source.threadId");
    const recovered = request.result.createObjectStore(RECOVERED);
    recovered.createIndex("thread", "location.threadId");
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
  return { location, revision: globalThis.crypto.randomUUID(), beforeText, draft };
}

async function readRecovery(
  store: IDBObjectStore,
  key: string,
): Promise<ComposerDraftRecovery | undefined> {
  return (await result(store.get(key))) as ComposerDraftRecovery | undefined;
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
    list: (host: string) =>
      inDraftStorage(factory, "readonly", async (saved) => {
        const entries = (await result(saved.index("host").getAll(host))) as SavedComposerDraft[];
        return entries.sort((left, right) => right.savedAt - left.savedAt);
      }),
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
        return cleared;
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
    purgeThread: (threadId: string) =>
      inDraftStorage(factory, "readwrite", async (saved, recovered) => {
        const [savedKeys, recoveredKeys] = await Promise.all([
          result(saved.index("thread").getAllKeys(threadId)),
          result(recovered.index("thread").getAllKeys(threadId)),
        ]);
        for (const key of savedKeys) saved.delete(key);
        for (const key of recoveredKeys) recovered.delete(key);
      }),
    dropUnknownThreads: (
      host: string,
      mode: ComposerStashLocation["mode"],
      threadIds: ReadonlyArray<string>,
    ) =>
      inDraftStorage(factory, "readwrite", async (saved, recovered) => {
        const known = new Set(threadIds);
        const missing = (location: ComposerStashLocation) =>
          location.host === host &&
          location.mode === mode &&
          location.threadId !== null &&
          !known.has(location.threadId);
        const [entries, records] = await Promise.all([
          result(saved.index("host").getAll(host)) as Promise<SavedComposerDraft[]>,
          result(recovered.getAll()) as Promise<ComposerDraftRecovery[]>,
        ]);
        for (const entry of entries) {
          if (missing(entry.source)) saved.delete(entry.id);
        }
        for (const { location } of records) {
          if (missing(location)) recovered.delete(composerStashRecoveryKey(location));
        }
      }),
  };
}

export type ComposerStashStore = ReturnType<typeof createComposerStashStore>;

export async function purgeComposerStashThread(threadId: string): Promise<void> {
  if (globalThis.indexedDB !== undefined) {
    await createComposerStashStore(globalThis.indexedDB).purgeThread(threadId);
  }
}

export async function dropUnknownComposerStashThreads(
  host: string,
  mode: ComposerStashLocation["mode"],
  threadIds: ReadonlyArray<string>,
): Promise<void> {
  if (globalThis.indexedDB !== undefined) {
    await createComposerStashStore(globalThis.indexedDB).dropUnknownThreads(host, mode, threadIds);
  }
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
