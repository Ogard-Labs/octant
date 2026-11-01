import { MAX_ADDED_SKILL_FOLDERS, SkillFolderPath } from "@octant/contracts/shell";
import type { SkillFolderProvider, SkillFolderSettings } from "@octant/contracts/shell";
import { Schema } from "effect";
import { useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow } from "./primitives";

const PROVIDER_FOLDERS: ReadonlyArray<{
  readonly id: SkillFolderProvider;
  readonly settingId: string;
  readonly label: string;
  readonly path: string;
}> = [
  {
    id: "claude",
    settingId: "skill-folder-claude",
    label: "Claude Code skills",
    path: "~/.claude/skills",
  },
  { id: "codex", settingId: "skill-folder-codex", label: "Codex skills", path: "~/.codex/skills" },
];

const decodePath = Schema.decodeUnknownEither(SkillFolderPath);

export interface SkillFolderSettingsProps {
  readonly value: SkillFolderSettings;
  readonly onChange: (next: SkillFolderSettings) => void;
}

/**
 * The skill folders beyond a Project's and `~/.agents/skills`: a key provider's
 * own folder, turned on here, and folders added by path. A listed folder only
 * indexes its skills; each still has to be trusted and switched on.
 */
export function SkillFolderSettingsPanel(props: SkillFolderSettingsProps) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();

  const add = () => {
    const decoded = decodePath(draft);
    if (decoded._tag === "Left") {
      setProblem("Type an absolute folder path, with no .. in it.");
      return;
    }
    if (props.value.folders.includes(decoded.right)) {
      setProblem("That folder is already listed.");
      return;
    }
    if (props.value.folders.length >= MAX_ADDED_SKILL_FOLDERS) {
      setProblem(`At most ${MAX_ADDED_SKILL_FOLDERS} added folders.`);
      return;
    }
    setProblem(undefined);
    setDraft("");
    props.onChange({ ...props.value, folders: [...props.value.folders, decoded.right] });
  };

  return (
    <div className="setgroup skill-folder-settings">
      {PROVIDER_FOLDERS.map((provider) => (
        <SettingRow
          description={`Index the skills in ${provider.path}. Each stays off until you trust and enable it.`}
          key={provider.id}
          label={provider.label}
          scope="host"
          settingId={provider.settingId}
        >
          <OctantSwitch
            checked={props.value.providers.includes(provider.id)}
            label={`Read ${provider.label}`}
            onCheckedChange={(on) =>
              props.onChange({
                ...props.value,
                providers: on
                  ? [...props.value.providers.filter((id) => id !== provider.id), provider.id]
                  : props.value.providers.filter((id) => id !== provider.id),
              })
            }
          />
        </SettingRow>
      ))}
      <SettingRow
        description="Any folder of skill folders. A folder that is a link is ignored."
        label="Added skill folders"
        scope="host"
        settingId="skill-folders-added"
      >
        <div className="skill-folder-settings__added">
          <ul aria-label="Added skill folders" className="skill-folder-settings__list">
            {props.value.folders.map((folder) => (
              <li key={folder}>
                <code>{folder}</code>
                <OctantButton
                  aria-label={`Remove ${folder}`}
                  onClick={() =>
                    props.onChange({
                      ...props.value,
                      folders: props.value.folders.filter((entry) => entry !== folder),
                    })
                  }
                  type="button"
                  variant="outline"
                >
                  Remove
                </OctantButton>
              </li>
            ))}
          </ul>
          <form
            className="skill-folder-settings__form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <OctantInput
              aria-label="Skill folder path"
              onChange={(event) => setDraft(event.target.value)}
              placeholder="/Users/you/skills"
              value={draft}
            />
            <OctantButton disabled={draft.trim() === ""} type="submit" variant="outline">
              Add folder
            </OctantButton>
          </form>
          {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
        </div>
      </SettingRow>
    </div>
  );
}
