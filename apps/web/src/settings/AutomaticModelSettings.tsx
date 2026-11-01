import type { PersonMemoryClient } from "@octant/client-runtime/person-memory-client";
import type { CodeSettings } from "@octant/contracts/code";
import type { PersonMemorySettings, PersonMemoryView } from "@octant/contracts/person-memory";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShieldModelChoice } from "@octant/contracts/shield";
import type { SettingsSettingId } from "@octant/contracts";
import {
  AUTOMATIC_MODEL_DISCLOSURE,
  AUTOMATIC_MODEL_NO_SWITCH_NOTE,
  automaticModelUnavailableReason,
  type AutomaticModelJob,
} from "@octant/domain/automatic-model-policy";
import { useCallback, useEffect, useState } from "react";
import type { CodeSettingsUpdate } from "../code/CodeSettingsView";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

export interface AutomaticModelSettingsProps {
  /** The Code settings that hold the Judge's choice; absent until they load. */
  readonly codeSettings: CodeSettings | undefined;
  readonly onCodeUpdate: (input: CodeSettingsUpdate) => Promise<boolean>;
  /** Absent where the host does not show memory, such as a paired device. */
  readonly personMemoryClient: PersonMemoryClient | undefined;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly focusedSetting?: SettingsSettingId | undefined;
}

export const AUTOMATIC_MODEL_INTRO =
  "Some work Octant does for you without being asked: judging an action when Auto is on, and writing memory after a thread. Each job uses the provider of the thread it is about, with that provider's smallest model, unless you choose an account and model here. Every call shows in Usage.";

const DEFAULT_LABEL = "The thread's provider, smallest model";

/** An automatic job's model choice as one select value; empty is the thread's own provider. */
export const THREAD_PROVIDER_MODEL = "thread-provider";
export const modelValue = (choice: ShieldModelChoice | undefined) =>
  choice === undefined
    ? THREAD_PROVIDER_MODEL
    : `${String(choice.providerInstanceId)}/${String(choice.modelId)}`;

/**
 * The accounts an automatic job may use: each enabled provider account's
 * catalogued models, local ones and API-key accounts included, an API-key
 * account marked as one. The default is each thread's own provider account
 * with that provider's smallest model.
 */
export function shieldModelOptions(
  snapshot: ProviderRegistrySnapshot | undefined,
  current: ShieldModelChoice | undefined,
): ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly choice?: ShieldModelChoice;
}> {
  const options: Array<{ id: string; label: string; choice?: ShieldModelChoice }> = [
    { id: THREAD_PROVIDER_MODEL, label: DEFAULT_LABEL },
  ];
  for (const instance of snapshot?.instances ?? []) {
    if (!instance.enabled) continue;
    const catalog = snapshot?.catalogs?.find(
      (candidate) => String(candidate.instanceId) === String(instance.id),
    );
    const apiKey =
      snapshot?.observedStates.find((state) => String(state.instanceId) === String(instance.id))
        ?.accountAuthentication === "api-key";
    for (const model of catalog?.models ?? []) {
      const choice = { providerInstanceId: instance.id, modelId: model.id };
      options.push({
        id: modelValue(choice),
        label: `${instance.displayName}${apiKey ? " (API key)" : ""} · ${model.displayName}`,
        choice,
      });
    }
  }
  // A stored choice whose provider is gone is still shown, so the select
  // never claims a choice the host does not hold.
  if (current !== undefined && !options.some((option) => option.id === modelValue(current))) {
    options.push({ id: modelValue(current), label: String(current.modelId), choice: current });
  }
  return options;
}

/** Where the work of one job goes, in words, for the account now chosen. */
function destination(
  snapshot: ProviderRegistrySnapshot | undefined,
  choice: ShieldModelChoice | undefined,
): string {
  if (choice === undefined) return "the provider of the thread it belongs to";
  const instance = snapshot?.instances.find(
    (candidate) => String(candidate.id) === String(choice.providerInstanceId),
  );
  return instance === undefined ? "the account you chose" : instance.displayName;
}

/** What is wrong with the chosen account now, when something is. */
function accountProblem(
  snapshot: ProviderRegistrySnapshot | undefined,
  choice: ShieldModelChoice | undefined,
): string | undefined {
  if (choice === undefined || snapshot === undefined) return undefined;
  const instance = snapshot.instances.find(
    (candidate) => String(candidate.id) === String(choice.providerInstanceId),
  );
  return automaticModelUnavailableReason({
    instance,
    readiness: snapshot.observedStates.find(
      (state) => String(state.instanceId) === String(choice.providerInstanceId),
    )?.readiness,
    atLimit: false,
  });
}

const CONSEQUENCE: Readonly<Record<AutomaticModelJob, string>> = {
  "shield-judge": "Until it is back, the Judge asks you about each action.",
  "person-memory": "Until it is back, memory waits and tries again later.",
};

/**
 * Settings › Providers & Models › Automatic model calls: for each job Octant
 * runs on a model unasked, the thread's provider (the default) or one account
 * and model the person picks, API-key accounts included. It is the one place
 * either job's model is chosen; the host stores each choice where its job
 * reads it. Changing it is possible only from a window on this host.
 */
export function AutomaticModelSettings(props: AutomaticModelSettingsProps) {
  const { personMemoryClient: client } = props;
  const [memory, setMemory] = useState<PersonMemoryView>();
  const [memoryFailed, setMemoryFailed] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setMemory(await client.read());
      setMemoryFailed(false);
    } catch {
      setMemoryFailed(true);
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const judgeChoice = props.codeSettings?.shieldModel;
  const memoryChoice = memory?.settings.distillModel;
  const judgeOptions = shieldModelOptions(props.providerSnapshot, judgeChoice);
  const memoryOptions = shieldModelOptions(props.providerSnapshot, memoryChoice);
  const [judgeValue, setJudgeValue] = useState(modelValue(judgeChoice));
  const [seenJudge, setSeenJudge] = useState(judgeChoice);
  if (seenJudge !== judgeChoice) {
    setSeenJudge(judgeChoice);
    setJudgeValue(modelValue(judgeChoice));
  }

  async function chooseJudge(value: string) {
    const option = judgeOptions.find((candidate) => candidate.id === value);
    if (option === undefined || option.id === judgeValue || props.codeSettings === undefined) {
      return;
    }
    const settings = props.codeSettings;
    setJudgeValue(option.id);
    setProblem(undefined);
    let saved = false;
    try {
      saved = await props.onCodeUpdate({
        defaultExecutionPolicy: settings.defaultExecutionPolicy,
        defaultPermissionPersistence: settings.defaultPermissionPersistence,
        requireGitRepository: settings.requireGitRepository,
        ...(settings.defaultDiffLayout === undefined
          ? {}
          : { defaultDiffLayout: settings.defaultDiffLayout }),
        ...(settings.externalEditor === undefined
          ? {}
          : { externalEditor: settings.externalEditor }),
        shieldModel: option.choice ?? null,
      });
    } catch {
      saved = false;
    }
    if (!saved) {
      setJudgeValue(modelValue(judgeChoice));
      setProblem("The Judge's model could not be saved.");
    }
  }

  async function chooseMemory(value: string) {
    if (client === undefined || memory === undefined) return;
    const option = memoryOptions.find((candidate) => candidate.id === value);
    if (option === undefined || option.id === modelValue(memoryChoice)) return;
    const { distillModel: _previous, ...rest }: PersonMemorySettings = memory.settings;
    const settings: PersonMemorySettings =
      value === THREAD_PROVIDER_MODEL || option.choice === undefined
        ? rest
        : { ...rest, distillModel: option.choice };
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.change({
        kind: "change-person-memory-settings",
        expectedVersion: memory.version,
        settings,
      });
      if (result.kind === "person-memory") {
        setMemory(result);
      } else {
        setProblem(result.message);
        await load();
      }
    } catch {
      setProblem("Memory's model could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const memoryAvailable = client !== undefined && !memoryFailed;
  return (
    <SettingsSection description={AUTOMATIC_MODEL_INTRO} title="Automatic model calls">
      <div className="setgroup">
        <SettingRow
          description={
            <JobNote choice={judgeChoice} job="shield-judge" snapshot={props.providerSnapshot} />
          }
          focused={props.focusedSetting === "automatic-model-judge"}
          label="Octant Shield's Judge"
          scope="host"
          settingId="automatic-model-judge"
        >
          <OctantSelectField
            aria-label="Model for Octant Shield's Judge"
            className="settings-view__select window-no-drag"
            disabled={props.codeSettings === undefined}
            onValueChange={(value) => void chooseJudge(value)}
            options={judgeOptions.map(({ id, label }) => ({ id, label }))}
            value={judgeValue}
          />
        </SettingRow>
        <SettingRow
          description={
            <JobNote choice={memoryChoice} job="person-memory" snapshot={props.providerSnapshot} />
          }
          focused={props.focusedSetting === "automatic-model-memory"}
          label="Memory distilling"
          scope="host"
          settingId="automatic-model-memory"
        >
          {memoryAvailable ? (
            <OctantSelectField
              aria-label="Model for memory distilling"
              className="settings-view__select window-no-drag"
              disabled={busy || memory === undefined || !memory.settings.enabled}
              onValueChange={(value) => void chooseMemory(value)}
              options={memoryOptions.map(({ id, label }) => ({ id, label }))}
              value={modelValue(memoryChoice)}
            />
          ) : (
            <span className="settings-state">Shown on the host machine only.</span>
          )}
        </SettingRow>
      </div>
      <p className="setgroup-note">{AUTOMATIC_MODEL_NO_SWITCH_NOTE}</p>
      {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
    </SettingsSection>
  );
}

function JobNote(props: {
  readonly job: AutomaticModelJob;
  readonly choice: ShieldModelChoice | undefined;
  readonly snapshot: ProviderRegistrySnapshot | undefined;
}) {
  const unavailable = accountProblem(props.snapshot, props.choice);
  return (
    <>
      {AUTOMATIC_MODEL_DISCLOSURE[props.job]} It goes to {destination(props.snapshot, props.choice)}
      .
      {unavailable === undefined ? null : (
        <>
          {" "}
          <strong>
            {unavailable} {CONSEQUENCE[props.job]}
          </strong>
        </>
      )}
    </>
  );
}
