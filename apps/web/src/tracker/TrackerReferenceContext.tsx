import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TrackerReference, TrackerReferenceResolution } from "@octant/contracts";
import { recognizeTrackerReferences, type TrackerReferenceSpan } from "@octant/domain";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import {
  resolveTrackerReferences,
  trackerReferenceIdentity,
  type TrackerReferenceResolvePorts,
} from "./trackerReferenceResolve";

const RESOLVE_DEBOUNCE_MS = 250;

export interface TrackerReferenceContextValue {
  readonly ports: TrackerReferenceResolvePorts;
}

const TrackerReferenceContext = createContext<TrackerReferenceContextValue | undefined>(undefined);

export function TrackerReferenceProvider(props: {
  readonly ports: TrackerReferenceResolvePorts;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ ports: props.ports }), [props.ports]);
  return (
    <TrackerReferenceContext.Provider value={value}>
      {props.children}
    </TrackerReferenceContext.Provider>
  );
}

export function useTrackerReferencePorts(): TrackerReferenceResolvePorts | undefined {
  return useContext(TrackerReferenceContext)?.ports;
}

export interface TrackerReferenceResolutionView {
  readonly spans: ReadonlyArray<TrackerReferenceSpan>;
  readonly byIdentity: ReadonlyMap<string, TrackerReferenceResolution>;
}

/**
 * Recognize tracker tags in `text` and resolve them through the provider
 * ports. Results are cached by identity so a transcript with the same tag
 * does not re-hit Linear/GitHub on every paint.
 */
export function useTrackerReferenceResolutions(text: string): TrackerReferenceResolutionView {
  const ports = useTrackerReferencePorts();
  const debouncedText = useDebouncedValue(text, RESOLVE_DEBOUNCE_MS);
  const spans = useMemo(() => recognizeTrackerReferences(debouncedText), [debouncedText]);
  const cacheRef = useRef(new Map<string, TrackerReferenceResolution>());
  const [byIdentity, setByIdentity] = useState(() => new Map<string, TrackerReferenceResolution>());
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const githubAvailable = ports?.github?.available === true;
  const linearAvailable = ports?.linear?.available === true;

  useEffect(() => {
    // Drop cached resolutions when connection posture changes so a disconnected
    // host cannot keep showing titles from an earlier authorized session.
    cacheRef.current = new Map();
    setByIdentity(new Map());
  }, [githubAvailable, linearAvailable]);

  useEffect(() => {
    const activePorts = portsRef.current;
    if (activePorts === undefined || spans.length === 0) {
      setByIdentity(new Map());
      return;
    }

    const unique = uniqueReferences(spans.map((span) => span.reference));
    const missing = unique.filter((reference) => {
      return !cacheRef.current.has(trackerReferenceIdentity(reference));
    });

    let cancelled = false;
    void (async () => {
      if (missing.length > 0) {
        const resolved = await resolveTrackerReferences(missing, activePorts);
        if (cancelled) return;
        for (const result of resolved) {
          cacheRef.current.set(trackerReferenceIdentity(result.reference), result);
        }
      }
      if (cancelled) return;
      const next = new Map<string, TrackerReferenceResolution>();
      for (const reference of unique) {
        const identity = trackerReferenceIdentity(reference);
        const cached = cacheRef.current.get(identity);
        if (cached !== undefined) next.set(identity, cached);
      }
      setByIdentity(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [spans, ports, githubAvailable, linearAvailable]);

  return { spans, byIdentity };
}

function uniqueReferences(
  references: ReadonlyArray<TrackerReference>,
): ReadonlyArray<TrackerReference> {
  const seen = new Set<string>();
  const unique: TrackerReference[] = [];
  for (const reference of references) {
    const identity = trackerReferenceIdentity(reference);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(reference);
  }
  return unique;
}
