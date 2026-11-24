import { OctantEmpty } from "../ui/base/OctantEmpty";
import {
  SPEECH_SYNTHESIS_MODEL_PRESETS,
  SPEECH_SYNTHESIS_VOICE_PRESETS,
  SPEECH_TRANSCRIPTION_MODEL_PRESETS,
  type ProviderInstanceId,
  type ProviderModelId,
  type SettingsSettingId,
  type SpeechEndpointRef,
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
  resolveSpeechEndpoint,
  type SpeechEndpointResolution,
} from "@octant/domain";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { X } from "../ui/icons";
import { MicrophonePicker } from "../voice/MicrophonePicker";
import { MicrophoneTest } from "../voice/MicrophoneTest";
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

  return (
    <section aria-label="Voice" id="settings-voice">
      {eligible.length === 0 && !hasConfiguredEndpoint ? (
        <OctantEmpty
          layout="line"
          action={
            props.onOpenModelEndpoints === undefined ? null : (
              <OctantButton onClick={props.onOpenModelEndpoints} size="sm" variant="secondary">
                Open Model endpoints
              </OctantButton>
            )
          }
          detail="Voice runs on an OpenAI-compatible endpoint. An OpenAI API or Mistral key can transcribe; add one under Octant Harness › Model endpoints."
          title="No endpoint for voice yet"
          tone="page"
        />
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
                  onClear={() => {
                    const { transcription: _cleared, ...rest } = props.settings;
                    apply(rest);
                  }}
                  onSave={(ref) => apply({ ...props.settings, transcription: ref })}
                />
              </SettingRow>
              <SettingRow
                description="The language you speak. Automatic lets the model work it out."
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
const OTHER = "other";
const SAVED = "saved";

interface TranscriptionMenuProps {
  readonly choices: ReadonlyArray<TranscriptionChoice>;
  readonly current: SpeechEndpointRef | undefined;
  readonly eligible: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
  readonly instances: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
  readonly onSave: (ref: SpeechEndpointRef) => void;
  readonly onClear: () => void;
}

/**
 * Transcription is one choice: Off, or a model an endpoint already serves.
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
  const options: Array<{ readonly id: string; readonly label: string }> = [
    { id: OFF, label: "Off" },
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
  options.push({ id: OTHER, label: "Other model…" });
  const selected = otherOpen
    ? OTHER
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
            if (current !== undefined) props.onClear();
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
