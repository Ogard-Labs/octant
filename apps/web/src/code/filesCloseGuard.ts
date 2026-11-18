import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { UnsavedFileChoice } from "./UnsavedFileDialog";
import type { CodeCheckoutId, CodeFileId } from "@octant/contracts/code";

/**
 * The unsaved-edit answer for one open Code file. Each editor registers the
 * file it shows; when the editor unmounts while its draft survives in the
 * draft store, the registration stays so a closing file tab, Files tool, or
 * thread pane asks about the draft instead of dropping it silently. Draft
 * text itself never lives here — the editor's draft store keeps it.
 */
export interface FilesCloseEntry {
  /** The owning thread: the `filesCloseScope` tuple the editors and the close paths share. */
  readonly scope: string;
  /** The document inside the scope: the editor's `modelUri`, which is also its draft-store key. */
  readonly key: string;
  /** What the prompt names the file. */
  readonly name: string;
  readonly isDirty: () => boolean;
  /** Whether the file ended clean: `false` means the close must not proceed. */
  readonly save: () => Promise<boolean>;
  readonly discard: () => void;
}

interface RegisteredEntry {
  readonly entry: FilesCloseEntry;
  /** Its editor unmounted: only a still-dirty buffer keeps the record. */
  retired: boolean;
}

/** One registered document per scope and key, in registration order. */
const entries = new Map<string, RegisteredEntry>();
const entryId = (scope: string, key: string) => JSON.stringify([scope, key]);

/**
 * Register one open document for close decisions; the returned release runs on
 * unmount. A clean release drops the record, a dirty one keeps it — the draft
 * outlives the editor, so the close question must too. Re-registering the same
 * scope and key replaces the earlier record, and an earlier release can never
 * remove a newer registration.
 */
export function registerFilesCloseEntry(entry: FilesCloseEntry): () => void {
  const id = entryId(entry.scope, entry.key);
  const record: RegisteredEntry = { entry, retired: false };
  entries.set(id, record);
  return () => {
    if (entries.get(id) !== record) return;
    if (dirty(record.entry)) {
      record.retired = true;
      return;
    }
    entries.delete(id);
  };
}

export interface FilesClosePrompt {
  readonly name: string;
  /** Set when the previous save attempt failed: the question is asked again, saying so. */
  readonly failure?: string;
  readonly answer: (choice: UnsavedFileChoice) => void;
}

let pending: FilesClosePrompt | undefined;
const promptListeners = new Set<() => void>();
/** One close decision runs at a time; a second attempt refuses rather than sharing its consent. */
let closing = false;

/** The one close question waiting on the person, for `useSyncExternalStore`. */
export function filesClosePromptSnapshot(): FilesClosePrompt | undefined {
  return pending;
}

export function subscribeFilesClosePrompt(listener: () => void): () => void {
  promptListeners.add(listener);
  return () => {
    promptListeners.delete(listener);
  };
}

function emitPrompt(): void {
  for (const listener of [...promptListeners]) listener();
}

/**
 * Whether the close may proceed. A file tab asks with its scope and key, the
 * Files tool or the thread's pane asks with the scope alone, and a native
 * window close asks with neither. Every dirty document answers once, in
 * registration order, through one prompt at a time; a close attempted while
 * another is already asking refuses rather than sharing that consent.
 *
 * The person may take any time to answer, and the registry keeps moving
 * meanwhile. An answer is only ever applied to the record the registry holds
 * for the same scope and key when it arrives — never to a stale or replaced
 * registration — and the whole target set is scanned again after each
 * document, so a file that went dirty during the wait is asked about too.
 * `signal` is the native close's release: aborting answers the current
 * prompt Cancel for this close only. `onPrompt` fires once, just before the
 * first question reaches the screen — the desktop uses it to raise the
 * window that is actually asking rather than every window it checked.
 */
export async function confirmFilesClose(
  scope?: string,
  key?: string,
  signal?: AbortSignal,
  onPrompt?: () => void,
): Promise<boolean> {
  if (closing) return false;
  closing = true;
  let prompted = false;
  try {
    for (;;) {
      if (signal?.aborted) return false;
      let target: RegisteredEntry | undefined;
      for (const [id, record] of entries) {
        if (scope !== undefined && record.entry.scope !== scope) continue;
        if (key !== undefined && record.entry.key !== key) continue;
        if (dirty(record.entry)) {
          target ??= record;
        } else if (record.retired && entries.get(id) === record) {
          entries.delete(id);
        }
      }
      if (target === undefined) return true;
      const id = entryId(target.entry.scope, target.entry.key);
      let failure: string | undefined;
      for (;;) {
        if (signal?.aborted) return false;
        if (!dirty(target.entry)) break;
        if (!prompted) {
          prompted = true;
          onPrompt?.();
        }
        const choice = await ask(target.entry.name, failure, signal);
        if (choice === "cancel") return false;
        // The prompt took time: the record the question was asked about may
        // have been replaced since. A dirty replacement never received this
        // consent, so the close refuses; a clean or absent one makes the
        // answer moot and the rescan decides again.
        if (entries.get(id) !== target) {
          const now = entries.get(id);
          if (now !== undefined && dirty(now.entry)) return false;
          break;
        }
        if (choice === "discard") {
          try {
            target.entry.discard();
          } catch {
            return false;
          }
          if (dirty(target.entry)) return false;
          break;
        }
        failure = undefined;
        const completed = await saved(target.entry);
        if (signal?.aborted) return false;
        // A re-registration under an in-flight save cannot inherit the
        // consent that save answered; the rescan meets the new record.
        if (entries.get(id) !== target) {
          const now = entries.get(id);
          if (now !== undefined && dirty(now.entry)) return false;
          break;
        }
        if (completed) break;
        failure = `${target.entry.name} could not be saved. Your edits are still here.`;
      }
      if (target.retired && !dirty(target.entry) && entries.get(id) === target) {
        entries.delete(id);
      }
    }
  } finally {
    closing = false;
  }
}

function dirty(entry: FilesCloseEntry): boolean {
  try {
    return entry.isDirty();
  } catch {
    // A checker that cannot answer is treated as dirty: closing may not proceed
    // on an answer it does not have.
    return true;
  }
}

async function saved(entry: FilesCloseEntry): Promise<boolean> {
  try {
    return await entry.save();
  } catch {
    return false;
  }
}

function ask(
  name: string,
  failure: string | undefined,
  signal?: AbortSignal,
): Promise<UnsavedFileChoice> {
  return new Promise((resolve) => {
    const prompt: FilesClosePrompt = {
      name,
      ...(failure === undefined ? {} : { failure }),
      answer: (choice) => {
        // A released prompt's stale callback must not resolve a later one.
        if (pending !== prompt) return;
        pending = undefined;
        signal?.removeEventListener("abort", released);
        emitPrompt();
        resolve(choice);
      },
    };
    const released = () => prompt.answer("cancel");
    pending = prompt;
    if (signal !== undefined) {
      if (signal.aborted) prompt.answer("cancel");
      else signal.addEventListener("abort", released, { once: true });
    }
    emitPrompt();
  });
}

/**
 * The scope every close path for one thread's files shares: the host id a
 * workspace Code thread tab carries — absent means this computer — normalized
 * the same way for registrants and closers.
 */
export function filesCloseScope(hostId: string | undefined, threadId: string): string {
  return JSON.stringify([hostId ?? String(LOCAL_HOST_ID), threadId]);
}

/** The Monaco model URI for a checkout file: also its draft-store and close-registry key. */
export function modelUri(checkoutId: CodeCheckoutId, fileId: CodeFileId): string {
  return `octant-code://${checkoutId}/${fileId}`;
}
