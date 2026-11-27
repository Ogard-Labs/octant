import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface ResultQuoteTarget {
  readonly row: string;
  readonly block: string;
}

const ResultQuoteContext = createContext<
  | {
      readonly threadId: string;
      readonly target: ResultQuoteTarget | undefined;
      readonly revealRow: string | undefined;
      readonly reveal: (target: ResultQuoteTarget) => void;
      readonly revealed: () => void;
    }
  | undefined
>(undefined);

export function ResultQuoteScope(props: {
  readonly threadId: string;
  readonly children: ReactNode;
}) {
  const [request, setRequest] = useState<ResultQuoteTarget & { readonly threadId: string }>();
  const revealed = useCallback(() => setRequest(undefined), []);
  const target = request?.threadId === props.threadId ? request : undefined;
  return (
    <ResultQuoteContext.Provider
      value={{
        threadId: props.threadId,
        target,
        revealRow: target?.row,
        reveal: (next) => setRequest({ ...next, threadId: props.threadId }),
        revealed,
      }}
    >
      {props.children}
    </ResultQuoteContext.Provider>
  );
}

export function useResultQuoteScope() {
  return useContext(ResultQuoteContext);
}

/** A source lookup can also start after a rewind removed every visible row. */
export function ResultSourceNotice(props: {
  readonly missing: boolean;
  readonly loadRow?: ((row: string) => boolean | Promise<boolean>) | undefined;
}) {
  const scope = useResultQuoteScope();
  const target = scope?.target;
  const finish = scope?.revealed;
  const [unavailable, setUnavailable] = useState(false);
  const { missing, loadRow } = props;
  useEffect(() => {
    if (target === undefined) return;
    setUnavailable(false);
    if (!missing) return;
    let current = true;
    const failed = () => {
      if (!current) return;
      finish?.();
      setUnavailable(true);
    };
    void Promise.resolve(loadRow?.(target.row)).then((available) => {
      if (!available) failed();
    }, failed);
    return () => {
      current = false;
    };
  }, [target, missing, loadRow, finish]);

  return (
    <div aria-live="polite" aria-atomic="true" className={unavailable ? "oct-meta" : "sr-only"}>
      {unavailable ? "The source delivery is unavailable." : null}
    </div>
  );
}
