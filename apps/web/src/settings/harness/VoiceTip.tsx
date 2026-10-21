import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { VoiceSettings } from "@octant/contracts";
import { useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import type { VoiceModels } from "./voiceModels";

/** How an endpoint page reaches Voice settings: what they hold, and the two things it may do. */
export interface VoiceLinks {
  readonly settings: VoiceSettings | undefined;
  readonly onUseForTranscription: (
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => Promise<unknown> | unknown;
  readonly onOpenVoice: () => void;
}

export interface VoiceTipProps {
  readonly instanceId: ProviderInstanceId;
  readonly instanceName: string;
  readonly voiceModels: VoiceModels;
  readonly links: VoiceLinks;
  readonly disabled?: boolean;
}

/**
 * A tip under an endpoint that serves voice models: one click makes its
 * transcription model the one Voice uses, and speech is named with what it
 * still needs (a voice), since Octant cannot pick a voice for the person.
 */
export function VoiceTip(props: VoiceTipProps) {
  const [saving, setSaving] = useState(false);
  const { transcription, speech } = props.voiceModels;
  if (transcription === undefined && speech === undefined) return null;
  const current = props.links.settings?.transcription;
  const transcriptionInUse =
    transcription !== undefined &&
    current !== undefined &&
    String(current.providerInstanceId) === String(props.instanceId) &&
    String(current.modelId) === transcription;
  return (
    <div className="voice-tip" data-testid="voice-tip">
      <p className="voice-tip__lead">This endpoint has voice models.</p>
      {transcription === undefined ? null : (
        <p className="voice-tip__row">
          <span>
            {transcriptionInUse
              ? `Transcription uses ${transcription} on ${props.instanceName}.`
              : `${transcription} can turn your speech into text.`}
          </span>
          {transcriptionInUse ? null : (
            <OctantButton
              disabled={props.disabled === true || saving}
              onClick={() => {
                setSaving(true);
                void Promise.resolve(
                  props.links.onUseForTranscription(
                    props.instanceId,
                    transcription as ProviderModelId,
                  ),
                ).finally(() => setSaving(false));
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Use for Transcription
            </OctantButton>
          )}
        </p>
      )}
      {speech === undefined ? null : (
        <p className="voice-tip__row">
          <span>
            {speech} can read replies aloud. It needs a voice id from the provider, which you give
            in Voice settings.
          </span>
          <OctantButton
            disabled={props.disabled === true}
            onClick={props.links.onOpenVoice}
            size="sm"
            type="button"
            variant="ghost"
          >
            Open Voice settings
          </OctantButton>
        </p>
      )}
    </div>
  );
}
