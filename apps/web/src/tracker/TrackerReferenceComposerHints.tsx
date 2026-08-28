import type { TrackerReferenceResolution } from "@octant/contracts";
import { useTrackerReferenceResolutions } from "./TrackerReferenceContext";
import { TrackerReferenceChip } from "./TrackerReferenceText";
import { trackerReferenceIdentity } from "./trackerReferenceResolve";

/**
 * Compact resolve receipts under a composer. The draft text itself stays
 * plain in the textarea; these chips only show when a connected tracker
 * answered, so an unauthorized or rate-limited host never invents status.
 */
export function TrackerReferenceComposerHints(props: { readonly draft: string }) {
  const { spans, byIdentity } = useTrackerReferenceResolutions(props.draft);
  const resolved = uniqueResolved(spans, byIdentity);
  if (resolved.length === 0) return null;
  return (
    <ul aria-label="Resolved tracker references" className="tracker-reference-hints">
      {resolved.map((resolution) => (
        <li key={trackerReferenceIdentity(resolution.reference)}>
          <TrackerReferenceChip resolution={resolution} />
          <span className="tracker-reference-hints__title">{resolution.title}</span>
        </li>
      ))}
    </ul>
  );
}

function uniqueResolved(
  spans: ReadonlyArray<{ readonly reference: TrackerReferenceResolution["reference"] }>,
  byIdentity: ReadonlyMap<string, TrackerReferenceResolution>,
): ReadonlyArray<Extract<TrackerReferenceResolution, { readonly status: "resolved" }>> {
  const seen = new Set<string>();
  const resolved: Extract<TrackerReferenceResolution, { readonly status: "resolved" }>[] = [];
  for (const span of spans) {
    const identity = trackerReferenceIdentity(span.reference);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const resolution = byIdentity.get(identity);
    if (resolution?.status === "resolved") resolved.push(resolution);
  }
  return resolved;
}
