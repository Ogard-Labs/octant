import { MAX_ADDED_SKILL_FOLDERS, SkillFolderPath } from "@octant/contracts/shell";
import type { SkillFolderProvider, SkillFolderSettings } from "@octant/contracts/shell";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import type { SkillRootStatus } from "@octant/contracts/extension-rpc";
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
  readonly onChange: (next: SkillFolderSettings) => Promise<boolean | void> | boolean | void;
  readonly pickFolder?: () => Promise<string | undefined>;
  readonly statuses?: ReadonlyArray<SkillRootStatus>;
}

/**
 * The skill folders beyond a Project's and `~/.agents/skills`: a key provider's
 * own folder, turned on here, and folders added by path. A listed folder only
 * indexes its skills; each still has to be trusted and switched on.
 */
export function SkillFolderSettingsPanel(props: SkillFolderSettingsProps) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const current = useRef(props);
  current.current = props;
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [props.pickFolder]);

  const save = async (next: SkillFolderSettings) => {
    const epoch = generation.current;
    setBusy(true);
    setProblem(undefined);
    try {
      const accepted = await current.current.onChange(next);
      if (epoch !== generation.current) return false;
      if (accepted === false) {
        setProblem(
          "The folders changed elsewhere or could not be saved. Review the current list and try again.",
        );
        return false;
      }
      return true;
    } catch {
      if (epoch === generation.current)
        setProblem("Skill folders could not be saved. Your path is kept for retry.");
      return false;
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };

  const add = async (path = draft) => {
    const epoch = generation.current;
    const decoded = decodePath(path);
    if (decoded._tag === "Left") {
      setProblem("Type an absolute folder path, with no .. in it.");
      return;
    }
    if (current.current.value.folders.includes(decoded.right)) {
      setProblem("That folder is already listed.");
      return;
    }
    if (current.current.value.folders.length >= MAX_ADDED_SKILL_FOLDERS) {
      setProblem(`At most ${MAX_ADDED_SKILL_FOLDERS} added folders.`);
      return;
    }
    setProblem(undefined);
    setDraft(decoded.right);
    if (
      (await save({
        ...current.current.value,
        folders: [...current.current.value.folders, decoded.right],
      })) &&
      epoch === generation.current
    )
      setDraft("");
  };

  const pick = async () => {
    const epoch = generation.current;
    setBusy(true);
    setProblem(undefined);
    try {
      const path = await current.current.pickFolder?.();
      if (epoch === generation.current && path !== undefined) await add(path);
    } catch {
      if (epoch === generation.current)
        setProblem("The folder picker is unavailable. You can still type the path.");
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };

  return (
    <div className="setgroup skill-folder-settings" aria-busy={busy}>
      {PROVIDER_FOLDERS.map((provider) => (
        <SettingRow
          description={`Index the skills in ${provider.path}. Each stays off until you trust and enable it.`}
          key={provider.id}
          label={provider.label}
          scope="host"
          settingId={provider.settingId}
        >
          <OctantSwitch
            disabled={busy}
            checked={props.value.providers.includes(provider.id)}
            label={`Read ${provider.label}`}
            onCheckedChange={(on) =>
              void save({
                ...current.current.value,
                providers: on
                  ? [
                      ...current.current.value.providers.filter((id) => id !== provider.id),
                      provider.id,
                    ]
                  : current.current.value.providers.filter((id) => id !== provider.id),
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
                  disabled={busy}
                  aria-label={`Remove ${folder}`}
                  onClick={() =>
                    void save({
                      ...current.current.value,
                      folders: current.current.value.folders.filter((entry) => entry !== folder),
                    })
                  }
                  type="button"
                  variant="secondary"
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
              void add();
            }}
          >
            <OctantInput
              disabled={busy}
              aria-label="Skill folder path"
              onChange={(event) => setDraft(event.target.value)}
              placeholder="/path/to/skills"
              value={draft}
            />
            <OctantButton disabled={busy || draft.trim() === ""} type="submit" variant="secondary">
              Add folder
            </OctantButton>
            {props.pickFolder === undefined ? null : (
              <OctantButton
                disabled={busy || props.value.folders.length >= MAX_ADDED_SKILL_FOLDERS}
                type="button"
                variant="secondary"
                onClick={() => void pick()}
              >
                Choose folder…
              </OctantButton>
            )}
          </form>
          {(props.statuses?.length ?? 0) === 0 ? null : (
            <ul className="skill-folder-settings__list" aria-label="Skill folder status">
              {props.statuses?.map((status) => (
                <li key={status.sourceRef}>
                  <span className="oct-row-detail min-w-0 break-words">
                    {status.displayName}: {ROOT_STATUS[status.status]}
                    {status.status === "ready"
                      ? status.skillCount === 0
                        ? " No skill packages found; each package needs SKILL.md."
                        : ` ${status.skillCount.toLocaleString("en")} skill ${status.skillCount === 1 ? "entry" : "entries"} indexed.`
                      : ""}
                    {!status.watching
                      ? " Live watching is unavailable; use Refresh after changes."
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(props.statuses?.length ?? 0) === 0 ? null : (
            <p className="oct-row-detail">
              Use Refresh to read the current catalog and folder status.
            </p>
          )}
          {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
          {busy ? (
            <p className="oct-row-detail" role="status">
              Choosing or saving a skill folder…
            </p>
          ) : null}
        </div>
      </SettingRow>
    </div>
  );
}

const ROOT_STATUS: Readonly<Record<SkillRootStatus["status"], string>> = {
  ready: "Folder is readable. Review, trust and enablement stay separate choices for each skill.",
  missing: "Folder does not exist yet; nothing is indexed. Create it or change the path.",
  unreadable: "Folder cannot be read on this host. Check its permissions or remove it.",
  symlink: "Linked folders are ignored. Choose a regular folder.",
  "not-directory": "This path is not a folder. Choose or type a folder path.",
};
