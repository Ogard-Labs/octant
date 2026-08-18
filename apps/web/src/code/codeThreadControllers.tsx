import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeThreadId } from "@octant/contracts/code";
import { memo, useCallback, useEffect, useSyncExternalStore } from "react";
import {
  useCodeController,
  type CodeController,
  type CodeReadCursorStore,
} from "./useCodeController";

/**
 * The Code threads a window currently has open, each with its own controller.
 *
 * A Code thread's surfaces are spread across the split tree — overview, diff,
 * terminal, tests, Git — so the controller cannot live with any one of them.
 * It cannot live with the window either: one controller for the window means
 * one thread's transcript, runtime, and stream, and every other open Code
 * thread renders the active thread's state or nothing at all.
 *
 * So the window keeps one controller per open thread and every surface reads
 * the one for the thread it is bound to. Threads share the read cursors and
 * the client; they share no view, no draft, no turn, and no stream.
 */
export interface CodeThreadControllers {
  readonly get: (threadId: CodeThreadId) => CodeController | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface CodeThreadControllerRegistry extends CodeThreadControllers {
  readonly publish: (threadId: CodeThreadId, controller: CodeController) => void;
  readonly release: (threadId: CodeThreadId) => void;
}

export function createCodeThreadControllers(): CodeThreadControllerRegistry {
  const byThread = new Map<string, CodeController>();
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: (threadId) => byThread.get(String(threadId)),
    publish: (threadId, controller) => {
      const key = String(threadId);
      if (byThread.get(key) === controller) return;
      byThread.set(key, controller);
      announce();
    },
    release: (threadId) => {
      if (!byThread.delete(String(threadId))) return;
      announce();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Reads one thread's controller, and re-renders the caller when that thread's
 * state moves. A caller never sees another thread's controller: an unopened
 * thread reads as absent, which surfaces render as their own loading state
 * rather than borrowing whatever thread happens to be in front.
 */
export function useCodeThreadController(
  controllers: CodeThreadControllers | undefined,
  threadId: CodeThreadId | undefined,
): CodeController | undefined {
  const subscribe = useCallback(
    (listener: () => void) => controllers?.subscribe(listener) ?? (() => undefined),
    [controllers],
  );
  const read = useCallback(
    () =>
      controllers === undefined || threadId === undefined ? undefined : controllers.get(threadId),
    [controllers, threadId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

export interface CodeThreadControllerSlotsProps {
  readonly registry: CodeThreadControllerRegistry;
  readonly threadIds: ReadonlyArray<CodeThreadId>;
  readonly client: CodeClient;
  readonly readCursorStore: CodeReadCursorStore;
}

/**
 * Holds a controller open for every Code thread the window has open.
 *
 * Rendered once, near the top of the shell, and draws nothing. Its position in
 * the tree is deliberate: a controller has to outlive the panes that read it,
 * because closing a diff tab must not tear down the turn that thread is
 * running.
 */
export function CodeThreadControllerSlots(props: CodeThreadControllerSlotsProps) {
  return (
    <>
      {props.threadIds.map((threadId) => (
        <CodeThreadControllerSlot
          client={props.client}
          key={String(threadId)}
          readCursorStore={props.readCursorStore}
          registry={props.registry}
          threadId={threadId}
        />
      ))}
    </>
  );
}

/**
 * One thread's controller.
 *
 * Memoized on purpose. Publishing wakes every surface reading this thread, and
 * the shell is one of them; without this, the shell's own re-render would come
 * straight back through here as another publish.
 */
const CodeThreadControllerSlot = memo(function CodeThreadControllerSlot(props: {
  readonly client: CodeClient;
  readonly readCursorStore: CodeReadCursorStore;
  readonly registry: CodeThreadControllerRegistry;
  readonly threadId: CodeThreadId;
}) {
  const controller = useCodeController({
    activeThreadId: props.threadId,
    client: props.client,
    // The thread list is the shell's to re-read. A poll per open thread would
    // ask the host for the same list several times a second and answer nothing
    // this thread's own stream does not already report.
    navigationRefreshMs: 0,
    readCursorStore: props.readCursorStore,
  });
  const { registry, threadId } = props;
  useEffect(() => {
    registry.publish(threadId, controller);
  });
  useEffect(() => () => registry.release(threadId), [registry, threadId]);
  return null;
});
