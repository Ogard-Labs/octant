import { useEffect, useRef } from "react";

type ThreadControl = "provider" | "access";
const targets = new Map<string, Set<() => void>>();
let pending: { readonly key: string; readonly expiresAt: number } | undefined;

/** Navigation only: the existing composer still owns every setting mutation. */
export function requestThreadControl(threadId: string, control: ThreadControl): void {
  const key = `${threadId}:${control}`;
  const target = targets.get(key)?.values().next().value;
  pending = undefined;
  if (target !== undefined) target();
  else pending = { key, expiresAt: Date.now() + 10_000 };
}

/** A pane may mount after the shell has opened the requested thread. */
export function useThreadControlNavigation(
  threadId: string | undefined,
  control: ThreadControl,
  open: () => void,
): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (threadId === undefined) return;
    const key = `${threadId}:${control}`;
    const target = () => latest.current();
    const registered = targets.get(key) ?? new Set<() => void>();
    registered.add(target);
    targets.set(key, registered);
    if (pending?.key === key) {
      const current = pending;
      pending = undefined;
      if (current.expiresAt > Date.now()) target();
    }
    return () => {
      registered.delete(target);
      if (registered.size === 0) targets.delete(key);
    };
  }, [threadId, control]);
}
