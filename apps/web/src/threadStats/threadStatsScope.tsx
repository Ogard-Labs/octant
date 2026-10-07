import type { TurnMetricsSummary } from "@octant/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface ThreadStatsScopeValue {
  /** Absent until the host answers, and for a thread that has no recorded turn. */
  readonly summary: TurnMetricsSummary | undefined;
  /** Whether the quiet line is shown; the detail is reachable either way. */
  readonly lineVisible: boolean;
  readonly setLineVisible: (visible: boolean) => void;
  readonly detailOpen: boolean;
  readonly openDetail: () => void;
  readonly closeDetail: () => void;
}

const noop = () => undefined;

const ThreadStatsScopeContext = createContext<ThreadStatsScopeValue>({
  summary: undefined,
  lineVisible: true,
  setLineVisible: noop,
  detailOpen: false,
  openDetail: noop,
  closeDetail: noop,
});

export interface ThreadStatsProviderProps {
  readonly children: ReactNode;
  readonly summary: TurnMetricsSummary | undefined;
  readonly lineVisible: boolean;
  readonly onLineVisibleChange: (visible: boolean) => void;
  /** Names the thread the figures belong to, so an open detail never follows a switch. */
  readonly subjectKey: string | undefined;
}

/**
 * One thread's turn figures for the composer, its quiet line, and the detail
 * that opens from either the line or the context meter. A composer with no
 * provider above it shows nothing, which is every start screen.
 */
export function ThreadStatsProvider(props: ThreadStatsProviderProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const { onLineVisibleChange, subjectKey } = props;
  useEffect(() => {
    setDetailOpen(false);
  }, [subjectKey]);
  const openDetail = useCallback(() => setDetailOpen(true), []);
  const closeDetail = useCallback(() => setDetailOpen(false), []);
  const value = useMemo<ThreadStatsScopeValue>(
    () => ({
      summary: props.summary,
      lineVisible: props.lineVisible,
      setLineVisible: onLineVisibleChange,
      detailOpen,
      openDetail,
      closeDetail,
    }),
    [closeDetail, detailOpen, onLineVisibleChange, openDetail, props.lineVisible, props.summary],
  );
  return (
    <ThreadStatsScopeContext.Provider value={value}>
      {props.children}
    </ThreadStatsScopeContext.Provider>
  );
}

export function useThreadStatsScope(): ThreadStatsScopeValue {
  return useContext(ThreadStatsScopeContext);
}
