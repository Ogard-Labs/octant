import type {
  ArtifactLibraryClaudeEntry,
  ArtifactLibraryClaudeSnapshotResult,
} from "@octant/contracts/artifact-library";
import { useState } from "react";
import { PublishedPageCard } from "../transcript/PublishedPageCard";
import { PublishedSnapshot } from "../transcript/PublishedSnapshot";
import { OctantButton } from "../ui/base/OctantButton";

export interface ClaudePageActions {
  /**
   * Reads the copy kept of the page's published file. Absent on a surface
   * that cannot read it (a paired device), which hides the action.
   */
  readonly onLoadSnapshot?: (
    entry: ArtifactLibraryClaudeEntry,
  ) => Promise<ArtifactLibraryClaudeSnapshotResult>;
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
      </div>
      {snapshot.kind === "unavailable" ? (
        <p className="oct-meta" role="status">
          No snapshot is available for this page here.
        </p>
      ) : null}
      {snapshot.kind === "shown" ? (
        <PublishedSnapshot snapshot={snapshot.snapshot} title={entry.title} />
      ) : null}
    </li>
  );
}
