import type {
  ArtifactMirrorDestination,
  ArtifactMirrorProjectStatus,
  ArtifactMirrorSettings as MirrorSettings,
} from "@octant/contracts/artifact-mirror";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

export interface ArtifactMirrorSettingsProps {
  readonly settings: MirrorSettings | undefined;
  /** Each Project's latest outcome for the destination it uses now, as the host reports it. */
  readonly projects: ReadonlyArray<ArtifactMirrorProjectStatus>;
  readonly busy: boolean;
  readonly defaultOpen?: boolean;
  readonly message?: string;
  readonly onChangeDestination: (destination: ArtifactMirrorDestination) => void;
  readonly onChangeAutoCommit: (autoCommit: boolean) => void;
  readonly onChooseFolderAgain: (status: ArtifactMirrorProjectStatus, folder: string) => void;
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
  const [open, setOpen] = useState(props.defaultOpen === true);
  const [folder, setFolder] = useState("");
  const [directory, setDirectory] = useState("docs/artifacts");
  const current = props.settings?.fallback.kind ?? "internal-only";
  const notMirrored = props.projects.filter(
    (status) => status.outcome === "refused" || status.outcome === "failed",
  );

  return (
    <SurfaceSection className="artifact-mirror" label="File mirroring">
      <div className="surface-row">
        <div className="surface-row__copy">
          <span className="oct-row-label">
            {TIERS.find((tier) => tier.kind === current)?.label}
          </span>
          <span className="oct-row-detail">
            Artifacts stay versioned in Octant; a mirrored file is a copy for other tools.
          </span>
        </div>
        <div className="surface-row__control">
          <OctantButton
            aria-expanded={open}
            aria-label={open ? "Hide file mirroring settings" : "Configure file mirroring"}
            onClick={() => setOpen((currentOpen) => !currentOpen)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {open ? (
              <ChevronUp aria-hidden="true" size={14} />
            ) : (
              <ChevronDown aria-hidden="true" size={14} />
            )}
            {open ? "Hide" : "Configure"}
          </OctantButton>
        </div>
      </div>

      {notMirrored.length === 0 ? null : (
        // Outside the collapsed body: a mirror that stopped writing is the one
        // thing here a person needs to see without opening anything.
        <ul aria-label="Projects not being mirrored" className="artifact-mirror__refusals">
          {notMirrored.map((status) => (
            <RefusedProjectMirror
              busy={props.busy}
              key={String(status.projectId)}
              onChooseFolderAgain={props.onChooseFolderAgain}
              status={status}
            />
          ))}
        </ul>
      )}

      {open ? (
        <div className="artifact-mirror__body">
          <p className="artifact-mirror__note">
            Octant keeps every artifact and its history itself. A mirrored file is a copy for other
            tools: deleting one does not delete the artifact, and editing one changes nothing until
            you import it, which adds a new version.
          </p>

          <OctantToggleGroup<ArtifactMirrorDestination["kind"]>
            aria-label="Artifact file destination"
            className="artifact-mirror__tiers"
            disabled={props.busy}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "internal-only") props.onChangeDestination({ kind: "internal-only" });
              if (next === "global-folder" && folder.trim().length > 0) {
                props.onChangeDestination({
                  kind: "global-folder",
                  canonicalRoot: folder.trim() as never,
                });
              }
              if (next === "project-repository" && directory.trim().length > 0) {
                props.onChangeDestination({
                  kind: "project-repository",
                  relativeDirectory: directory.trim() as never,
                });
              }
            }}
            value={[current]}
          >
            {TIERS.map((tier) => (
              <OctantToggleGroupItem
                className="artifact-mirror__tier"
                key={tier.kind}
                value={tier.kind}
              >
                <span className="artifact-mirror__tier-body">
                  <span className="artifact-mirror__tier-label">{tier.label}</span>
                  <span className="artifact-mirror__tier-detail">{tier.detail}</span>
                </span>
              </OctantToggleGroupItem>
            ))}
          </OctantToggleGroup>

          <label className="artifact-mirror__field">
            <span>Folder</span>
            <OctantInput
              className="input"
              disabled={props.busy || current !== "global-folder"}
              onChange={(event) => setFolder(event.target.value)}
              placeholder="/Users/you/Artifacts"
              value={folder}
            />
          </label>

          <label className="artifact-mirror__field">
            <span>Folder inside the repository</span>
            <OctantInput
              className="input"
              disabled={props.busy || current !== "project-repository"}
              onChange={(event) => setDirectory(event.target.value)}
              placeholder="docs/artifacts"
              value={directory}
            />
          </label>

          <label className="artifact-mirror__auto-commit check">
            <OctantCheckbox
              checked={props.settings?.autoCommit === true}
              disabled={props.busy || current !== "project-repository"}
              onChange={(event) => props.onChangeAutoCommit(event.target.checked)}
            />
            <span>
              Commit mirrored files automatically. Off by default. It commits the artifact files and
              nothing else — if you have anything else staged it declines instead — and it never
              pushes.
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
        </div>
      ) : null}
    </SurfaceSection>
  );
}

/**
 * One Project whose last mirror wrote nothing, in the host's words.
 *
 * Choosing the folder again asks for the path rather than resubmitting the
 * stored one: a folder refused because it now resolves through a link would
 * otherwise be re-stored at wherever that link points with one click.
 */
function RefusedProjectMirror(props: {
  readonly status: ArtifactMirrorProjectStatus;
  readonly busy: boolean;
  readonly onChooseFolderAgain: (status: ArtifactMirrorProjectStatus, folder: string) => void;
}) {
  const { status } = props;
  const [choosing, setChoosing] = useState(false);
  const [folder, setFolder] = useState("");
  const storedFolder =
    status.destination.kind === "global-folder" ? status.destination.canonicalRoot : undefined;

  return (
    <li className="artifact-mirror__refusal">
      <span className="oct-row-label">{status.projectName}</span>
      <span className="oct-row-detail">
        {status.detail ?? "The last change in this Project was not mirrored."}
      </span>
      {storedFolder === undefined ? null : (
        <span className="oct-row-detail">Folder: {storedFolder}</span>
      )}
      {storedFolder === undefined ? null : choosing ? (
        <form
          className="artifact-mirror__refusal-choice"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const chosen = folder.trim();
            if (chosen.length === 0) return;
            props.onChooseFolderAgain(status, chosen);
            setChoosing(false);
            setFolder("");
          }}
        >
          <label className="artifact-mirror__field">
            <span>
              {status.source === "project"
                ? `Folder for ${status.projectName}`
                : "Folder for every Project without its own"}
            </span>
            <OctantInput
              className="input"
              disabled={props.busy}
              onChange={(event) => setFolder(event.target.value)}
              placeholder="/Users/you/Artifacts"
              value={folder}
            />
          </label>
          <OctantButton
            disabled={props.busy || folder.trim().length === 0}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Use this folder
          </OctantButton>
        </form>
      ) : (
        <OctantButton
          disabled={props.busy}
          onClick={() => setChoosing(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Choose the folder again
        </OctantButton>
      )}
    </li>
  );
}
