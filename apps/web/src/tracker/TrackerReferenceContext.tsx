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
const RECOGNIZED_TEXT_LIMIT = 256;

/**
 * Recognized spans by text, shared across every message on screen. Each
 * transcript row and each streamed render recognized its own text again; the
 * same settled message reads the same spans, so an LRU bounded by entries
 * keeps them without holding a long session's text forever.
 */
const recognizedByText = new Map<string, ReadonlyArray<TrackerReferenceSpan>>();

function recognizeCached(text: string): ReadonlyArray<TrackerReferenceSpan> {
  const cached = recognizedByText.get(text);
  if (cached !== undefined) {
    recognizedByText.delete(text);
    recognizedByText.set(text, cached);
    return cached;
  }
  const spans = recognizeTrackerReferences(text);
  recognizedByText.set(text, spans);
  if (recognizedByText.size > RECOGNIZED_TEXT_LIMIT) {
    const oldest = recognizedByText.keys().next();
    if (oldest.done !== true) recognizedByText.delete(oldest.value);
  }
  return spans;
}

/** Keeps the current empty map so an empty result does not re-render readers. */
function keepEmpty(
  next: Map<string, TrackerReferenceResolution>,
): (current: Map<string, TrackerReferenceResolution>) => Map<string, TrackerReferenceResolution> {
  return (current) => (current.size === 0 && next.size === 0 ? current : next);
}

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
  // Spans for rendering must track `text` immediately so slice offsets stay
  // aligned while typing. Network resolution stays on the debounced copy.
  const spans = useMemo(() => recognizeCached(text), [text]);
  const debouncedText = useDebouncedValue(text, RESOLVE_DEBOUNCE_MS);
  const resolveSpans = useMemo(() => recognizeCached(debouncedText), [debouncedText]);
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
    setByIdentity(keepEmpty(new Map()));
  }, [githubAvailable, linearAvailable]);

  useEffect(() => {
    const activePorts = portsRef.current;
    if (activePorts === undefined || resolveSpans.length === 0) {
      setByIdentity(keepEmpty(new Map()));
      return;
    }

    const unique = uniqueReferences(resolveSpans.map((span) => span.reference));
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
      setByIdentity(keepEmpty(next));
    })();

    return () => {
      cancelled = true;
    };
  }, [resolveSpans, ports, githubAvailable, linearAvailable]);

  return useMemo(() => ({ spans, byIdentity }), [spans, byIdentity]);
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
