import type {
  ZenSourceContext,
  ZenThreadCatalogEntry,
  ZenThreadCatalogRef,
} from "@octant/contracts/zen";
import { OctantButton } from "../ui/base/OctantButton";

export interface ZenThreadElementProps {
  readonly entry?: ZenThreadCatalogEntry;
  readonly sourceContext: ZenSourceContext;
  readonly onContinue: (catalogRef: ZenThreadCatalogRef) => void;
}

export function ZenThreadElement(props: ZenThreadElementProps) {
  const entry = props.entry;
  if (entry === undefined) {
    return (
      <div className="zen-thread-element zen-thread-element--unavailable">
        <strong>Source unavailable</strong>
        <p>{`${capitalize(props.sourceContext.mode)} · ${props.sourceContext.projectId ?? "unfiled"}`}</p>
        <code>{String(props.sourceContext.threadId)}</code>
        <p>Octant kept the exact source identity and did not retarget by name.</p>
      </div>
    );
  }
  return (
    <div className="zen-thread-element">
      <strong>{entry.title}</strong>
      <p>{`${entry.hostLabel} · ${capitalize(entry.mode)} · ${entry.projectLabel}`}</p>
      <p>{`${entry.status} · Updated ${entry.recentActivityAt}`}</p>
      <p>{`${entry.providerInstanceId} · ${entry.modelId}`}</p>
      <OctantButton
        aria-label={`Continue ${entry.title}`}
        onClick={() => props.onContinue(entry.catalogRef)}
        type="button"
        variant="secondary"
      >
        Continue
      </OctantButton>
    </div>
  );
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
