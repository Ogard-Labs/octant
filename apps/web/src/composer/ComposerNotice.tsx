import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface ComposerNoticeSlot {
  readonly content: ReactNode;
  readonly register: () => () => void;
}
const NoticeContext = createContext<ComposerNoticeSlot | undefined>(undefined);

/** Keep a notice in its owning pane even while that pane's composer is loading. */
export function ComposerNoticeProvider(props: {
  readonly value: ReactNode;
  readonly children: ReactNode;
}) {
  const [composers, setComposers] = useState(0);
  const register = useCallback(() => {
    setComposers((count) => count + 1);
    return () => setComposers((count) => Math.max(0, count - 1));
  }, []);
  const value = useMemo(() => ({ content: props.value, register }), [props.value, register]);
  return (
    <NoticeContext.Provider value={value}>
      {props.children}
      {composers === 0 && props.value != null ? (
        <div className="composer-notice-fallback">{props.value}</div>
      ) : null}
    </NoticeContext.Provider>
  );
}

/** This slot carries notices only; it cannot confirm authority challenges. */
export function useComposerNotice(): ReactNode {
  const slot = useContext(NoticeContext);
  const register = slot?.register;
  useLayoutEffect(() => register?.(), [register]);
  return slot?.content;
}
