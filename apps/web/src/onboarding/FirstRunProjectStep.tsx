import type { ProjectId } from "@octant/contracts/projects";
import { FolderPlus } from "lucide-react";
import { SettingRow } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { FirstRunHandoffProject, FirstRunTaskMode } from "./firstRunHandoffModel";

export interface FirstRunProjectStepProps {
  /** Work can be turned off in Settings; Code is always available. */
  readonly workEnabled: boolean;
  readonly mode: FirstRunTaskMode;
  readonly onSelectMode: (mode: FirstRunTaskMode) => void;
  /** Active Projects of the selected mode. */
  readonly projects: ReadonlyArray<FirstRunHandoffProject>;
  readonly selectedProjectId: ProjectId | undefined;
  readonly onSelectProject: (projectId: ProjectId) => void;
  readonly onChooseFolder: () => void;
}

const MODE_COPY: Record<FirstRunTaskMode, { readonly label: string; readonly lead: string }> = {
  work: {
    label: "Work",
    lead: "Work reads and edits the documents, decks, and spreadsheets in the folder. It can’t change anything outside it.",
  },
  code: {
    label: "Code",
    lead: "Code works inside the folder and asks before it changes a file.",
  },
};

/**
 * The folder the first task works in.
 *
 * Choosing one opens the same Project create surface as the empty Work and
 * Code pages, so first run grants nothing that surface would not, and making
 * the folder a Git repository stays the explicit choice it is there. That
 * surface conceals first run and returns here when it closes.
 */
export function FirstRunProjectStep(props: FirstRunProjectStepProps) {
  const modes: ReadonlyArray<FirstRunTaskMode> = props.workEnabled ? ["work", "code"] : ["code"];
  const hasProjects = props.projects.length > 0;

  return (
    <div className="first-run__step">
      <p className="first-run__intro">
        A task starts in a Project: one folder you choose. {MODE_COPY[props.mode].lead} Choosing a
        folder does not change access permissions.
      </p>

      {modes.length > 1 || hasProjects ? (
        <section
          aria-label="First task"
          className="settings-card-section settings-card-section--open"
        >
          <h2>First task</h2>
          <div className="setgroup">
            {modes.length > 1 ? (
              <SettingRow
                description="The mode your first task starts in."
                label="Mode"
                scope="app"
                settingId="first-run-task-mode"
              >
                <OctantToggleGroup<FirstRunTaskMode>
                  aria-label="First task mode"
                  onValueChange={(value) => {
                    const selected = value[0];
                    if (selected !== undefined) props.onSelectMode(selected);
                  }}
                  role="radiogroup"
                  value={[props.mode]}
                >
                  {modes.map((mode) => (
                    <OctantToggleGroupItem
                      aria-checked={props.mode === mode}
                      key={mode}
                      role="radio"
                      value={mode}
                    >
                      {MODE_COPY[mode].label}
                    </OctantToggleGroupItem>
                  ))}
                </OctantToggleGroup>
              </SettingRow>
            ) : null}
            {hasProjects ? (
              <SettingRow
                description="The Project your first task starts in."
                label="Folder"
                scope="app"
                settingId="first-run-task-project"
              >
                <OctantToggleGroup<string>
                  aria-label="First task folder"
                  onValueChange={(value) => {
                    const selected = props.projects.find(
                      (project) => String(project.id) === value[0],
                    );
                    if (selected !== undefined) props.onSelectProject(selected.id);
                  }}
                  role="radiogroup"
                  value={
                    props.selectedProjectId === undefined ? [] : [String(props.selectedProjectId)]
                  }
                >
                  {props.projects.map((project) => (
                    <OctantToggleGroupItem
                      aria-checked={String(project.id) === String(props.selectedProjectId)}
                      key={String(project.id)}
                      role="radio"
                      value={String(project.id)}
                    >
                      {project.name}
                    </OctantToggleGroupItem>
                  ))}
                </OctantToggleGroup>
              </SettingRow>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="first-run__button-row">
        <OctantButton
          onClick={props.onChooseFolder}
          type="button"
          variant={hasProjects ? "ghost" : "outline"}
        >
          <FolderPlus aria-hidden="true" size={16} strokeWidth={1.8} />
          {hasProjects ? "Add another folder" : "Choose a folder…"}
        </OctantButton>
      </div>

      {hasProjects ? null : (
        <p className="first-run__caveat" role="note">
          No {MODE_COPY[props.mode].label} folder yet. You can skip this and choose one when you
          start a task.
        </p>
      )}
    </div>
  );
}
