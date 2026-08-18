import type {
  ArtifactMirrorDestination,
  ArtifactMirrorSettings as MirrorSettings,
} from "@octant/contracts/artifact-mirror";
import { useState } from "react";

export interface ArtifactMirrorSettingsProps {
  readonly settings: MirrorSettings | undefined;
  readonly busy: boolean;
  readonly message?: string;
  readonly onChangeDestination: (destination: ArtifactMirrorDestination) => void;
  readonly onChangeAutoCommit: (autoCommit: boolean) => void;
}

const TIERS = [
  {
    kind: "internal-only" as const,
    label: "Keep artifacts in Octant only",
    detail: "The default. Artifacts are versioned and readable; no files are written.",
  },
  {
    kind: "global-folder" as const,
    label: "Mirror to a folder",
    detail:
      "A folder you pick, organized by Project. Put it inside a synced folder and your other devices get the files — Octant adds no cloud of its own.",
  },
  {
    kind: "project-repository" as const,
    label: "Mirror into the Project's repository",
    detail:
      "Written to the working tree only. Committing stays your decision, and nothing is ever pushed automatically.",
  },
];

/**
 * Choosing whether artifacts become files, and where.
 *
 * The wording says what each tier costs as well as what it gives, because the
 * one thing a person can get wrong here is assuming the folder is the artifact.
 * It is a copy: deleting a file does not delete the artifact, and editing one
 * changes nothing until it is imported, which adds a version.
 */
export function ArtifactMirrorSettings(props: ArtifactMirrorSettingsProps) {
  const [folder, setFolder] = useState("");
  const [directory, setDirectory] = useState("docs/artifacts");
  const current = props.settings?.fallback.kind ?? "internal-only";

  return (
    <section aria-label="Artifact files" className="artifact-mirror">
      <h3 className="artifact-mirror__title">Artifact files</h3>
      <p className="artifact-mirror__note">
        Octant keeps every artifact and its history itself. A mirrored file is a copy for other
        tools: deleting one does not delete the artifact, and editing one changes nothing until you
        import it, which adds a new version.
      </p>

      {TIERS.map((tier) => (
        <label className="artifact-mirror__tier" key={tier.kind}>
          <input
            checked={current === tier.kind}
            disabled={props.busy}
            name="artifact-mirror-tier"
            onChange={() => {
              if (tier.kind === "internal-only")
                props.onChangeDestination({ kind: "internal-only" });
              if (tier.kind === "global-folder" && folder.trim().length > 0) {
                props.onChangeDestination({
                  kind: "global-folder",
                  canonicalRoot: folder.trim() as never,
                });
              }
              if (tier.kind === "project-repository" && directory.trim().length > 0) {
                props.onChangeDestination({
                  kind: "project-repository",
                  relativeDirectory: directory.trim() as never,
                });
              }
            }}
            type="radio"
          />
          <span className="artifact-mirror__tier-body">
            <span className="artifact-mirror__tier-label">{tier.label}</span>
            <span className="artifact-mirror__tier-detail">{tier.detail}</span>
          </span>
        </label>
      ))}

      <label className="artifact-mirror__field">
        <span>Folder</span>
        <input
          disabled={props.busy}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="/Users/you/Artifacts"
          value={folder}
        />
      </label>

      <label className="artifact-mirror__field">
        <span>Folder inside the repository</span>
        <input
          disabled={props.busy}
          onChange={(event) => setDirectory(event.target.value)}
          placeholder="docs/artifacts"
          value={directory}
        />
      </label>

      <label className="artifact-mirror__auto-commit">
        <input
          checked={props.settings?.autoCommit === true}
          disabled={props.busy || current !== "project-repository"}
          onChange={(event) => props.onChangeAutoCommit(event.target.checked)}
          type="checkbox"
        />
        <span>
          Commit mirrored files automatically. Off by default. It commits the artifact files and
          nothing else — if you have anything else staged it declines instead — and it never pushes.
        </span>
      </label>

      {props.message === undefined ? null : (
        <p className="artifact-mirror__message" role="status">
          {props.message}
        </p>
      )}

      <p aria-live="polite" className="artifact-mirror__saved">
        {props.busy ? "Saving…" : "Saved automatically"}
      </p>
    </section>
  );
}
