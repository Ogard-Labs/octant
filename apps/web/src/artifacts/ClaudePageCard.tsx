import type {
  ArtifactLibraryClaudeEntry,
  ArtifactLibraryClaudeSnapshotResult,
} from "@octant/contracts/artifact-library";
import type { CanvasHtmlImportResult } from "@octant/contracts/canvas-cards";
import { useId, useState } from "react";
import { DroppedSummary } from "../canvas/CanvasHtmlImport";
import { PublishedPageCard } from "../transcript/PublishedPageCard";
import { PublishedSnapshot } from "../transcript/PublishedSnapshot";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ClaudePageActions {
  /**
   * Reads the copy kept of the page's published file. Absent on a surface
   * that cannot read it (a paired device), which hides the action.
   */
  readonly onLoadSnapshot?: (
    entry: ArtifactLibraryClaudeEntry,
  ) => Promise<ArtifactLibraryClaudeSnapshotResult>;
  /**
   * Copies the page's kept HTML into a new Canvas in the publishing thread's
   * Project, with the title the person confirmed. Absent where the snapshot
   * cannot be read (a paired device), which hides the action.
   */
  readonly onCopyToCanvas?: (
    entry: ArtifactLibraryClaudeEntry,
    title: string,
  ) => Promise<CanvasHtmlImportResult>;
}

type SnapshotState =
  | { readonly kind: "closed" | "loading" | "unavailable" }
  | {
      readonly kind: "shown";
      readonly snapshot: Extract<
        ArtifactLibraryClaudeSnapshotResult,
        { kind: "claude-snapshot" }
      >["snapshot"];
    };

type CopyState =
  | { readonly kind: "closed" }
  | { readonly kind: "open" | "copying"; readonly problem?: string }
  | {
      readonly kind: "copied";
      readonly result: Extract<CanvasHtmlImportResult, { readonly kind: "imported" }>;
    };

/**
 * One page a thread published to claude.ai, beside the Canvas documents: its
 * title, Claude type, account, thread and date, and Open on claude.ai. Octant
 * never fetches the live page; the snapshot shown is the copy kept of the
 * local file the newest publish named, and a page made from a type with no
 * local file has none.
 */
export function ClaudePageCard(
  props: ClaudePageActions & { readonly entry: ArtifactLibraryClaudeEntry },
) {
  const { entry } = props;
  const [snapshot, setSnapshot] = useState<SnapshotState>({ kind: "closed" });
  const [copy, setCopy] = useState<CopyState>({ kind: "closed" });
  const [title, setTitle] = useState(entry.title);
  const titleId = useId();
  const account = entry.accountName ?? entry.account;
  const facts = [
    entry.artifactType,
    account === undefined ? undefined : `Published by ${account}`,
    entry.threadTitle === undefined
      ? entry.projectName
      : `${entry.threadTitle} · ${entry.projectName}`,
    new Date(entry.publishedAt).toLocaleDateString(),
    entry.versionCount > 1 ? `${String(entry.versionCount)} versions` : undefined,
  ].filter((part): part is string => part !== undefined);
  const loadSnapshot = props.onLoadSnapshot;
  const copyToCanvas = entry.snapshot === "html" ? props.onCopyToCanvas : undefined;
  const showSnapshot = async () => {
    if (loadSnapshot === undefined) return;
    setSnapshot({ kind: "loading" });
    try {
      const result = await loadSnapshot(entry);
      setSnapshot(
        result.kind === "claude-snapshot"
          ? { kind: "shown", snapshot: result.snapshot }
          : { kind: "unavailable" },
      );
    } catch {
      setSnapshot({ kind: "unavailable" });
    }
  };
  const submitCopy = async () => {
    if (copyToCanvas === undefined) return;
    const typed = title.trim();
    if (typed.length === 0) {
      setCopy({ kind: "open", problem: "Give the Canvas a title." });
      return;
    }
    setCopy({ kind: "copying" });
    try {
      const result = await copyToCanvas(entry, typed);
      setCopy(
        result.kind === "imported"
          ? { kind: "copied", result }
          : { kind: "open", problem: result.message },
      );
    } catch {
      setCopy({ kind: "open", problem: "The page could not be copied. Try again." });
    }
  };
  return (
    <li aria-label={`Claude page: ${entry.title}`} className="artifact-library__claude-page">
      <PublishedPageCard page={{ url: entry.url, title: entry.title }} />
      <p className="oct-meta">{facts.join(" · ")}</p>
      <div className="artifact-library__claude-actions">
        {entry.snapshot === undefined || loadSnapshot === undefined ? null : snapshot.kind ===
          "shown" ? (
          <OctantButton onClick={() => setSnapshot({ kind: "closed" })} size="xs" variant="ghost">
            Hide snapshot
          </OctantButton>
        ) : (
          <OctantButton
            disabled={snapshot.kind === "loading"}
            onClick={() => void showSnapshot()}
            size="xs"
            variant="ghost"
          >
            Show snapshot
          </OctantButton>
        )}
        {copyToCanvas === undefined || copy.kind !== "closed" ? null : (
          <OctantButton onClick={() => setCopy({ kind: "open" })} size="xs" variant="ghost">
            Copy into Canvas
          </OctantButton>
        )}
      </div>
      {snapshot.kind === "unavailable" ? (
        <p className="oct-meta" role="status">
          No snapshot is available for this page here.
        </p>
      ) : null}
      {copy.kind === "open" || copy.kind === "copying" ? (
        <form
          aria-label="Copy into Canvas"
          className="artifact-library__claude-copy"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (copy.kind === "open") void submitCopy();
          }}
        >
          <p className="oct-meta">
            A new Canvas in {entry.projectName}, from the copy Octant kept when this page was
            published. Anything it would load from the internet is taken out.
          </p>
          <label className="canvas-html-import__label" htmlFor={titleId}>
            Canvas title
          </label>
          <OctantInput
            className="input"
            disabled={copy.kind === "copying"}
            id={titleId}
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
          {copy.kind === "open" && copy.problem !== undefined ? (
            <OctantAlert tone="warning">{copy.problem}</OctantAlert>
          ) : null}
          <div className="canvas-html-import__actions">
            <OctantButton disabled={copy.kind === "copying"} size="sm" type="submit">
              {copy.kind === "copying" ? "Copying…" : "Copy"}
            </OctantButton>
            <OctantButton
              disabled={copy.kind === "copying"}
              onClick={() => setCopy({ kind: "closed" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </OctantButton>
          </div>
        </form>
      ) : null}
      {copy.kind === "copied" ? (
        <section aria-label="Copied into Canvas" className="artifact-library__claude-copy">
          <OctantAlert
            title={`“${copy.result.card.title}” is now a Canvas in ${entry.projectName}`}
            tone="success"
            action={
              <OctantButton
                onClick={() => setCopy({ kind: "closed" })}
                size="sm"
                type="button"
                variant="ghost"
              >
                Done
              </OctantButton>
            }
          >
            <p className="canvas-html-import__line">
              {copy.result.frame === "running"
                ? "It runs its own script, contained like any Canvas prototype."
                : "It is drawn as a static page and runs no script."}
            </p>
          </OctantAlert>
          <DroppedSummary dropped={copy.result.dropped} />
        </section>
      ) : null}
      {snapshot.kind === "shown" ? (
        <PublishedSnapshot snapshot={snapshot.snapshot} title={entry.title} />
      ) : null}
    </li>
  );
}
