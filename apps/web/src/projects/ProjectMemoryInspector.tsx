import type {
  ActiveMemoryEntry,
  MemoryEntry,
  MemoryEntryId,
  MemoryKind,
  ProjectId,
  ProjectMemoryView,
  ProjectSummary,
} from "@octant/contracts/projects";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { MemoryEntryDialog } from "./MemoryEntryDialog";
import { MemoryTransferDialog } from "./MemoryTransferDialog";

type InspectorDialog =
  | { readonly kind: "create" }
  | { readonly kind: "supersede"; readonly entry: ActiveMemoryEntry }
  | { readonly kind: "retract"; readonly entry: ActiveMemoryEntry }
  | { readonly kind: "transfer"; readonly entry: ActiveMemoryEntry };

const memoryTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface ProjectMemoryInspectorProps {
  readonly busy: boolean;
  readonly embedded?: boolean;
  readonly errorMessage?: string;
  readonly memory?: ProjectMemoryView;
  readonly onClose?: () => void;
  readonly onCreate: (kind: MemoryKind, content: string) => Promise<boolean>;
  readonly onLoad: (projectId: ProjectId) => Promise<void>;
  readonly onRetract: (entryId: MemoryEntryId, reason: string) => Promise<boolean>;
  readonly onRetry: (projectId: ProjectId) => Promise<void>;
  readonly onSupersede: (entryId: MemoryEntryId, content: string) => Promise<boolean>;
  readonly onTransfer: (
    entryId: MemoryEntryId,
    destinationProjectId: ProjectId,
  ) => Promise<boolean>;
  readonly project: ProjectSummary;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly readOnly?: boolean;
  readonly status: "idle" | "loading" | "ready" | "error" | "conflict-reload";
}

const kinds: ReadonlyArray<MemoryKind> = ["decision", "fact", "preference", "summary", "outcome"];

export function ProjectMemoryInspector(props: ProjectMemoryInspectorProps) {
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [dialog, setDialog] = useState<InspectorDialog>();
  const dialogOpener = useRef<HTMLElement | undefined>(undefined);
  const readOnly = props.readOnly === true || props.project.lifecycle === "archived";
  const memory =
    props.memory !== undefined && String(props.memory.projectId) === String(props.project.id)
      ? props.memory
      : undefined;
  const mutationsAvailable = !readOnly && props.status === "ready" && memory !== undefined;
  const loadingOwner =
    !readOnly && (props.status === "idle" || (props.status === "ready" && memory === undefined));
  const hasStatus =
    readOnly ||
    loadingOwner ||
    props.status === "loading" ||
    props.status === "conflict-reload" ||
    props.status === "error";
  const destinations = props.projects.filter(
    (project) => project.lifecycle === "active" && project.id !== props.project.id,
  );

  useEffect(() => {
    void props.onLoad(props.project.id);
  }, [props.onLoad, props.project.id]);

  useEffect(() => {
    setDialog(undefined);
  }, [props.project.id]);

  function openDialog(next: InspectorDialog, opener: HTMLElement): void {
    dialogOpener.current = opener;
    setDialog(next);
  }

  function closeDialog(): void {
    const opener = dialogOpener.current;
    setDialog(undefined);
    queueMicrotask(() => opener?.focus());
  }

  const active = memory?.active.filter((entry) => filter === "all" || entry.kind === filter) ?? [];
  const history =
    memory?.history.filter((entry) => filter === "all" || entry.kind === filter) ?? [];
  const InspectorRoot = props.embedded ? "div" : "aside";

  return (
    <InspectorRoot
      {...(props.embedded ? {} : { "aria-label": "Project memory" })}
      className={`project-memory-inspector window-no-drag${props.embedded ? " project-memory-inspector--embedded" : ""}`}
    >
      <header className="project-memory-inspector__header">
        <div>
          {/* On the Project page the page already names the Project and the
              heading is one section label among the others. */}
          {props.embedded ? null : <span>Project context</span>}
          <h2>Memory</h2>
          {props.embedded ? null : <p>{props.project.name}</p>}
        </div>
        {props.embedded || props.onClose === undefined ? null : (
          <OctantButton
            aria-label="Close Project memory"
            onClick={props.onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            ×
          </OctantButton>
        )}
      </header>
      <div className="project-memory-inspector__toolbar">
        <label>
          <span className="sr-only">Filter memory by kind</span>
          <OctantSelectField
            aria-label="Filter memory by kind"
            onValueChange={(value) => setFilter(value as MemoryKind | "all")}
            options={[
              { id: "all", label: "All kinds" },
              ...kinds.map((kind) => ({
                id: kind,
                label: kindLabel(kind),
              })),
            ]}
            value={filter}
          />
        </label>
        {readOnly ? null : (
          <OctantButton
            className="project-button"
            disabled={!mutationsAvailable}
            onClick={(event) => openDialog({ kind: "create" }, event.currentTarget)}
            type="button"
            variant="secondary"
          >
            Add memory
          </OctantButton>
        )}
      </div>
      {hasStatus ? (
        <div className="project-memory-status-stack">
          {readOnly ? (
            <p className="project-memory-inspector__readonly">
              Archived Project · memory is read-only
            </p>
          ) : null}
          {loadingOwner || props.status === "loading" ? (
            <p role="status">Loading Project memory…</p>
          ) : null}
          {props.status === "conflict-reload" ? (
            <p role="status">Reloading authoritative memory…</p>
          ) : null}
          {props.status === "error" ? (
            <div className="project-memory-inspector__error" role="alert">
              <p>{props.errorMessage ?? "Project memory is unavailable."}</p>
              <OctantButton
                className="project-button"
                onClick={() => void props.onRetry(props.project.id)}
                type="button"
                variant="secondary"
              >
                Retry memory
              </OctantButton>
            </div>
          ) : null}
        </div>
      ) : null}
      {props.status === "ready" && memory !== undefined ? (
        <div className="project-memory-scroll">
          <MemorySection
            title="Active memory"
            count={active.length}
            empty="No approved entries in this view."
          >
            {active.map((entry) => (
              <MemoryRow
                entry={entry}
                key={entry.id}
                readOnly={!mutationsAvailable}
                onRetract={(opener) => openDialog({ kind: "retract", entry }, opener)}
                onSupersede={(opener) => openDialog({ kind: "supersede", entry }, opener)}
                onTransfer={(opener) => openDialog({ kind: "transfer", entry }, opener)}
              />
            ))}
          </MemorySection>
          <MemorySection
            title="Audit history"
            count={history.length}
            empty="No superseded or retracted entries."
          >
            {history.map((entry) => (
              <MemoryRow entry={entry} key={entry.id} readOnly />
            ))}
          </MemorySection>
        </div>
      ) : null}
      {dialog?.kind === "transfer" ? (
        <MemoryTransferDialog
          busy={props.busy}
          destinations={destinations}
          entry={dialog.entry}
          onClose={closeDialog}
          onTransfer={props.onTransfer}
        />
      ) : dialog === undefined ? null : (
        <MemoryEntryDialog
          busy={props.busy}
          mode={
            dialog.kind === "create"
              ? dialog
              : { kind: dialog.kind, entryId: dialog.entry.id, content: dialog.entry.content }
          }
          onClose={closeDialog}
          onCreate={props.onCreate}
          onRetract={props.onRetract}
          onSupersede={props.onSupersede}
        />
      )}
    </InspectorRoot>
  );
}

function MemorySection(props: {
  readonly children: React.ReactNode;
  readonly count: number;
  readonly empty: string;
  readonly title: string;
}) {
  return (
    <section className="memory-section" aria-label={props.title}>
      <header>
        <h3>{props.title}</h3>
        <span>{props.count}</span>
      </header>
      {props.count === 0 ? <p className="memory-section__empty">{props.empty}</p> : props.children}
    </section>
  );
}

function MemoryRow(props: {
  readonly entry: MemoryEntry;
  readonly readOnly: boolean;
  readonly onRetract?: (opener: HTMLElement) => void;
  readonly onSupersede?: (opener: HTMLElement) => void;
  readonly onTransfer?: (opener: HTMLElement) => void;
}) {
  const entry = props.entry;
  return (
    <article className="memory-row" data-status={entry.status}>
      <div className="memory-row__meta">
        <span data-kind={entry.kind}>{kindLabel(entry.kind)}</span>
        <span>{statusLabel(entry.status)}</span>
        <time dateTime={entry.updatedAt}>{formatTimestamp(entry.updatedAt)}</time>
      </div>
      <p className="memory-row__content">{entry.content}</p>
      <p className="memory-row__source">Original author: {formatActor(entry.author)}</p>
      {entry.provenance.kind === "transferred" ? (
        <details className="memory-row__audit">
          <summary>Transfer provenance</summary>
          <dl>
            <dt>Source Project</dt>
            <dd>{entry.provenance.sourceProjectId}</dd>
            <dt>Source entry</dt>
            <dd>{entry.provenance.sourceEntryId}</dd>
            <dt>Destination Project</dt>
            <dd>{entry.provenance.destinationProjectId}</dd>
            <dt>Destination entry</dt>
            <dd>{entry.id}</dd>
            <dt>Selected content at transfer</dt>
            <dd>{entry.provenance.selectedContent}</dd>
            <dt>Transfer actor</dt>
            <dd>{formatActor(entry.provenance.transferredBy)}</dd>
            <dt>Transferred at</dt>
            <dd>{formatTimestamp(entry.provenance.transferredAt)}</dd>
          </dl>
        </details>
      ) : null}
      {entry.status === "superseded" ? (
        <p className="memory-row__audit-note">Replaced by {entry.supersededBy}</p>
      ) : null}
      {entry.status === "retracted" ? (
        <div className="memory-row__audit-note">
          <strong>Retraction reason</strong>
          <p>{entry.retractionReason}</p>
          <dl>
            <dt>Retraction actor</dt>
            <dd>{formatActor(entry.retractedBy)}</dd>
            <dt>Retracted at</dt>
            <dd>{formatTimestamp(entry.retractedAt)}</dd>
          </dl>
        </div>
      ) : null}
      {!props.readOnly && entry.status === "active" ? (
        <div className="memory-row__actions">
          <OctantButton
            aria-label={`Replace ${entry.content}`}
            onClick={(event) => props.onSupersede?.(event.currentTarget)}
            type="button"
            variant="ghost"
          >
            Replace
          </OctantButton>
          <OctantButton
            aria-label={`Retract ${entry.content}`}
            onClick={(event) => props.onRetract?.(event.currentTarget)}
            type="button"
            variant="ghost"
          >
            Retract
          </OctantButton>
          <OctantButton
            aria-label={`Transfer ${entry.content}`}
            onClick={(event) => props.onTransfer?.(event.currentTarget)}
            type="button"
            variant="ghost"
          >
            Transfer
          </OctantButton>
        </div>
      ) : null}
    </article>
  );
}

function kindLabel(kind: MemoryKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function statusLabel(status: MemoryEntry["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatTimestamp(value: string): string {
  return memoryTimestampFormatter.format(new Date(value));
}

function formatActor(actor: {
  readonly actorId: string;
  readonly kind: "local-user" | "system" | "remote-device" | "agent";
}) {
  const label =
    actor.kind === "local-user"
      ? "Local user"
      : actor.kind === "remote-device"
        ? "Remote device"
        : actor.kind === "agent"
          ? "Agent"
          : "System";
  return `${label} · ${actor.actorId}`;
}
