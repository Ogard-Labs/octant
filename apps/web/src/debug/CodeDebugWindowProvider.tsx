import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { CodeDebugWindowState, codeDebugWindowState } from "./codeDebugWindowState";
import {
  breakpointStorageEventMatches,
  defaultCodeBreakpointStorage,
} from "./codeBreakpointStorage";

export const CodeDebugWindowStoreContext = createContext<CodeDebugWindowState | undefined>(
  undefined,
);
export function useCodeDebugWindowStore(): CodeDebugWindowState {
  return useContext(CodeDebugWindowStoreContext) ?? codeDebugWindowState;
}
/** Endpoint and owned-window preferences only; the server still admits every debug action. */
export function CodeDebugWindowProvider(props: {
  readonly origin: string;
  readonly windowId: string;
  readonly children: ReactNode;
}) {
  const store = useMemo(
    () =>
      new CodeDebugWindowState({
        origin: props.origin,
        windowId: props.windowId,
        storage: defaultCodeBreakpointStorage(),
      }),
    [props.origin, props.windowId],
  );
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        breakpointStorageEventMatches({ origin: props.origin, windowId: props.windowId }, event.key)
      )
        store.reloadFromStorage(event.key);
    };
    globalThis.addEventListener("storage", changed);
    return () => globalThis.removeEventListener("storage", changed);
  }, [props.origin, props.windowId, store]);
  return (
    <CodeDebugWindowStoreContext.Provider value={store}>
      {props.children}
    </CodeDebugWindowStoreContext.Provider>
  );
}
