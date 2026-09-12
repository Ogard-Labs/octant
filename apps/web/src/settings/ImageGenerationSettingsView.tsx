import {
  IMAGE_GENERATION_MAX_CUSTOM_SOURCES,
  type ImageGenerationCustomSource,
  type ImageGenerationSettings,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import {
  isImageProfileDriverKind,
  listImageSourceEligibleInstances,
  resolveImageCustomSources,
} from "@octant/domain";
import { useState, type ReactNode } from "react";
import type { ProviderController } from "../providers/useProviderController";
import { ProviderCreateForm } from "../providers/ProviderSettingsConfiguration";
import { ProviderSettingsList } from "../providers/ProviderSettingsList";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingRow } from "./primitives";

// Matches ImageGenerationCustomSource.label's Schema.maxLength(120): reject
// here so a too-long label never reaches the replace-settings command that
// would otherwise refuse the whole patch after the form already cleared.
const MAX_LABEL_LENGTH = 120;

export interface ImageGenerationSettingsViewProps {
  readonly settings: ImageGenerationSettings;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly providerController?: ProviderController;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
}

function sourceKey(source: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}): string {
  return `${String(source.providerInstanceId)}:${String(source.modelId)}`;
}

/**
 * Image generation settings section: any number of (provider, model) pairs on
 * an OpenAI-compatible instance that may also generate images
 * (`docs/decisions/0085`). Unlike Voice's two named slots, this is a bounded
 * list — a person may register Recraft for one model and an Azure OpenAI
 * deployment for another, alongside any dedicated OpenAI Image or Gemini
 * Image profile.
 */
export function ImageGenerationSettingsView(props: ImageGenerationSettingsViewProps) {
  const instances = props.providerSnapshot?.instances ?? [];
  const eligible = listImageSourceEligibleInstances(instances);
  const eligibleIds = new Set(eligible.map((instance) => String(instance.id)));
  const hasImageProvider = instances.some(
    (instance) =>
      instance.enabled &&
      (eligibleIds.has(String(instance.id)) || isImageProfileDriverKind(instance.driverKind)),
  );
  const resolved = resolveImageCustomSources(props.settings.customSources, instances);
  const atLimit = props.settings.customSources.length >= IMAGE_GENERATION_MAX_CUSTOM_SOURCES;

  const apply = (customSources: ReadonlyArray<ImageGenerationCustomSource>) =>
    props.onSettingsChange({ imageGeneration: { customSources } });

  const imageProviderSettings =
    props.providerController === undefined ? null : (
      <ImageProviderSettings controller={props.providerController} />
    );

  return (
    <section
      aria-label="Image generation"
      className="image-generation-settings"
      id="settings-image-generation"
    >
      {!hasImageProvider ? (
        <p className="settings-state settings-state--empty" role="status">
          No image providers are enabled. Add a dedicated provider or custom endpoint below.
        </p>
      ) : null}
      {imageProviderSettings}
      <div className="settings-card-section settings-card-section--open">
        <div className="setgroup">
          <SettingRow
            description="Connect an OpenAI-compatible image API's provider and model, such as Recraft, to use as a custom image source."
            label="Custom image sources"
            scope="app"
            settingId="custom-image-sources"
          >
            <p className="provider-settings__field-guidance">
              Saved profiles in Image generator choose defaults for a generation, such as the model,
              size, and quality.
            </p>
            {eligible.length === 0 ? (
              <p className="provider-settings__field-guidance" role="status">
                Add an OpenAI-compatible custom endpoint above, then choose its model here.
              </p>
            ) : null}
            {resolved.length === 0 && eligible.length > 0 ? (
              <p className="provider-settings__field-guidance" role="status">
                No custom image sources are configured.
              </p>
            ) : resolved.length === 0 ? null : (
              <ul className="image-generation-settings__sources">
                {resolved.map((resolution, index) => {
                  const source = props.settings.customSources[index];
                  if (source === undefined) return null;
                  return (
                    <li key={sourceKey(source)}>
                      <p className="provider-settings__field-guidance" role="status">
                        {resolution.status === "ready"
                          ? `"${resolution.label}" runs ${resolution.instance.displayName} with ${String(resolution.modelId)}.`
                          : `"${resolution.label}" is unavailable: ${resolution.reason}`}
                      </p>
                      <OctantButton
                        onClick={() =>
                          apply(
                            props.settings.customSources.filter(
                              (candidate) => sourceKey(candidate) !== sourceKey(source),
                            ),
                          )
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Remove
                      </OctantButton>
                    </li>
                  );
                })}
              </ul>
            )}
            {atLimit ? (
              <p className="provider-settings__field-guidance" role="status">
                Up to {IMAGE_GENERATION_MAX_CUSTOM_SOURCES} custom image sources are supported.
                Remove one to add another.
              </p>
            ) : eligible.length === 0 ? null : (
              <CustomImageSourceForm
                eligible={eligible}
                existing={props.settings.customSources}
                onAdd={(source) => apply([...props.settings.customSources, source])}
              />
            )}
          </SettingRow>
        </div>
      </div>
    </section>
  );
}

function ImageProviderSettings(props: { readonly controller: ProviderController }): ReactNode {
  const controller = props.controller;
  const imageInstances = controller.instances.filter(
    (instance) =>
      isImageProfileDriverKind(instance.driverKind) || instance.driverKind === "openai-compatible",
  );
  return (
    <ProviderSettingsList
      busy={controller.busy}
      createForm={<ImageProviderCreateForm controller={controller} />}
      credentialManagementAvailable={controller.credentialManagementAvailable}
      defaults={controller.defaults}
      discoverySnapshot={undefined}
      heading="Image providers"
      instances={imageInstances}
      note="Connect, configure, and choose models for dedicated image APIs or custom endpoints."
      observedByInstance={controller.observedByInstance}
      onAgentEligibleModelsChange={controller.updateAgentEligibleModels}
      onBeginProviderAuthentication={controller.beginProviderAuthentication}
      onChangeAnthropicCompatibleConfiguration={controller.changeAnthropicCompatibleConfiguration}
      onChangeAzureFoundryConfiguration={controller.changeAzureFoundryConfiguration}
      onChangeBflImageConfiguration={controller.changeBflImageConfiguration}
      onChangeBinary={controller.changeBinary}
      onChangeClaudeConfiguration={controller.changeClaudeConfiguration}
      onChangeClineConfiguration={controller.changeClineConfiguration}
      onChangeCopilotConfiguration={controller.changeCopilotConfiguration}
      onChangeDevinConfiguration={controller.changeDevinConfiguration}
      onChangeGeminiConfiguration={controller.changeGeminiConfiguration}
      onChangeGeminiImageConfiguration={controller.changeGeminiImageConfiguration}
      onChangeGlmConfiguration={controller.changeGlmConfiguration}
      onChangeGooseConfiguration={controller.changeGooseConfiguration}
      onChangeGrokConfiguration={controller.changeGrokConfiguration}
      onChangeIdeogramImageConfiguration={controller.changeIdeogramImageConfiguration}
      onChangeKiloConfiguration={controller.changeKiloConfiguration}
      onChangeMistralVibeConfiguration={controller.changeMistralVibeConfiguration}
      onChangeOhMyPiConfiguration={controller.changeOhMyPiConfiguration}
      onChangeOllamaConfiguration={controller.changeOllamaConfiguration}
      onChangeOpenAiCompatibleConfiguration={controller.changeOpenAiCompatibleConfiguration}
      onChangeOpenAiImageConfiguration={controller.changeOpenAiImageConfiguration}
      onChangePiConfiguration={controller.changePiConfiguration}
      onChangeQwenConfiguration={controller.changeQwenConfiguration}
      onClearProviderCredential={controller.clearProviderCredential}
      onCompleteProviderAuthentication={controller.completeProviderAuthentication}
      onHiddenModelsChange={controller.updateHiddenModels}
      onProbe={controller.probe}
      onProviderCredentialStatus={controller.providerCredentialStatus}
      onProviderOrderChange={controller.updateProviderOrder}
      onRemove={controller.remove}
      onRename={controller.rename}
      onSetEnabled={controller.setEnabled}
      onVerifyFoundryTools={controller.verifyFoundryTools}
      presentationObservedByInstance={controller.presentationObservedByInstance}
      probingIds={controller.probingIds}
      showAgentEligibleModels={false}
      showReorder={false}
      status={controller.status}
    />
  );
}

function ImageProviderCreateForm(props: { readonly controller: ProviderController }): ReactNode {
  const controller = props.controller;
  return (
    <ProviderCreateForm
      allowedProviderTypes={[
        "openai-image",
        "gemini-native-image",
        "bfl-image",
        "ideogram-image",
        "openai-compatible",
      ]}
      busy={controller.busy}
      credentialManagementAvailable={controller.credentialManagementAvailable}
      heading="Connect an image provider"
      hint="Use an OpenAI, Gemini, Black Forest Labs, or Ideogram image API. Credentials stay in the host's secure store."
      initialProviderType="openai-image"
      onCreate={controller.create}
      onCreateAnthropicCompatible={controller.createAnthropicCompatible}
      onCreateAzureFoundry={controller.createAzureFoundry}
      onCreateBflImage={controller.createBflImage}
      onCreateClaude={controller.createClaude}
      onCreateGemini={controller.createGemini}
      onCreateGeminiImage={controller.createGeminiImage}
      onCreateGrok={controller.createGrok}
      onCreateGlm={controller.createGlm}
      onCreateCline={controller.createCline}
      onCreateIdeogramImage={controller.createIdeogramImage}
      onCreateMistralVibe={controller.createMistralVibe}
      onCreateOllama={controller.createOllama}
      onCreateOpenAiCompatible={controller.createOpenAiCompatible}
      onCreateOpenAiImage={controller.createOpenAiImage}
      onCreateQwen={controller.createQwen}
      triggerLabel="Add image provider"
    />
  );
}

function CustomImageSourceForm(props: {
  readonly eligible: ReadonlyArray<ProviderRegistrySnapshot["instances"][number]>;
  readonly existing: ReadonlyArray<ImageGenerationCustomSource>;
  readonly onAdd: (source: ImageGenerationCustomSource) => void;
}) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const options = props.eligible.map((instance) => ({
    id: String(instance.id),
    label: instance.displayName,
  }));
  const canAdd = options.length > 0;

  return (
    <form
      aria-label="Add image source"
      className="voice-settings__form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const label = String(data.get("label") ?? "").trim();
        const providerInstanceId = String(data.get("providerInstanceId") ?? "").trim();
        const modelId = String(data.get("modelId") ?? "").trim();
        if (label.length === 0) {
          setProblem("Enter a label.");
          return;
        }
        if (label.length > MAX_LABEL_LENGTH) {
          setProblem(`The label must be ${MAX_LABEL_LENGTH} characters or fewer.`);
          return;
        }
        if (providerInstanceId.length === 0) {
          setProblem("Choose a provider.");
          return;
        }
        if (modelId.length === 0) {
          setProblem("Enter a model ID.");
          return;
        }
        const isDuplicate = props.existing.some(
          (source) =>
            String(source.providerInstanceId) === providerInstanceId &&
            String(source.modelId) === modelId,
        );
        if (isDuplicate) {
          setProblem("This provider and model is already a custom image source.");
          return;
        }
        setProblem(undefined);
        props.onAdd({
          providerInstanceId: providerInstanceId as ProviderInstanceId,
          modelId: modelId as ProviderModelId,
          label,
        });
        event.currentTarget.reset();
      }}
    >
      <label>
        <span>Label</span>
        <OctantInput
          aria-label="Image source label"
          className="settings-view__text-input window-no-drag"
          maxLength={MAX_LABEL_LENGTH}
          name="label"
          placeholder="Recraft"
          spellCheck={false}
        />
      </label>
      <label>
        <span>Provider</span>
        <OctantSelectField
          aria-label="Image source provider"
          className="settings-view__select window-no-drag"
          defaultValue={options[0]?.id ?? ""}
          disabled={!canAdd}
          name="providerInstanceId"
          options={canAdd ? options : [{ id: "", label: "No eligible provider" }]}
        />
      </label>
      <label>
        <span>Model</span>
        <OctantInput
          aria-label="Image source model"
          className="settings-view__text-input window-no-drag"
          name="modelId"
          placeholder="any model id the endpoint accepts"
          spellCheck={false}
        />
      </label>
      {problem === undefined ? null : (
        <p className="provider-settings__field-guidance" role="alert">
          {problem}
        </p>
      )}
      <div className="settings-view__actions">
        <OctantButton disabled={!canAdd} size="sm" type="submit" variant="secondary">
          Add image source
        </OctantButton>
      </div>
    </form>
  );
}
