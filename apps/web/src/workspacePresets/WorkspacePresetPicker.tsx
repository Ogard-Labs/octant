import type {
  WorkspacePreset,
  WorkspacePresetSkillReport,
} from "@octant/contracts/workspace-presets";
import {
  Code2,
  Files,
  Globe,
  type IconComponent,
  LayoutTemplate,
  MessageSquare,
  SquareTerminal,
} from "../ui/icons";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface WorkspacePresetPickerProps {
  readonly presets: ReadonlyArray<WorkspacePreset>;
  readonly busy: boolean;
  readonly message?: string;
  /** Where each named skill stands after the last preset was applied. */
  readonly skills: ReadonlyArray<WorkspacePresetSkillReport>;
  readonly onApply: (preset: WorkspacePreset) => void;
}

/** The words and tool glyph a person knows each pane by, never its raw id. */
const PANE_FACES: Readonly<Record<WorkspacePreset["panes"][number], PaneFace>> = {
  "code-overview": { label: "Overview", Icon: Code2 },
  browser: { label: "Browser", Icon: Globe },
  "side-chat": { label: "Side chat", Icon: MessageSquare },
  files: { label: "Files", Icon: Files },
  "code-terminal": { label: "Terminal", Icon: SquareTerminal },
};

interface PaneFace {
  readonly label: string;
  readonly Icon: IconComponent;
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
    <section aria-label="Set up this workspace" className="empty-start__group">
      <h3 className="oct-section-label empty-start__label">Set up this workspace</h3>
      <ul className="empty-start__rows">
        {props.presets.map((preset) => (
          <li className="empty-start__row empty-start__row--preset" key={String(preset.id)}>
            <LayoutTemplate aria-hidden="true" className="empty-start__icon" size={16} />
            <span className="empty-start__text">
              <span className="empty-start__name">{preset.displayName}</span>
              <span className="empty-start__summary">{preset.summary}</span>
              <span className="empty-start__opens">
                <span>Opens:</span>
                {preset.panes.map((pane, index) => {
                  const face = PANE_FACES[pane];
                  return (
                    <span className="empty-start__pane" key={pane}>
                      {index === 0 ? null : <span aria-hidden="true">·</span>}
                      <face.Icon aria-hidden={true} size={12} />
                      {face.label}
                    </span>
                  );
                })}
              </span>
            </span>
            <OctantButton
              aria-label={`Apply ${preset.displayName}`}
              className="empty-start__apply"
              disabled={props.busy}
              onClick={() => props.onApply(preset)}
              size="xs"
              type="button"
              variant="outline"
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
        <OctantAlert className="workspace-presets__message" tone="warning">
          {props.message}
        </OctantAlert>
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
