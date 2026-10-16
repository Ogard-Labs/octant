import { useInsertionEffect, useRef, useState } from "react";

type ActionMap = Readonly<Record<string, (...args: never) => unknown>>;

/**
 * One function identity per shell action for the life of the shell, each call
 * forwarded to the action the newest committed render defined.
 *
 * The shell's actions close over its state, so every render defines them
 * anew. Passed straight down as props they made every surface re-render
 * whenever the shell did: a streaming turn re-rendered the sidebar, the dock
 * and the chrome once per event. A surface wrapped in `memo` bails out only
 * while its props keep their identity, and these forwarders do.
 *
 * The newest actions are published from an insertion effect, not during
 * render: under concurrent rendering a render can be interrupted or abandoned
 * while the UI it would replace stays on screen and interactive, and a click
 * there must run the closures of the UI it clicked, never those of a render
 * that never committed (an uncommitted thread, Project or permission choice).
 * Insertion effects run before any layout effect of the same commit, so a
 * child effect that calls an action already reaches the committed set.
 *
 * `read` runs once on mount to learn the action names and then only when an
 * action is called, so it may reference functions declared anywhere in the
 * shell's body (function declarations hoist) as long as the values they close
 * over exist by the time a surface can call them. Actions are for events and
 * effects; a value a surface needs while rendering is a prop, not an action.
 */
export function useStableActions<T extends ActionMap>(read: () => T): T {
  const committed = useRef(read);
  useInsertionEffect(() => {
    committed.current = read;
  });
  const [stable] = useState(() => {
    const forwarders = new Map<string, (...args: ReadonlyArray<unknown>) => unknown>();
    // The first read is only the proxy's target: its keys say which names are
    // actions, and every property read answers with that name's forwarder.
    return new Proxy(read(), {
      get(target, key) {
        if (typeof key === "symbol" || !Object.hasOwn(target, key)) return Reflect.get(target, key);
        let forwarder = forwarders.get(key);
        if (forwarder === undefined) {
          forwarder = (...args) => {
            const action: unknown = Reflect.get(committed.current(), key);
            if (typeof action !== "function") {
              throw new Error(`The shell has no action named ${key}.`);
            }
            return Reflect.apply(action, undefined, args);
          };
          forwarders.set(key, forwarder);
        }
        return forwarder;
      },
    });
  });
  return stable;
}
