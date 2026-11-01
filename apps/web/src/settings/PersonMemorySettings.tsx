import type { PersonMemoryClient } from "@octant/client-runtime/person-memory-client";
import { decodeProjectId } from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import {
  decodePersonMemoryCommand,
  PERSON_MEMORY_ENTRY_MAX_CHARACTERS,
  type PersonMemoryCommand,
  type PersonMemoryEntry,
  type PersonMemoryKind,
  type PersonMemorySettings as MemorySettings,
  type PersonMemoryView,
} from "@octant/contracts/person-memory";
import { useCallback, useEffect, useId, useState } from "react";
import { modelValue, shieldModelOptions, THREAD_PROVIDER_MODEL } from "../code/CodeSettingsView";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingGroup, SettingRow, SettingsSection, SettingsState } from "./primitives";

export interface PersonMemorySettingsProps {
  /** Absent where the host does not show memory, such as a paired device. */
  readonly client: PersonMemoryClient | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly focusedSetting?: string | undefined;
}

/** What the section says memory is, in the person's words. */
export const PERSON_MEMORY_FACT =
  "Octant remembers your preferences, how you work, and what you worked on, so a new thread in any Project starts knowing them. It learns only from what you wrote in threads you put away, and it stays on this computer.";

export const PERSON_MEMORY_PROVIDER_NOTE =
  "New threads get these notes whatever provider they use, so something learned in a thread on one provider can reach a thread on another.";

const KIND_LABEL: Record<PersonMemoryKind, string> = {
  preference: "Preference",
  "working-style": "How you work",
  "past-work": "Earlier work",
};

const MODE_LABEL = { chat: "Chat", work: "Work", code: "Code" } as const;

type Change = DistributiveOmit<PersonMemoryCommand, "expectedVersion">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Settings › Memory: the switches, the Projects and threads kept out, and
 * every entry with where it came from, each editable and deletable.
 */
export function PersonMemorySettings(props: PersonMemorySettingsProps) {
  const { client } = props;
  const [view, setView] = useState<PersonMemoryView>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string }>();
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [projectToExclude, setProjectToExclude] = useState("");
  const editId = useId();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setView(await client.read());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(change: Change): Promise<boolean> {
    if (client === undefined || view === undefined) return false;
    let command: PersonMemoryCommand;
    try {
      command = decodePersonMemoryCommand(
        change.kind === "change-person-memory-settings"
          ? { ...change, expectedVersion: view.version }
          : change,
      );
    } catch {
      setProblem(
        `A memory is one line of at most ${PERSON_MEMORY_ENTRY_MAX_CHARACTERS} characters.`,
      );
      return false;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.change(command);
      if (result.kind === "person-memory") {
        setView(result);
        return true;
      }
      setProblem(result.message);
      if (result.reason === "stale-version" || result.reason === "not-found") await load();
      return false;
    } catch {
      setProblem("Memory could not be changed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const changeSettings = (next: Partial<MemorySettings>, clearModel = false) => {
    if (view === undefined) return;
    const { distillModel, ...rest } = { ...view.settings, ...next };
    const settings: MemorySettings =
      clearModel || distillModel === undefined ? rest : { ...rest, distillModel };
    void send({ kind: "change-person-memory-settings", settings });
  };

  if (client === undefined) {
    return (
      <SettingsSection description={PERSON_MEMORY_FACT} title="Memory">
        <SettingsState kind="empty">Memory is shown on the host machine only.</SettingsState>
      </SettingsSection>
    );
  }
  if (view === undefined) {
    return (
      <SettingsSection description={PERSON_MEMORY_FACT} title="Memory">
        <SettingsState kind={loadFailed ? "error" : "loading"}>
          {loadFailed ? "Memory could not be read from this host." : "Reading memory…"}
        </SettingsState>
      </SettingsSection>
    );
  }

  const { settings } = view;
  const excluded = new Set(settings.excludedProjectIds.map(String));
  const projectOptions = [...props.projectNames.entries()]
    .filter(([id]) => !excluded.has(id))
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([id, name]) => ({ id, label: name }));
  const models = shieldModelOptions(props.providerSnapshot, settings.distillModel);

  return (
    <>
      <SettingsSection description={PERSON_MEMORY_FACT} title="Memory">
        <div className="setgroup">
          <SettingRow
            description={PERSON_MEMORY_PROVIDER_NOTE}
            focused={props.focusedSetting === "person-memory"}
            label="Remember across threads"
            scope="host"
            settingId="person-memory"
          >
            <OctantSwitch
              checked={settings.enabled}
              disabled={busy}
              label="Remember across threads"
              onCheckedChange={(enabled) => changeSettings({ enabled })}
            />
          </SettingRow>
          <SettingRow
            description="Agents can look up what earlier threads in other Projects did. They get short excerpts from memory, never files or whole conversations."
            focused={props.focusedSetting === "past-thread-search"}
            label="Search past threads"
            scope="host"
            settingId="past-thread-search"
          >
            <OctantSwitch
              checked={settings.pastThreadSearch}
              disabled={busy || !settings.enabled}
              label="Search past threads"
              onCheckedChange={(pastThreadSearch) => changeSettings({ pastThreadSearch })}
            />
          </SettingRow>
          <SettingRow
            description="One short request after each thread you put away. It shows in Usage as person-memory."
            focused={props.focusedSetting === "person-memory-model"}
            label="Model that writes memory"
            scope="host"
            settingId="person-memory-model"
          >
            <OctantSelectField
              aria-label="Model that writes memory"
              disabled={busy || !settings.enabled}
              onValueChange={(value) => {
                const choice = models.find((option) => option.id === value)?.choice;
                if (value === THREAD_PROVIDER_MODEL || choice === undefined) {
                  changeSettings({}, true);
                } else {
                  changeSettings({ distillModel: choice });
                }
              }}
              options={models.map((option) => ({ id: option.id, label: option.label }))}
              value={modelValue(settings.distillModel)}
            />
          </SettingRow>
        </div>
        <SettingGroup
          description="Nothing is learned from these Projects, and what was learned only there is not shown to other threads."
          label="Projects kept out of memory"
        >
          {settings.excludedProjectIds.map((projectId) => (
            <SettingRow
              key={String(projectId)}
              label={props.projectNames.get(String(projectId)) ?? "A Project no longer listed"}
              scope="host"
              settingId="person-memory-excluded-project"
            >
              <OctantButton
                disabled={busy}
                onClick={() =>
                  changeSettings({
                    excludedProjectIds: settings.excludedProjectIds.filter(
                      (id) => String(id) !== String(projectId),
                    ),
                  })
                }
                size="sm"
                type="button"
                variant="secondary"
              >
                Remember again
              </OctantButton>
            </SettingRow>
          ))}
          <SettingRow
            focused={props.focusedSetting === "person-memory-exclude"}
            label="Keep a Project out"
            scope="host"
            settingId="person-memory-exclude"
          >
            <div className="protected-files__add">
              <OctantSelectField
                aria-label="Project to keep out of memory"
                disabled={busy || projectOptions.length === 0}
                onValueChange={setProjectToExclude}
                options={[{ id: "", label: "Choose a Project" }, ...projectOptions]}
                value={projectToExclude}
              />
              <OctantButton
                disabled={busy || projectToExclude === ""}
                onClick={() => {
                  const id = projectToExclude;
                  setProjectToExclude("");
                  changeSettings({
                    excludedProjectIds: [...settings.excludedProjectIds, decodeProjectId(id)],
                  });
                }}
                size="sm"
                type="button"
              >
                Keep out
              </OctantButton>
            </div>
          </SettingRow>
        </SettingGroup>
        {view.untracedThreads.length === 0 ? null : (
          <SettingGroup
            description="Threads you marked to leave no trace: nothing is learned from them, and they get no memory."
            label="Threads that leave no trace"
          >
            {view.untracedThreads.map((thread) => (
              <SettingRow
                description={`${MODE_LABEL[thread.mode]} thread`}
                key={`${thread.mode}:${String(thread.threadId)}`}
                label={thread.title ?? "Untitled thread"}
                scope="host"
                settingId="person-memory-untraced"
              >
                <OctantButton
                  disabled={busy}
                  onClick={() =>
                    void send({
                      kind: "set-thread-leaves-no-trace",
                      mode: thread.mode,
                      threadId: thread.threadId,
                      leavesNoTrace: false,
                    })
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Allow memory
                </OctantButton>
              </SettingRow>
            ))}
          </SettingGroup>
        )}
        <div className="settings-feedback-slot" aria-live="polite">
          {problem === undefined ? null : (
            <OctantFieldError className="settings-section-line">{problem}</OctantFieldError>
          )}
        </div>
      </SettingsSection>
      <SettingsSection
        description={
          view.entries.length === 0
            ? "Nothing is remembered yet. Entries appear after you put a thread away."
            : `${view.entries.length} ${view.entries.length === 1 ? "entry" : "entries"} from ${view.rememberedThreads} ${view.rememberedThreads === 1 ? "thread" : "threads"}.`
        }
        title="What Octant remembers"
      >
        {view.entries.length === 0 ? null : (
          <div className="setgroup">
            {view.entries.map((entry) =>
              editing?.id === String(entry.id) ? (
                <SettingRow
                  htmlFor={editId}
                  key={String(entry.id)}
                  label={KIND_LABEL[entry.kind]}
                  scope="host"
                  settingId="person-memory-entry"
                >
                  <form
                    className="protected-files__add"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      void send({
                        kind: "edit-person-memory-entry",
                        entryId: entry.id,
                        content: editing.text.trim(),
                      }).then((saved) => {
                        if (saved) setEditing(undefined);
                      });
                    }}
                  >
                    <OctantInput
                      aria-label="Memory text"
                      className="settings-view__text-input"
                      disabled={busy}
                      id={editId}
                      maxLength={PERSON_MEMORY_ENTRY_MAX_CHARACTERS}
                      onChange={(event) =>
                        setEditing({ id: String(entry.id), text: event.currentTarget.value })
                      }
                      type="text"
                      value={editing.text}
                    />
                    <OctantButton
                      disabled={busy || editing.text.trim() === ""}
                      size="sm"
                      type="submit"
                    >
                      Save
                    </OctantButton>
                    <OctantButton
                      onClick={() => setEditing(undefined)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Cancel
                    </OctantButton>
                  </form>
                </SettingRow>
              ) : (
                <SettingRow
                  description={
                    <>
                      <span className="protected-files__paths">{entry.content}</span>{" "}
                      {sourceLine(entry, props.projectNames)}
                    </>
                  }
                  key={String(entry.id)}
                  label={KIND_LABEL[entry.kind]}
                  scope="host"
                  settingId="person-memory-entry"
                >
                  <div className="protected-files__add">
                    <OctantButton
                      disabled={busy}
                      onClick={() => setEditing({ id: String(entry.id), text: entry.content })}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Edit
                    </OctantButton>
                    <OctantButton
                      disabled={busy}
                      onClick={() =>
                        void send({ kind: "delete-person-memory-entry", entryId: entry.id })
                      }
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Delete
                    </OctantButton>
                  </div>
                </SettingRow>
              ),
            )}
          </div>
        )}
        <div className="setgroup">
          <SettingRow
            description="Erases every entry and every remembered thread. Your threads themselves are not touched."
            focused={props.focusedSetting === "person-memory-forget"}
            label="Forget everything"
            scope="host"
            settingId="person-memory-forget"
          >
            <OctantButton
              disabled={busy || (view.entries.length === 0 && view.rememberedThreads === 0)}
              onClick={() => setConfirmingForget(true)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Forget everything
            </OctantButton>
          </SettingRow>
        </div>
        {confirmingForget ? (
          <OctantConfirmDialog
            confirmLabel="Forget everything"
            destructive
            onCancel={() => setConfirmingForget(false)}
            onConfirm={() => {
              setConfirmingForget(false);
              void send({ kind: "forget-person-memory", confirmed: true });
            }}
            pending={busy}
            title="Forget everything Octant remembers?"
          >
            Every entry and every remembered thread is erased from this computer. New threads start
            without them. This cannot be undone.
          </OctantConfirmDialog>
        ) : null}
      </SettingsSection>
    </>
  );
}

function sourceLine(entry: PersonMemoryEntry, projectNames: ReadonlyMap<string, string>): string {
  const [latest] = [...entry.sources].sort((left, right) =>
    right.endedAt.localeCompare(left.endedAt),
  );
  if (latest === undefined) return "";
  const project =
    latest.projectId === undefined ? undefined : projectNames.get(String(latest.projectId));
  const where = [MODE_LABEL[latest.mode], project].filter((part) => part !== undefined).join(", ");
  const more = entry.sources.length > 1 ? ` and ${entry.sources.length - 1} more` : "";
  const edited = entry.editedAt === undefined ? "" : " Edited by you.";
  return `From “${latest.title}” (${where}, ${latest.endedAt.slice(0, 10)})${more}.${edited}`;
}
