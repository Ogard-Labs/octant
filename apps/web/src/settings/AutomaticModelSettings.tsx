import type { PersonMemoryClient } from "@octant/client-runtime/person-memory-client";
import type { CodeSettings } from "@octant/contracts/code";
import type { PersonMemorySettings, PersonMemoryView } from "@octant/contracts/person-memory";
import type { ProviderInstance, ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShieldModelChoice } from "@octant/contracts/shield";
import type { ThreadTitleSettings, ThreadTitleSource } from "@octant/contracts/shell";
import type { SettingsSettingId } from "@octant/contracts";
import {
  AUTOMATIC_MODEL_DISCLOSURE,
  AUTOMATIC_MODEL_JOB_LABELS,
  AUTOMATIC_MODEL_NO_SWITCH_NOTE,
  DECISION_REVIEW_OFF_LABEL,
  automaticModelUnavailableReason,
  threadTitleEndpointSource,
  type AutomaticModelJob,
} from "@octant/domain/automatic-model-policy";
import { useCallback, useEffect, useState } from "react";
import type { CodeSettingsUpdate } from "../code/CodeSettingsView";
import { OctantButton } from "../ui/base/OctantButton";
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
  readonly threadTitles?: ThreadTitleSettings | undefined;
  readonly onThreadTitlesChange?: (
    settings: ThreadTitleSettings,
  ) => Promise<boolean> | boolean | void;
  readonly onOpenModelEndpoints?: () => void;
}

export const AUTOMATIC_MODEL_INTRO =
  "Choose which models Octant uses for background tasks. The Judge and memory use the thread’s provider by default. Thread titles and second opinions use a model only after you choose one. Calls appear in Usage.";

const DEFAULT_LABEL = "The thread's provider, smallest model";

/** An automatic job's model choice as one select value; empty is the thread's own provider. */
export const THREAD_PROVIDER_MODEL = "thread-provider";
export const modelValue = (choice: ShieldModelChoice | undefined) =>
  choice === undefined
    ? THREAD_PROVIDER_MODEL
    : `${String(choice.providerInstanceId)}/${String(choice.modelId)}`;

type ModelOption = {
  readonly id: string;
  readonly label: string;
  readonly choice?: ShieldModelChoice;
  readonly unavailable?: true;
};

/**
 * The accounts an automatic job may use: each enabled provider account's
 * catalogued models, local ones and API-key accounts included, an API-key
 * account marked as one. The default is each thread's own provider account
 * with that provider's smallest model.
 */
export function shieldModelOptions(
  snapshot: ProviderRegistrySnapshot | undefined,
  current: ShieldModelChoice | undefined,
  /** What the first option, which stands for no choice, is called. */
  defaultLabel: string = DEFAULT_LABEL,
  eligible: (instance: ProviderInstance) => boolean = () => true,
): ReadonlyArray<ModelOption> {
  const options: ModelOption[] = [{ id: THREAD_PROVIDER_MODEL, label: defaultLabel }];
  for (const instance of snapshot?.instances ?? []) {
    if (!instance.enabled || !eligible(instance)) continue;
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
    options.push({
      id: modelValue(current),
      label: current.modelId,
      choice: current,
      unavailable: true,
    });
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
  "decision-review": "Until it is back, decisions show no second opinion.",
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
  const reviewChoice = memory?.settings.decisionReviewModel;
  const reviewOptions = shieldModelOptions(
    props.providerSnapshot,
    reviewChoice,
    DECISION_REVIEW_OFF_LABEL,
  );
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

  async function chooseReview(value: string) {
    if (client === undefined || memory === undefined) return;
    const option = reviewOptions.find((candidate) => candidate.id === value);
    if (option === undefined || option.id === modelValue(reviewChoice)) return;
    const { decisionReviewModel: _previous, ...rest }: PersonMemorySettings = memory.settings;
    const settings: PersonMemorySettings =
      value === THREAD_PROVIDER_MODEL || option.choice === undefined
        ? rest
        : { ...rest, decisionReviewModel: option.choice };
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
      setProblem("The second opinion's model could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const memoryAvailable = client !== undefined && !memoryFailed;
  return (
    <SettingsSection description={AUTOMATIC_MODEL_INTRO} title="Automatic model calls">
      <div className="setgroup">
        {props.onThreadTitlesChange === undefined ? null : (
          <ThreadTitleRows
            settings={props.threadTitles ?? { source: "first-message" }}
            focusedSetting={props.focusedSetting}
            onChange={props.onThreadTitlesChange}
            onOpenModelEndpoints={props.onOpenModelEndpoints}
            onProblem={setProblem}
            snapshot={props.providerSnapshot}
          />
        )}
        <SettingRow
          description={
            <JobNote choice={judgeChoice} job="shield-judge" snapshot={props.providerSnapshot} />
          }
          focused={props.focusedSetting === "automatic-model-judge"}
          label={AUTOMATIC_MODEL_JOB_LABELS["shield-judge"]}
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
          label={AUTOMATIC_MODEL_JOB_LABELS["person-memory"]}
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
            <span className="settings-state">Shown on the computer running Octant only.</span>
          )}
        </SettingRow>
        <SettingRow
          description={
            <JobNote
              choice={reviewChoice}
              job="decision-review"
              snapshot={props.providerSnapshot}
            />
          }
          focused={props.focusedSetting === "automatic-model-decision-review"}
          label={AUTOMATIC_MODEL_JOB_LABELS["decision-review"]}
          scope="host"
          settingId="automatic-model-decision-review"
        >
          {memoryAvailable ? (
            <OctantSelectField
              aria-label="Model for second opinions on decisions"
              className="settings-view__select window-no-drag"
              disabled={busy || memory === undefined}
              onValueChange={(value) => void chooseReview(value)}
              options={reviewOptions.map(({ id, label }) => ({ id, label }))}
              value={modelValue(reviewChoice)}
            />
          ) : (
            <span className="settings-state">Shown on the computer running Octant only.</span>
          )}
        </SettingRow>
      </div>
      <p className="setgroup-note">{AUTOMATIC_MODEL_NO_SWITCH_NOTE}</p>
      {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
    </SettingsSection>
  );
}

const TITLE_SOURCES = [
  { id: "first-message", label: "Use first message" },
  { id: "api", label: "API endpoint" },
  { id: "subscription", label: "Subscription" },
] as const satisfies ReadonlyArray<{ readonly id: ThreadTitleSource; readonly label: string }>;

function ThreadTitleRows(props: {
  readonly settings: ThreadTitleSettings;
  readonly focusedSetting: SettingsSettingId | undefined;
  readonly onChange: NonNullable<AutomaticModelSettingsProps["onThreadTitlesChange"]>;
  readonly onOpenModelEndpoints: (() => void) | undefined;
  readonly onProblem: (message: string | undefined) => void;
  readonly snapshot: ProviderRegistrySnapshot | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const { source } = props.settings;
  const modelKey = source === "subscription" ? "subscriptionModel" : "apiModel";
  const choice = props.settings[modelKey];
  const modelLabel = source === "subscription" ? "Subscription model" : "API endpoint model";
  const options = shieldModelOptions(
    props.snapshot,
    choice,
    "Choose model",
    (instance) => threadTitleEndpointSource(instance) === source,
  );
  const value = modelValue(choice);
  const hasModel = options.some((option) => option.choice !== undefined && !option.unavailable);
  const missingModel = props.snapshot !== undefined && options.some((option) => option.unavailable);
  const unavailable =
    accountProblem(props.snapshot, choice) ??
    (missingModel ? "The saved model is unavailable." : undefined);
  const focusModel = props.focusedSetting === "automatic-model-thread-title-model";
  const modelPurpose =
    choice === undefined
      ? source === "subscription"
        ? "Choose a model from a ChatGPT plan endpoint, used when you send the first message."
        : "Choose a model from an API endpoint; your provider may charge for title requests."
      : `Octant sends up to 2,000 characters of the first message to ${destination(props.snapshot, choice)}, with recognizable secrets removed.`;

  async function save(next: ThreadTitleSettings) {
    if (busy) return;
    setBusy(true);
    props.onProblem(undefined);
    try {
      if ((await props.onChange(next)) === false) {
        props.onProblem("Thread title settings could not be saved.");
      }
    } catch {
      props.onProblem("Thread title settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingRow
        description="Choose how Octant names new Chat, Work, and Code threads; model sources receive an excerpt of the first message."
        more="Octant remembers each model choice."
        focused={
          props.focusedSetting === "automatic-model-thread-title" ||
          (focusModel && source === "first-message")
        }
        label="Thread titles"
        scope="host"
        settingId="automatic-model-thread-title"
      >
        <OctantSelectField
          aria-label="Thread title source"
          aria-describedby="automatic-model-thread-title-description"
          className="settings-view__select window-no-drag"
          disabled={busy}
          onValueChange={(next) => {
            const selected = TITLE_SOURCES.find(({ id }) => id === next);
            if (selected !== undefined && selected.id !== source) {
              void save({ ...props.settings, source: selected.id });
            }
          }}
          options={TITLE_SOURCES}
          value={source}
        />
      </SettingRow>
      {source === "first-message" ? null : (
        <SettingRow
          // A model that cannot be used now is the row's news, so its reason is
          // the sentence and what the row usually says waits behind More.
          description={unavailable ?? modelPurpose}
          {...(unavailable === undefined
            ? {}
            : { more: `Octant names threads from the first message meanwhile. ${modelPurpose}` })}
          label={modelLabel}
          focused={focusModel}
          scope="host"
          settingId="automatic-model-thread-title-model"
        >
          {!hasModel && props.onOpenModelEndpoints !== undefined ? (
            <OctantButton
              onClick={props.onOpenModelEndpoints}
              size="sm"
              type="button"
              variant="secondary"
            >
              Open Model endpoints
            </OctantButton>
          ) : (
            <OctantSelectField
              aria-label={modelLabel}
              aria-describedby="automatic-model-thread-title-model-description"
              className="settings-view__select window-no-drag"
              disabled={busy || !hasModel}
              onValueChange={(next) => {
                const selected = options.find(
                  (option) => option.id === next && !option.unavailable,
                )?.choice;
                if (selected !== undefined && next !== value) {
                  void save({ ...props.settings, [modelKey]: selected });
                }
              }}
              options={options.map(({ id, label, choice: model, unavailable }) => ({
                id,
                label,
                disabled: model === undefined || unavailable === true,
              }))}
              value={value}
            />
          )}
        </SettingRow>
      )}
    </>
  );
}

function JobNote(props: {
  readonly job: AutomaticModelJob;
  readonly choice: ShieldModelChoice | undefined;
  readonly snapshot: ProviderRegistrySnapshot | undefined;
}) {
  const unavailable = accountProblem(props.snapshot, props.choice);
  // A second opinion goes nowhere until an account is chosen.
  if (props.job === "decision-review" && props.choice === undefined) {
    return <>{AUTOMATIC_MODEL_DISCLOSURE[props.job]} While it is off, nothing is sent.</>;
  }
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
