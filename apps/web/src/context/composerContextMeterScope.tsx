import type { ProviderContextBreakdown } from "@octant/contracts";
import type { ContextEntryId } from "@octant/contracts/context";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import type { CodeProviderLimit } from "@octant/contracts/code-operations";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { CompactionNames } from "./sessionCompactionPresentation";
import type { ContextControllerStatus } from "./useContextController";
import type { SessionCompactionController } from "./useSessionCompaction";

/** The thread's Compact session control, as the host answered it, and the names it shows. */
export interface ComposerCompaction {
  readonly controller: SessionCompactionController;
  readonly names: CompactionNames;
}

export interface ComposerContextMeterScopeValue {
  readonly busy: boolean;
  /** Absent where the window has no way to ask the host about compaction. */
  readonly compaction?: ComposerCompaction;
  /**
   * Opens the host's usage surface. Absent where none is reachable, and then
   * the meter offers no way there rather than a control that does nothing.
   */
  readonly openUsage?: () => void;
  readonly openNonce: number;
  readonly rebuild: () => void;
  readonly requestOpen: () => void;
  readonly setExcluded: (entryId: ContextEntryId, excluded: boolean) => void;
  readonly setPinned: (entryId: ContextEntryId, pinned: boolean) => void;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly fallback?: ComposerContextUsageFallback;
  readonly status: ContextControllerStatus;
  readonly subjectKey?: string;
  readonly visible: boolean;
}

export interface ComposerContextUsageFallback {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly limits: ReadonlyArray<CodeProviderLimit>;
  readonly outputTokens?: number;
  /** The provider's own account of its window, when it reported one. */
  readonly contextWindow?: number;
  readonly contextTokens?: number;
  /**
   * Where the provider's runtime compacts the session by itself, in tokens of
   * the window it reported. Present only when the runtime said so: it is what
   * makes this thread's compaction `automatic`, and no one derives it from the
   * window.
   */
  readonly autoCompactThreshold?: number;
  /**
   * What the window held, as the runtime reported its categories or as Octant
   * counted the parts it adds; absent when neither is known.
   */
  readonly contextBreakdown?: ProviderContextBreakdown;
  /**
   * The window the selected model declares, when the provider's usage report
   * did not name one. A driver that lists a model's context limit already
   * attested it; the meter may divide the reported occupancy by it, but the
   * popover says whose number it is.
   */
  readonly modelContextWindow?: number;
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
  readonly compaction?: ComposerCompaction;
  readonly onOpenUsage?: () => void;
  readonly onRebuild?: () => void;
  readonly onSetExcluded?: (entryId: ContextEntryId, excluded: boolean) => void;
  readonly onSetPinned?: (entryId: ContextEntryId, pinned: boolean) => void;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly fallback?: ComposerContextUsageFallback;
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
      ...(props.compaction === undefined ? {} : { compaction: props.compaction }),
      ...(props.onOpenUsage === undefined ? {} : { openUsage: props.onOpenUsage }),
      ...(props.snapshot === undefined ? {} : { snapshot: props.snapshot }),
      ...(props.fallback === undefined ? {} : { fallback: props.fallback }),
      ...(props.subjectKey === undefined ? {} : { subjectKey: props.subjectKey }),
    }),
    [
      props.busy,
      props.compaction,
      props.onOpenUsage,
      openNonce,
      props.snapshot,
      props.fallback,
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

/**
 * The host has a compaction running on the thread this composer writes to.
 * The host refuses a turn meanwhile; the composer holds send rather than
 * offering one it would refuse.
 */
export function useComposerCompacting(): boolean {
  const scope = useComposerContextMeterScope();
  return (
    scope.visible && scope.compaction?.controller.state?.latestCompaction?.status === "running"
  );
}
