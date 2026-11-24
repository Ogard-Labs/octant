import type { ProviderInstanceId, VideoGenerationSettings } from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import { isVideoProfileDriverKind } from "@octant/domain";
import type { ReactNode } from "react";
import { ProviderCreateForm } from "../providers/ProviderSettingsConfiguration";
import type { ProviderController } from "../providers/useProviderController";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { MediaProviderSettings } from "./ImageGenerationSettingsView";
import { SettingRow, SettingsSection } from "./primitives";

export interface VideoGenerationSettingsViewProps {
  readonly settings: VideoGenerationSettings;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly providerController?: ProviderController;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
}

/**
 * Video settings: the video providers, and which one a thread at Full access
 * uses when several are on, exactly as for images. Clips are billed by the
 * provider; the price shows on each card before anything is made.
 */
export function VideoGenerationSettingsView(props: VideoGenerationSettingsViewProps) {
  const ready = (props.providerSnapshot?.instances ?? []).filter(
    (instance) => instance.enabled && isVideoProfileDriverKind(instance.driverKind),
  );
  const firstReady = ready[0]?.displayName;
  return (
    <section
      aria-label="Video generation"
      className="image-generation-settings"
      id="settings-video-generation"
    >
      {props.providerController === undefined ? null : (
        <MediaProviderSettings
          controller={props.providerController}
          createForm={<VideoProviderCreateForm controller={props.providerController} />}
          heading="Video providers"
          includes={isVideoProfileDriverKind}
          note="Connect a video API and choose its models. An agent asks on a card, with the price, before it makes a clip."
        />
      )}
      {ready.length < 2 ? null : (
        <SettingsSection title="At Full access">
          <div className="setgroup">
            <SettingRow
              description={`When a thread at Full access makes a clip and its Project keeps no choice, it uses this profile's first model instead of asking. First ready profile is ${firstReady ?? "the first one listed"} now. Below Full access the thread still asks.`}
              label="Video profile at Full access"
              scope="host"
              settingId="video-profile-full-access"
            >
              <OctantSelectField
                aria-label="Video profile at Full access"
                className="settings-view__select window-no-drag"
                onValueChange={(value) => {
                  const { defaultProfileInstanceId: _previous, ...rest } = props.settings;
                  props.onSettingsChange({
                    videoGeneration:
                      value === ""
                        ? rest
                        : { ...rest, defaultProfileInstanceId: value as ProviderInstanceId },
                  });
                }}
                options={[
                  { id: "", label: "First ready profile" },
                  ...ready.map((instance) => ({
                    id: String(instance.id),
                    label: instance.displayName,
                  })),
                ]}
                value={
                  ready.some(
                    (instance) =>
                      String(instance.id) === String(props.settings.defaultProfileInstanceId),
                  )
                    ? String(props.settings.defaultProfileInstanceId)
                    : ""
                }
              />
            </SettingRow>
          </div>
        </SettingsSection>
      )}
    </section>
  );
}

function VideoProviderCreateForm(props: { readonly controller: ProviderController }): ReactNode {
  const controller = props.controller;
  return (
    <ProviderCreateForm
      allowedProviderTypes={["gemini-video"]}
      busy={controller.busy}
      credentialManagementAvailable={controller.credentialManagementAvailable}
      heading="Connect a video provider"
      hint="Use a Gemini API key for Gemini Omni Flash. Keys stay in the host's secure store."
      initialProviderType="gemini-video"
      onCreate={controller.create}
      onCreateAnthropicCompatible={controller.createAnthropicCompatible}
      onCreateAzureFoundry={controller.createAzureFoundry}
      onCreateBflImage={controller.createBflImage}
      onCreateAcpAgent={controller.createAcpAgent}
      onCreateClaude={controller.createClaude}
      onCreateGeminiImage={controller.createGeminiImage}
      onCreateGeminiVideo={controller.createGeminiVideo}
      onCreateIdeogramImage={controller.createIdeogramImage}
      onCreateOllama={controller.createOllama}
      onCreateOpenAiCompatible={controller.createOpenAiCompatible}
      onCreateOpenAiImage={controller.createOpenAiImage}
      triggerLabel="Add video provider"
    />
  );
}
