import type { ContextEntryId } from "@octant/contracts/context";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ContextControllerStatus } from "./useContextController";

export interface ComposerContextMeterScopeValue {
  readonly busy: boolean;
  readonly openNonce: number;
  readonly rebuild: () => void;
  readonly requestOpen: () => void;
  readonly setExcluded: (entryId: ContextEntryId, excluded: boolean) => void;
  readonly setPinned: (entryId: ContextEntryId, pinned: boolean) => void;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly status: ContextControllerStatus;
  readonly subjectKey?: string;
  readonly visible: boolean;
}

function ignoredRebuild(): void {}
function ignoredOverride(_entryId: ContextEntryId, _enabled: boolean): void {}

const ComposerContextMeterDataContext = createContext<
  Omit<ComposerContextMeterScopeValue, "visible">
>({
  busy: false,
  openNonce: 0,
  rebuild: ignoredRebuild,
  requestOpen: () => undefined,
  setExcluded: ignoredOverride,
  setPinned: ignoredOverride,
  status: "idle",
});

const ComposerContextMeterVisibleContext = createContext(false);

export interface ComposerContextMeterProviderProps {
  readonly busy?: boolean;
  readonly children: ReactNode;
  readonly onRebuild?: () => void;
  readonly onSetExcluded?: (entryId: ContextEntryId, excluded: boolean) => void;
  readonly onSetPinned?: (entryId: ContextEntryId, pinned: boolean) => void;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly status: ContextControllerStatus;
  readonly subjectKey?: string;
}

export function ComposerContextMeterProvider(props: ComposerContextMeterProviderProps) {
  const [openNonce, setOpenNonce] = useState(0);
  const requestOpen = useCallback(() => {
    setOpenNonce((current) => current + 1);
  }, []);
  const rebuild = props.onRebuild ?? ignoredRebuild;
  const setExcluded = props.onSetExcluded ?? ignoredOverride;
  const setPinned = props.onSetPinned ?? ignoredOverride;
  const value = useMemo(
    () => ({
      busy: props.busy === true,
      openNonce,
      rebuild,
      requestOpen,
      setExcluded,
      setPinned,
      status: props.status,
      ...(props.snapshot === undefined ? {} : { snapshot: props.snapshot }),
      ...(props.subjectKey === undefined ? {} : { subjectKey: props.subjectKey }),
    }),
    [
      props.busy,
      openNonce,
      props.snapshot,
      props.status,
      props.subjectKey,
      rebuild,
      requestOpen,
      setExcluded,
      setPinned,
    ],
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
