import type { ThreadMentionCandidate } from "@octant/contracts";
import {
  appendThreadMentionChip,
  composerThreadDropCandidate,
  composerThreadDropLocalRefusal,
  composerThreadDropMessage,
} from "@octant/domain";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";

/**
 * A composer that can receive a sidebar thread as a mention. The shell finds
 * the zone under the pointer; the zone's attach function is the mention path,
 * not a second way to read a thread.
 */
export interface ComposerThreadDropTarget {
  readonly key: string;
  readonly attach: (input: {
    readonly threadId: string;
    readonly searchHint?: string;
  }) => Promise<void>;
}

const targets = new Map<string, ComposerThreadDropTarget>();
let activeKey: string | undefined;
let announcement = "";
let focusedKey: string | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetComposerThreadDropStore(): void {
  targets.clear();
  activeKey = undefined;
  announcement = "";
  focusedKey = undefined;
  emit();
}

export function registerComposerThreadDrop(target: ComposerThreadDropTarget): () => void {
  targets.set(target.key, target);
  return () => {
    targets.delete(target.key);
    if (focusedKey === target.key) focusedKey = undefined;
  };
}

export function focusComposerThreadDrop(key: string): void {
  if (!targets.has(key) || focusedKey === key) return;
  focusedKey = key;
}

/** The composer under a pointer, measured the same way pane drop rects are. */
export function measureComposerThreadDropZones(
  root: ParentNode = document,
): ReadonlyArray<{ readonly key: string; readonly rect: DOMRect }> {
  return [...root.querySelectorAll<HTMLElement>("[data-composer-thread-drop]")].flatMap((zone) => {
    const key = zone.dataset.composerThreadDrop;
    if (key === undefined || key.length === 0) return [];
    const rect = zone.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    return [{ key, rect }];
  });
}

export function setActiveComposerThreadDropKey(key: string | undefined): void {
  if (activeKey === key) return;
  activeKey = key;
  emit();
}

export function useActiveComposerThreadDropKey(): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => activeKey,
    () => activeKey,
  );
}

export function useComposerThreadDropAnnouncement(): string {
  return useSyncExternalStore(
    subscribe,
    () => announcement,
    () => announcement,
  );
}

export function announceComposerThreadDrop(message: string): void {
  if (announcement === message) return;
  announcement = message;
  emit();
}

export function focusedComposerThreadDrop(): ComposerThreadDropTarget | undefined {
  if (focusedKey !== undefined) {
    const focused = targets.get(focusedKey);
    if (focused !== undefined) return focused;
  }
  if (targets.size !== 1) return undefined;
  return [...targets.values()][0];
}

export function composerThreadDropTarget(key: string): ComposerThreadDropTarget | undefined {
  return targets.get(key);
}

/**
 * Drop or keyboard attach for one registered composer. A missing registration
 * keeps the draft where it is and says so, rather than opening the thread.
 */
export async function deliverComposerThreadDrop(input: {
  readonly composerKey?: string;
  readonly threadId: string;
  readonly searchHint?: string;
}): Promise<void> {
  const target =
    input.composerKey === undefined
      ? focusedComposerThreadDrop()
      : composerThreadDropTarget(input.composerKey);
  if (target === undefined) {
    announceComposerThreadDrop("Focus a composer before attaching a thread.");
    return;
  }
  await target.attach({
    threadId: input.threadId,
    ...(input.searchHint === undefined ? {} : { searchHint: input.searchHint }),
  });
}

export interface ComposerThreadDropAttach {
  (input: {
    readonly threadId: string;
    readonly searchHint?: string;
    readonly currentThreadId?: string;
    readonly onDraftChange: (draft: string, caretIndex: number) => void;
  }): Promise<void>;
}

export function useComposerThreadDropRegistration(options: {
  readonly enabled: boolean;
  readonly currentThreadId?: string;
  readonly onDraftChange: (draft: string, caretIndex: number) => void;
  readonly attachDroppedThread: ComposerThreadDropAttach;
}): string | undefined {
  const key = useId();
  const onDraftChangeRef = useRef(options.onDraftChange);
  onDraftChangeRef.current = options.onDraftChange;
  const currentThreadIdRef = useRef(options.currentThreadId);
  currentThreadIdRef.current = options.currentThreadId;
  const attachRef = useRef(options.attachDroppedThread);
  attachRef.current = options.attachDroppedThread;

  useEffect(() => {
    if (!options.enabled) return;
    return registerComposerThreadDrop({
      key,
      attach: (input) =>
        attachRef.current({
          threadId: input.threadId,
          ...(input.searchHint === undefined ? {} : { searchHint: input.searchHint }),
          ...(currentThreadIdRef.current === undefined
            ? {}
            : { currentThreadId: currentThreadIdRef.current }),
          onDraftChange: (draft, caretIndex) => onDraftChangeRef.current(draft, caretIndex),
        }),
    });
  }, [key, options.enabled]);

  return options.enabled ? key : undefined;
}

export function ComposerThreadDropAnnouncer() {
  const message = useComposerThreadDropAnnouncement();
  return (
    <div aria-live="polite" className="sr-only">
      {message}
    </div>
  );
}

/**
 * Ask the host's mention search whether this id is openable, then insert the
 * same chip an explicit selection would. The search hint only ranks the
 * existing openable set; it never becomes the chip title.
 */
export async function attachComposerThreadMention(input: {
  readonly threadId: string;
  readonly searchHint?: string;
  readonly currentThreadId?: string;
  readonly existingThreadIds: ReadonlyArray<string>;
  readonly mentionCount: number;
  readonly draft: string;
  readonly search: (query: string) => Promise<ReadonlyArray<ThreadMentionCandidate>>;
  readonly onDraftChange: (draft: string, caretIndex: number) => void;
  readonly onSelectCandidate: (candidate: ThreadMentionCandidate) => void;
  readonly onStatus: (message: string) => void;
}): Promise<void> {
  const local = composerThreadDropLocalRefusal({
    payloadThreadId: input.threadId,
    existingThreadIds: input.existingThreadIds,
    mentionCount: input.mentionCount,
    ...(input.currentThreadId === undefined ? {} : { currentThreadId: input.currentThreadId }),
  });
  if (local !== undefined) {
    input.onStatus(composerThreadDropMessage(local));
    announceComposerThreadDrop(composerThreadDropMessage(local));
    return;
  }
  let openable: ReadonlyArray<ThreadMentionCandidate>;
  try {
    openable = await input.search(input.searchHint ?? "");
  } catch {
    const message = composerThreadDropMessage("unreadable");
    input.onStatus(message);
    announceComposerThreadDrop(message);
    return;
  }
  const candidate = composerThreadDropCandidate(input.threadId, openable);
  if (candidate === undefined) {
    const message = composerThreadDropMessage("unavailable");
    input.onStatus(message);
    announceComposerThreadDrop(message);
    return;
  }
  const applied = appendThreadMentionChip(input.draft, candidate.title);
  input.onDraftChange(applied.draft, applied.caretIndex);
  input.onSelectCandidate(candidate);
  const message = composerThreadDropMessage("attached");
  input.onStatus(message);
  announceComposerThreadDrop(message);
}
