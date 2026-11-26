import { createContext, useContext, useState, type ReactNode } from "react";

interface ResultQuoteTarget {
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
  const target = request?.threadId === props.threadId ? request : undefined;
  return (
    <ResultQuoteContext.Provider
      value={{
        threadId: props.threadId,
        target,
        revealRow: target?.row,
        reveal: (next) => setRequest({ ...next, threadId: props.threadId }),
        revealed: () => setRequest(undefined),
      }}
    >
      {props.children}
    </ResultQuoteContext.Provider>
  );
}

export function useResultQuoteScope() {
  return useContext(ResultQuoteContext);
}

// The plain-text quote carries a short reference number. Keep transcript
// identifiers in this window, where the composer already tracks trusted chips.
const sources = new Map<
  string,
  ResultQuoteTarget & { readonly label: string; readonly threadId: string }
>();
let nextSource = 0;

export function resultQuoteSource(label: string, threadId: string, target: ResultQuoteTarget) {
  const attribution = label.replace(/\s+/g, " ").slice(0, 150).trim();
  const source = `${attribution} · result reference ${++nextSource}`;
  sources.set(source, { ...target, label: attribution, threadId });
  if (sources.size > 512) {
    const oldest = sources.keys().next().value;
    if (oldest !== undefined) sources.delete(oldest);
  }
  return source;
}

export function readResultQuoteSource(source: string) {
  return sources.get(source);
}
