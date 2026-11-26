import { OctantEmpty } from "../ui/base/OctantEmpty";
import {
  SPEECH_SYNTHESIS_MODEL_PRESETS,
  SPEECH_SYNTHESIS_VOICE_PRESETS,
  SPEECH_TRANSCRIPTION_MODEL_PRESETS,
  type ProviderInstanceId,
  type ProviderModelId,
  type SettingsSettingId,
  type SpeechEndpointRef,
  type SpeechLocalEngineStatus,
  type SpeechSynthesisEndpointRef,
  type SpeechSynthesisVoice,
  type SpeechTranscriptionLanguage,
  type VoiceDictionaryTerm,
  type VoiceSettings,
} from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import {
  addVoiceDictionaryTerms,
  listSpeechEligibleInstances,
  LOCAL_SPEECH_PAIRED_REASON,
  localSpeechProblem,
  resolveSpeechEndpoint,
  type SpeechEndpointResolution,
} from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { X } from "../ui/icons";
import { MicrophonePicker } from "../voice/MicrophonePicker";
import { MicrophoneTest } from "../voice/MicrophoneTest";
import { useSpeechCapability } from "../voice/SpeechCapabilityContext";
import { transcriptionChoices, type TranscriptionChoice } from "./harness/voiceModels";
import { SettingRow, SettingsSection } from "./primitives";
import { settingId } from "./registry";

export interface VoiceSettingsViewProps {
  readonly settings: VoiceSettings;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly focusedSetting?: SettingsSettingId | undefined;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
  readonly onOpenModelEndpoints?: () => void;
}

/**
 * Voice settings section: where speech is turned into text, which provider
 * turns text into speech, and a microphone test. Both endpoints persist through
 * the journaled shell settings, and the section shows what the host would actually do with
 * each choice — the same resolution the speech routes run — so it cannot
 * promise a voice the runtime will refuse.
 */
export function VoiceSettingsView(props: VoiceSettingsViewProps) {
  const instances = props.providerSnapshot?.instances ?? [];
  const eligible = listSpeechEligibleInstances(instances);
  const choices = transcriptionChoices(instances, props.providerSnapshot?.observedStates ?? []);

  const apply = (next: VoiceSettings) => props.onSettingsChange({ voice: next });
  const hasConfiguredEndpoint =
    props.settings.transcription !== undefined || props.settings.synthesis !== undefined;
  const showEndpoints = eligible.length > 0 || hasConfiguredEndpoint;
  const local = useLocalEngine(props.settings.language);
  const localOffered =
    props.settings.transcriptionEngine !== undefined ||
    (local.status !== undefined && local.status.status !== "unsupported");
  const noEndpoint = (
    <OctantEmpty
      layout="line"
      action={
        props.onOpenModelEndpoints === undefined ? null : (
          <OctantButton onClick={props.onOpenModelEndpoints} size="sm" variant="secondary">
            Open Model endpoints
          </OctantButton>
        )
      }
      detail={
        localOffered
          ? "Reading replies aloud with a provider's voice needs an OpenAI-compatible endpoint; add one under Octant Harness › Model endpoints."
          : "Voice runs on an OpenAI-compatible endpoint. An OpenAI API or Mistral key can transcribe; add one under Octant Harness › Model endpoints."
      }
      title={localOffered ? "No endpoint for reading aloud yet" : "No endpoint for voice yet"}
      tone="page"
    />
  );

  return (
    <section aria-label="Voice" id="settings-voice">
      {!showEndpoints && !localOffered ? (
        noEndpoint
      ) : (
        <>
          <SettingsSection title="Speech to text">
            <div className="setgroup">
              <SettingRow
                description="Where your speech is turned into text."
                focused={props.focusedSetting === settingId("transcription")}
                label="Transcribe with"
                scope="app"
                settingId="transcription"
              >
                <TranscriptionMenu
                  choices={choices}
                  current={props.settings.transcription}
                  eligible={eligible}
                  instances={instances}
                  local={local}
                  localChosen={props.settings.transcriptionEngine !== undefined}
                  localOffered={localOffered}
                  onClear={() => {
                    const {
                      transcription: _cleared,
                      transcriptionEngine: _engine,
                      ...rest
                    } = props.settings;
                    apply(rest);
                  }}
                  onSave={(ref) => {
                    const { transcriptionEngine: _engine, ...rest } = props.settings;
                    apply({ ...rest, transcription: ref });
                  }}
                  onUseLocal={() =>
                    apply({ ...props.settings, transcriptionEngine: "apple-speech" })
                  }
                />
              </SettingRow>
              <SettingRow
                description={
                  props.settings.transcriptionEngine === undefined
                    ? "The language you speak. Automatic lets the model work it out."
                    : "The language you speak. Automatic uses this Mac's own language."
                }
                focused={props.focusedSetting === settingId("dictation-language")}
                label="Language"
                scope="app"
                settingId="dictation-language"
              >
                <LanguageMenu
                  current={props.settings.language}
                  onChange={(language) => {
                    const { language: _previous, ...rest } = props.settings;
                    apply(language === undefined ? rest : { ...rest, language });
                  }}
                />
              </SettingRow>
              <SettingRow
                description="Names and terms to spell your way. Every transcription on this computer uses them."
                focused={props.focusedSetting === settingId("dictation-dictionary")}
                label="Your dictionary"
                scope="app"
                settingId="dictation-dictionary"
              >
                <DictionaryEditor
                  dictionary={props.settings.dictionary ?? []}
                  onChange={(dictionary) => {
                    const { dictionary: _previous, ...rest } = props.settings;
                    apply(dictionary.length === 0 ? rest : { ...rest, dictionary });
                  }}
                />
              </SettingRow>
            </div>
          </SettingsSection>
          {showEndpoints ? null : noEndpoint}
          {!showEndpoints ? null : (
            <SettingsSection title="Text to speech">
              <div className="setgroup">
                <SettingRow
                  description="Pick a provider voice, or use this computer's voices with no provider call."
                  focused={props.focusedSetting === settingId("synthesis")}
                  label="Speech"
                  scope="app"
                  settingId="synthesis"
                >
                  <SpeechEndpointForm
                    current={props.settings.synthesis}
                    direction="synthesis"
                    eligible={eligible}
                    instances={instances}
                    onClear={() => {
                      const { synthesis: _cleared, ...rest } = props.settings;
                      apply(rest);
                    }}
                    onSave={(ref) => apply({ ...props.settings, synthesis: ref })}
                  />
                </SettingRow>
              </div>
            </SettingsSection>
          )}
        </>
      )}
      <SettingsSection title="Microphone">
        <div className="setgroup">
          <SettingRow
            description="Dictation records from this microphone on this computer."
            focused={props.focusedSetting === settingId("microphone")}
            label="Microphone"
            scope="app"
            settingId="microphone"
          >
            <MicrophonePicker />
          </SettingRow>
          <SettingRow
            description="Record ten seconds and play it back. The audio stays on this computer unless you transcribe it."
            focused={props.focusedSetting === settingId("microphone-test")}
            label="Test microphone"
            scope="app"
            settingId="microphone-test"
          >
            <MicrophoneTest />
          </SettingRow>
        </div>
      </SettingsSection>
    </section>
  );
}

const OFF = "off";
const LOCAL = "apple-speech";

interface LocalEngine {
  /** Absent until the host answers, and where it cannot be asked. */
  readonly status: SpeechLocalEngineStatus | undefined;
  readonly download: () => void;
}

/**
 * What the host's own engine says about the language shown, read while
 * Settings is open and every second while its model downloads. When the model
 * arrives the composers are told, so a microphone appears without a reload.
 */
function useLocalEngine(language: string | undefined): LocalEngine {
  const speech = useSpeechCapability();
  const client = speech.client;
  const [status, setStatus] = useState<SpeechLocalEngineStatus>();
  const [asked, setAsked] = useState(0);
  const last = useRef<SpeechLocalEngineStatus | undefined>(undefined);
  const downloading = status?.status === "downloading";

  useEffect(() => {
    if (client === undefined) return undefined;
    let live = true;
    client.localEngine(language).then(
      (next) => {
        if (!live) return;
        // Told outside the state update: React may run an updater while it
        // renders, and the composers' provider must not change then.
        if (last.current?.status !== "ready" && next.status === "ready") speech.refresh();
        last.current = next;
        setStatus(next);
      },
      () => {
        if (!live) return;
        last.current = undefined;
        setStatus(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [client, language, asked]);

  useEffect(() => {
    if (!downloading) return undefined;
    const timer = window.setTimeout(() => setAsked((count) => count + 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [downloading, status]);

  return {
    status,
    download: () => {
      if (client === undefined) return;
      void client.downloadLocalModel(language).then(setStatus, () => {
        setStatus(
          status?.status === "not-downloaded" || status?.status === "download-failed"
            ? { status: "download-failed", language: status.language }
            : { status: "failed" },
        );
      });
    },
  };
}

function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** What the on-device engine would do now, said for the person choosing it. */
function LocalEngineState(props: {
  readonly local: LocalEngine;
  readonly fallback: string | undefined;
}) {
  const status = props.local.status;
  let sentence: string;
  let action: string | undefined;
  switch (status?.status) {
    case undefined:
      sentence = props.fallback ?? "Checking Apple Speech on this Mac…";
      break;
    case "ready":
      sentence = `Dictation is turned into text on this Mac in ${languageName(status.language)}; no recording leaves it. Paired phones and browsers cannot dictate, and agents cannot transcribe recordings, while this is chosen.`;
      break;
    case "not-downloaded":
      sentence = `Apple's speech model for ${languageName(status.language)} is not on this Mac yet. macOS downloads it from Apple when you ask; no audio is sent.`;
      action = "Download model";
      break;
    case "downloading":
      sentence = `Downloading Apple's speech model for ${languageName(status.language)}… ${String(Math.round(status.fraction * 100))}%`;
      break;
    case "download-failed":
      sentence = `Apple's speech model for ${languageName(status.language)} could not be downloaded. Check the connection and free space on this Mac.`;
      action = "Try again";
      break;
    default:
      sentence =
        (status === undefined ? undefined : localSpeechProblem(status)) ??
        "Apple Speech did not answer on this Mac.";
  }
  return (
    <>
      <p className="provider-settings__field-guidance" role="status">
        {sentence}
      </p>
      {action === undefined ? null : (
        <div className="settings-view__actions">
          <OctantButton onClick={props.local.download} size="sm" type="button" variant="secondary">
            {action}
          </OctantButton>
        </div>
      )}
    </>
  );
}
const OTHER = "other";
const SAVED = "saved";

interface TranscriptionMenuProps {
  readonly choices: ReadonlyArray<TranscriptionChoice>;
  readonly current: SpeechEndpointRef | undefined;
  readonly eligible: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
  readonly instances: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
  readonly onSave: (ref: SpeechEndpointRef) => void;
  readonly onClear: () => void;
  readonly local: LocalEngine;
  readonly localChosen: boolean;
  readonly localOffered: boolean;
  readonly onUseLocal: () => void;
}

/**
 * Transcription is one choice: Off, Apple Speech on a Mac that can run it, or
 * a model an endpoint already serves.
 * Picking one saves it, so turning dictation on takes no typing. A model no
 * endpoint lists stays reachable under Other model…, and a saved one keeps
 * its own entry so the menu never claims something else is in use.
 */
function TranscriptionMenu(props: TranscriptionMenuProps) {
  const [otherOpen, setOtherOpen] = useState(false);
  const current = props.current;
  const currentIndex =
    current === undefined
      ? -1
      : props.choices.findIndex(
          (choice) =>
            String(choice.instanceId) === String(current.providerInstanceId) &&
            String(choice.modelId) === String(current.modelId),
        );
  const speech = useSpeechCapability();
  const options: Array<{ readonly id: string; readonly label: string }> = [
    { id: OFF, label: "Off" },
    ...(props.localOffered ? [{ id: LOCAL, label: "Apple Speech on this Mac" }] : []),
    ...props.choices.map((choice, index) => ({
      id: `choice-${index}`,
      label: `${String(choice.modelId)} on ${choice.instanceName}`,
    })),
  ];
  if (current !== undefined && currentIndex === -1) {
    const name =
      props.instances.find((instance) => String(instance.id) === String(current.providerInstanceId))
        ?.displayName ?? "Removed provider";
    options.push({ id: SAVED, label: `${String(current.modelId)} on ${name}` });
  }
  if (props.eligible.length > 0 || current !== undefined)
    options.push({ id: OTHER, label: "Other model…" });
  const selected = otherOpen
    ? OTHER
    : props.localChosen
      ? LOCAL
      : current === undefined
        ? OFF
        : currentIndex === -1
          ? SAVED
          : `choice-${currentIndex}`;
  const resolution = resolveSpeechEndpoint(current, props.instances);

  return (
    <div className="voice-settings__choice">
      <OctantSelectField
        aria-label="Transcribe with"
        className="settings-view__select window-no-drag"
        onValueChange={(value) => {
          if (value === OTHER) {
            setOtherOpen(true);
            return;
          }
          setOtherOpen(false);
          if (value === OFF) {
            if (current !== undefined || props.localChosen) props.onClear();
            return;
          }
          if (value === LOCAL) {
            if (!props.localChosen) props.onUseLocal();
            return;
          }
          if (value === SAVED) {
            if (current !== undefined) props.onSave(current);
            return;
          }
          const choice = props.choices[Number(value.replace("choice-", ""))];
          if (choice === undefined) return;
          props.onSave({ providerInstanceId: choice.instanceId, modelId: choice.modelId });
        }}
        options={options}
        value={selected}
      />
      {otherOpen ? (
        <SpeechEndpointForm
          current={current}
          direction="transcription"
          eligible={props.eligible}
          instances={props.instances}
          onClear={() => {
            setOtherOpen(false);
            props.onClear();
          }}
          onSave={(ref) => {
            setOtherOpen(false);
            props.onSave(ref);
          }}
        />
      ) : props.localChosen ? (
        <LocalEngineState
          fallback={
            // Only the host's own answer is worth repeating here; before it
            // answers the status holds a placeholder, not a fact.
            speech.status.transcription.status === "unavailable" &&
            speech.status.transcription.reason === LOCAL_SPEECH_PAIRED_REASON
              ? speech.status.transcription.reason
              : undefined
          }
          local={props.local}
        />
      ) : (
        <p className="provider-settings__field-guidance" role="status">
          {describeResolution("transcription", resolution)}
          {props.choices.length === 0 && current === undefined
            ? " No endpoint lists a transcription model yet; choose Other model… to enter one."
            : ""}
        </p>
      )}
    </div>
  );
}

/**
 * Languages offered by name. Transcription models accept many more; a tag set
 * some other way (an imported settings file) keeps its own entry.
 */
const DICTATION_LANGUAGES: ReadonlyArray<{ readonly tag: string; readonly name: string }> = [
  { tag: "ar", name: "Arabic" },
  { tag: "zh", name: "Chinese" },
  { tag: "da", name: "Danish" },
  { tag: "nl", name: "Dutch" },
  { tag: "en", name: "English" },
  { tag: "fi", name: "Finnish" },
  { tag: "fr", name: "French" },
  { tag: "de", name: "German" },
  { tag: "hi", name: "Hindi" },
  { tag: "it", name: "Italian" },
  { tag: "ja", name: "Japanese" },
  { tag: "ko", name: "Korean" },
  { tag: "no", name: "Norwegian" },
  { tag: "pl", name: "Polish" },
  { tag: "pt", name: "Portuguese" },
  { tag: "ru", name: "Russian" },
  { tag: "es", name: "Spanish" },
  { tag: "sv", name: "Swedish" },
  { tag: "tr", name: "Turkish" },
  { tag: "uk", name: "Ukrainian" },
];
const AUTOMATIC = "automatic";

function LanguageMenu(props: {
  readonly current: SpeechTranscriptionLanguage | undefined;
  readonly onChange: (language: SpeechTranscriptionLanguage | undefined) => void;
}) {
  const known = DICTATION_LANGUAGES.some((language) => language.tag === props.current);
  const options = [
    { id: AUTOMATIC, label: "Automatic" },
    ...DICTATION_LANGUAGES.map((language) => ({ id: language.tag, label: language.name })),
    ...(props.current !== undefined && !known ? [{ id: props.current, label: props.current }] : []),
  ];
  return (
    <OctantSelectField
      aria-label="Dictation language"
      className="settings-view__select window-no-drag"
      onValueChange={(value) => props.onChange(value === AUTOMATIC ? undefined : value)}
      options={options}
      value={props.current ?? AUTOMATIC}
    />
  );
}

function DictionaryEditor(props: {
  readonly dictionary: ReadonlyArray<VoiceDictionaryTerm>;
  readonly onChange: (dictionary: ReadonlyArray<VoiceDictionaryTerm>) => void;
}) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  return (
    <div className="voice-settings__choice">
      <form
        aria-label="Add to your dictionary"
        className="voice-settings__test-controls"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const field = event.currentTarget.elements.namedItem("terms");
          if (!(field instanceof HTMLInputElement)) return;
          const result = addVoiceDictionaryTerms(props.dictionary, field.value);
          if (result.status === "refused") {
            setProblem(result.reason);
            return;
          }
          setProblem(undefined);
          field.value = "";
          props.onChange(result.dictionary);
        }}
      >
        <OctantInput
          aria-label="Words to add"
          className="settings-view__text-input window-no-drag"
          name="terms"
          placeholder="Add words, separated by commas"
          spellCheck={false}
        />
        <OctantButton size="sm" type="submit" variant="secondary">
          Add
        </OctantButton>
      </form>
      {problem === undefined ? null : (
        /* ui-boundary-exception: inline-field-error */
        <p className="provider-settings__field-guidance" role="alert">
          {problem}
        </p>
      )}
      {props.dictionary.length === 0 ? null : (
        <ul aria-label="Your dictionary" className="voice-settings__terms">
          {props.dictionary.map((term) => (
            <li key={term}>
              <span>{term}</span>
              <OctantButton
                aria-label={`Remove ${term}`}
                onClick={() => props.onChange(props.dictionary.filter((other) => other !== term))}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" size={12} />
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeResolution(
  direction: "transcription" | "synthesis",
  resolution: SpeechEndpointResolution,
): string {
  const label = direction === "transcription" ? "Transcription" : "Speech";
  if (resolution.status === "ready") {
    return `${label} runs on ${resolution.instance.displayName} with ${String(resolution.modelId)}${
      resolution.voice === undefined ? "" : ` as ${resolution.voice}`
    }.`;
  }
  if (resolution.status === "unconfigured") {
    return direction === "transcription"
      ? "Transcription is off, so microphone controls stay hidden."
      : "No speech provider is configured, so read-aloud uses this computer's voices.";
  }
  return `${label} is unavailable: ${resolution.reason}`;
}

type SpeechEndpointFormProps =
  | {
      readonly direction: "transcription";
      readonly current: SpeechEndpointRef | undefined;
      readonly onSave: (ref: SpeechEndpointRef) => void;
      readonly onClear: () => void;
      readonly eligible: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
      readonly instances: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
    }
  | {
      readonly direction: "synthesis";
      readonly current: SpeechSynthesisEndpointRef | undefined;
      readonly onSave: (ref: SpeechSynthesisEndpointRef) => void;
      readonly onClear: () => void;
      readonly eligible: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
      readonly instances: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
    };

function SpeechEndpointForm(props: SpeechEndpointFormProps) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const label = props.direction === "transcription" ? "Transcription" : "Speech";
  const modelPresets =
    props.direction === "transcription"
      ? SPEECH_TRANSCRIPTION_MODEL_PRESETS
      : SPEECH_SYNTHESIS_MODEL_PRESETS;
  const resolution = resolveSpeechEndpoint(props.current, props.instances);
  const options = props.eligible.map((instance) => ({
    id: String(instance.id),
    label: instance.displayName,
  }));
  const currentInstanceId =
    props.current === undefined ? undefined : String(props.current.providerInstanceId);
  // A configured instance that is no longer eligible still shows by name, so a
  // person sees what the setting points at instead of a silently reselected
  // first option.
  const selectOptions =
    currentInstanceId !== undefined && !options.some((option) => option.id === currentInstanceId)
      ? [
          ...options,
          {
            id: currentInstanceId,
            label:
              props.instances.find((instance) => String(instance.id) === currentInstanceId)
                ?.displayName ?? "Removed provider",
          },
        ]
      : options;
  const canSave = props.eligible.length > 0;
  const formKey = `${currentInstanceId ?? ""}:${props.current?.modelId ?? ""}:${
    props.direction === "synthesis" ? (props.current?.voice ?? "") : ""
  }`;

  return (
    <form
      aria-label={`${label} endpoint`}
      className="voice-settings__form"
      key={formKey}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const providerInstanceId = String(data.get("providerInstanceId") ?? "").trim();
        const modelId = String(data.get("modelId") ?? "").trim();
        const voice = String(data.get("voice") ?? "").trim();
        if (providerInstanceId.length === 0) {
          setProblem("Choose a provider.");
          return;
        }
        if (modelId.length === 0) {
          setProblem("Enter a model ID.");
          return;
        }
        if (props.direction === "synthesis" && voice.length === 0) {
          setProblem("Enter a voice.");
          return;
        }
        setProblem(undefined);
        const ref = {
          providerInstanceId: providerInstanceId as ProviderInstanceId,
          modelId: modelId as ProviderModelId,
        };
        if (props.direction === "synthesis") {
          props.onSave({ ...ref, voice: voice as SpeechSynthesisVoice });
        } else {
          props.onSave(ref);
        }
      }}
    >
      <label>
        <span>Provider</span>
        <OctantSelectField
          aria-label={`${label} provider`}
          className="settings-view__select window-no-drag"
          defaultValue={currentInstanceId ?? selectOptions[0]?.id ?? ""}
          disabled={selectOptions.length === 0}
          name="providerInstanceId"
          options={
            selectOptions.length === 0 ? [{ id: "", label: "No eligible provider" }] : selectOptions
          }
        />
      </label>
      <label>
        <span>Model</span>
        <OctantInput
          aria-label={`${label} model`}
          className="settings-view__text-input window-no-drag"
          defaultValue={props.current?.modelId === undefined ? "" : String(props.current.modelId)}
          name="modelId"
          placeholder={modelPresets[0]}
          spellCheck={false}
        />
      </label>
      {props.direction === "synthesis" ? (
        <label>
          <span>Voice</span>
          <OctantInput
            aria-label="Speech voice"
            className="settings-view__text-input window-no-drag"
            defaultValue={props.current?.voice === undefined ? "" : String(props.current.voice)}
            name="voice"
            placeholder={SPEECH_SYNTHESIS_VOICE_PRESETS[0]}
            spellCheck={false}
          />
        </label>
      ) : null}
      <p className="provider-settings__field-guidance">
        Suggested models: {modelPresets.join(", ")}.
        {props.direction === "synthesis"
          ? " Choose a voice supported by your model."
          : " You can also enter another supported model ID."}
      </p>
      {problem === undefined ? null : (
        /* ui-boundary-exception: inline-field-error */
        <p className="provider-settings__field-guidance" role="alert">
          {problem}
        </p>
      )}
      <p className="provider-settings__field-guidance" role="status">
        {describeResolution(props.direction, resolution)}
      </p>
      <div className="settings-view__actions">
        <OctantButton disabled={!canSave} size="sm" type="submit" variant="secondary">
          Save {label.toLowerCase()} endpoint
        </OctantButton>
        {props.current === undefined ? null : (
          <OctantButton onClick={props.onClear} size="sm" type="button" variant="ghost">
            Clear {label.toLowerCase()} endpoint
          </OctantButton>
        )}
      </div>
    </form>
  );
}
