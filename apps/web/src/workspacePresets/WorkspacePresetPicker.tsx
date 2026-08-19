import type {
  WorkspacePreset,
  WorkspacePresetSkillReport,
} from "@octant/contracts/workspace-presets";
import { LayoutTemplate } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface WorkspacePresetPickerProps {
  readonly presets: ReadonlyArray<WorkspacePreset>;
  readonly busy: boolean;
  readonly message?: string;
  /** Where each named skill stands after the last preset was applied. */
  readonly skills: ReadonlyArray<WorkspacePresetSkillReport>;
  readonly onApply: (preset: WorkspacePreset) => void;
}

/**
 * The workspace presets this host offers, and what each one opens.
 *
 * The panes are listed before anything opens, and the skills a preset names
 * are shown as a suggestion with their real state. A preset never installs,
 * trusts, or enables a skill; a skill this thread cannot use yet says so, and
 * going to get it stays the person's own deliberate step.
 */
export function WorkspacePresetPicker(props: WorkspacePresetPickerProps) {
  return (
    <section aria-label="Set up this workspace" className="workspace-presets">
      <header className="workspace-presets__header">
        <LayoutTemplate aria-hidden="true" size={13} strokeWidth={1.8} />
        <span>Set up this workspace</span>
      </header>
      <ul className="workspace-presets__list">
        {props.presets.map((preset) => (
          <li className="workspace-presets__entry" key={String(preset.id)}>
            <div>
              <strong>{preset.displayName}</strong>
              <p>{preset.summary}</p>
              <p className="workspace-presets__panes">Opens: {preset.panes.join(", ")}</p>
            </div>
            <OctantButton
              aria-label={`Apply ${preset.displayName}`}
              disabled={props.busy}
              onClick={() => props.onApply(preset)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Apply
            </OctantButton>
          </li>
        ))}
      </ul>
      {props.skills.length === 0 ? null : (
        <ul className="workspace-presets__skills" aria-label="Skills this preset suggests">
          {props.skills.map((skill) => (
            <li key={skill.name}>
              <span>{skill.name}</span>
              <span className="workspace-presets__skill-status">{skillStatusText(skill)}</span>
            </li>
          ))}
        </ul>
      )}
      {props.message === undefined ? null : (
        <p className="workspace-presets__message" role="alert">
          {props.message}
        </p>
      )}
    </section>
  );
}

/** What each state means in the words the activation ladder uses. */
function skillStatusText(skill: WorkspacePresetSkillReport): string {
  switch (skill.status) {
    case "active":
      return "in use by this thread";
    case "installed-not-enabled":
      return "installed — enable it to use it";
    case "not-installed":
      return "not installed";
  }
}
