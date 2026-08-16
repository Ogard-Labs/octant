import type { ZenThreadCatalogEntry, ZenThreadCatalogRef } from "@octant/contracts/zen";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ZenThreadPickerProps {
  readonly entries: ReadonlyArray<ZenThreadCatalogEntry>;
  readonly query: string;
  readonly busy?: boolean;
  readonly message?: string;
  readonly onAttach: (catalogRef: ZenThreadCatalogRef) => void;
  readonly onClose: () => void;
  readonly onQueryChange: (query: string) => void;
}

export function ZenThreadPicker(props: ZenThreadPickerProps) {
  return (
    <section aria-label="Threads" className="zen-panel zen-thread-picker" role="dialog">
      <header className="zen-panel__header">
        <div>
          <h2>Threads</h2>
          <p>Authorized work on this Mac. Attachments keep their original authority.</p>
        </div>
        <OctantButton onClick={props.onClose} type="button" variant="ghost">
          Close
        </OctantButton>
      </header>
      <OctantInput
        aria-label="Search authorized threads"
        onChange={(event) => props.onQueryChange(event.currentTarget.value)}
        placeholder="Search title, mode, Project, or status"
        type="search"
        value={props.query}
      />
      {props.message === undefined ? null : <p role="status">{props.message}</p>}
      {props.busy ? <p role="status">Searching…</p> : null}
      <div className="zen-thread-picker__results">
        {props.entries.length === 0 && !props.busy ? (
          <p>No authorized threads match this search.</p>
        ) : null}
        {props.entries.map((entry) => (
          <article className="zen-thread-picker__entry" key={entry.catalogRef}>
            <div>
              <strong>{entry.title}</strong>
              <p>{identityLabel(entry)}</p>
              <p>
                <time dateTime={entry.recentActivityAt}>{entry.recentActivityAt}</time>
                {` · ${entry.providerInstanceId} · ${entry.modelId}`}
              </p>
            </div>
            <OctantButton
              aria-label={`Attach ${entry.title}`}
              onClick={() => props.onAttach(entry.catalogRef)}
              type="button"
              variant="secondary"
            >
              Attach
            </OctantButton>
          </article>
        ))}
      </div>
    </section>
  );
}

function identityLabel(entry: ZenThreadCatalogEntry): string {
  return `${entry.hostLabel} · ${capitalize(entry.mode)} · ${entry.projectLabel} · ${entry.status}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
