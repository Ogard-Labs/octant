import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ContextControllerStatus } from "./useContextController";

export interface ComposerContextMeterScopeValue {
  readonly openNonce: number;
  readonly requestOpen: () => void;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly status: ContextControllerStatus;
  readonly subjectKey?: string;
  readonly visible: boolean;
}

const ComposerContextMeterDataContext = createContext<
  Omit<ComposerContextMeterScopeValue, "visible">
>({
  openNonce: 0,
  requestOpen: () => undefined,
  status: "idle",
});

const ComposerContextMeterVisibleContext = createContext(false);

export interface ComposerContextMeterProviderProps {
  readonly children: ReactNode;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly status: ContextControllerStatus;
  readonly subjectKey?: string;
}

export function ComposerContextMeterProvider(props: ComposerContextMeterProviderProps) {
  const [openNonce, setOpenNonce] = useState(0);
  const requestOpen = useCallback(() => {
    setOpenNonce((current) => current + 1);
  }, []);
  const value = useMemo(
    () => ({
      openNonce,
      requestOpen,
      status: props.status,
      ...(props.snapshot === undefined ? {} : { snapshot: props.snapshot }),
      ...(props.subjectKey === undefined ? {} : { subjectKey: props.subjectKey }),
    }),
    [openNonce, props.snapshot, props.status, props.subjectKey, requestOpen],
  );
  return (
    <ComposerContextMeterDataContext.Provider value={value}>
      {props.children}
    </ComposerContextMeterDataContext.Provider>
  );
}

export function ComposerContextMeterGate(props: {
  readonly children: ReactNode;
  readonly enabled: boolean;
}) {
  return (
    <ComposerContextMeterVisibleContext.Provider value={props.enabled}>
      {props.children}
    </ComposerContextMeterVisibleContext.Provider>
  );
}

export function useComposerContextMeterScope(): ComposerContextMeterScopeValue {
  const data = useContext(ComposerContextMeterDataContext);
  const visible = useContext(ComposerContextMeterVisibleContext);
  return { ...data, visible };
}
