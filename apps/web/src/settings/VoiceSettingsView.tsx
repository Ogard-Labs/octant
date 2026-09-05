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
  type VoiceSettings,
} from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import { listSpeechEligibleInstances, resolveSpeechEndpoint } from "@octant/domain";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingRow } from "./primitives";
import { settingId } from "./registry";

export interface VoiceSettingsViewProps {
  readonly settings: VoiceSettings;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly focusedSetting?: SettingsSettingId | undefined;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
}

/**
 * Voice settings section: which OpenAI-compatible provider turns speech into
 * text, and which turns text into speech. Both persist through the journaled
 * shell settings, and the section shows what the host would actually do with
 * each choice — the same resolution the speech routes run — so it cannot
 * promise a voice the runtime will refuse.
 */
export function VoiceSettingsView(props: VoiceSettingsViewProps) {
  const instances = props.providerSnapshot?.instances ?? [];
  const eligible = listSpeechEligibleInstances(instances);

  const apply = (next: VoiceSettings) => props.onSettingsChange({ voice: next });

  return (
    <section aria-label="Voice" id="settings-voice">
      {eligible.length === 0 ? (
        <p className="provider-settings__hint" role="status">
          Voice needs an enabled OpenAI-compatible HTTP provider. Add one in Providers &amp; Models,
          then choose it here.
        </p>
      ) : null}
      <div className="settings-card-section settings-card-section--open">
        <h2>Speech to text</h2>
        <div className="setgroup">
          <SettingRow
            description="Turns a recording into text on the chosen provider's audio endpoint. Without one, microphone controls stay hidden rather than guessing an endpoint."
            focused={props.focusedSetting === settingId("transcription")}
            label="Transcription"
            scope="app"
            settingId="transcription"
          >
            <SpeechEndpointForm
              current={props.settings.transcription}
              direction="transcription"
              eligible={eligible}
              instances={instances}
              onClear={() => {
                const { transcription: _cleared, ...rest } = props.settings;
                apply(rest);
              }}
              onSave={(ref) => apply({ ...props.settings, transcription: ref })}
            />
          </SettingRow>
        </div>
      </div>
      <div className="settings-card-section settings-card-section--open">
        <h2>Text to speech</h2>
        <div className="setgroup">
          <SettingRow
            description="Reads text aloud with the chosen provider's voice. Without one, read-aloud uses this computer's own voices and makes no provider call."
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
      </div>
    </section>
  );
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
        Suggested models are data, not a catalog Octant maintains: {modelPresets.join(", ")}.
        {props.direction === "synthesis"
          ? ` Voices depend on the model; OpenAI's include ${SPEECH_SYNTHESIS_VOICE_PRESETS.join(", ")}.`
          : " Any model ID the endpoint accepts works."}
      </p>
      {problem === undefined ? null : (
        <p className="provider-settings__field-guidance" role="alert">
          {problem}
        </p>
      )}
      <p className="provider-settings__field-guidance" role="status">
        {resolution.status === "ready"
          ? `${label} runs on ${resolution.instance.displayName} with ${String(resolution.modelId)}${
              resolution.voice === undefined ? "" : ` as ${resolution.voice}`
            }.`
          : resolution.status === "unconfigured"
            ? props.direction === "transcription"
              ? "Transcription is not configured, so microphone controls stay hidden."
              : "No speech provider is configured, so read-aloud uses this computer's voices."
            : `${label} is unavailable: ${resolution.reason}`}
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
