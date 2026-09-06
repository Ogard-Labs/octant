import {
  IMAGE_GENERATION_MAX_CUSTOM_SOURCES,
  type ImageGenerationCustomSource,
  type ImageGenerationSettings,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import { listImageSourceEligibleInstances, resolveImageCustomSources } from "@octant/domain";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface ImageGenerationSettingsViewProps {
  readonly settings: ImageGenerationSettings;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
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
  const resolved = resolveImageCustomSources(props.settings.customSources, instances);
  const atLimit = props.settings.customSources.length >= IMAGE_GENERATION_MAX_CUSTOM_SOURCES;

  const apply = (customSources: ReadonlyArray<ImageGenerationCustomSource>) =>
    props.onSettingsChange({ imageGeneration: { customSources } });

  return (
    <section aria-label="Image Generation" id="settings-image-generation">
      <p className="provider-settings__field-guidance">
        For example, a Recraft endpoint works here directly, since its API matches OpenAI&apos;s
        image format.
      </p>
      {eligible.length === 0 ? (
        <p className="provider-settings__hint" role="status">
          Image generation needs an enabled OpenAI-compatible HTTP provider. Add one in Providers
          &amp; Models, then add it here.
        </p>
      ) : null}
      <div className="settings-card-section settings-card-section--open">
        <h2>Custom image sources</h2>
        <div className="setgroup">
          {resolved.length === 0 ? (
            <p className="provider-settings__field-guidance" role="status">
              No custom image sources are configured.
            </p>
          ) : (
            <ul>
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
                    <div className="settings-view__actions">
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
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {atLimit ? (
            <p className="provider-settings__field-guidance" role="status">
              Up to {IMAGE_GENERATION_MAX_CUSTOM_SOURCES} custom image sources are supported. Remove
              one to add another.
            </p>
          ) : (
            <CustomImageSourceForm
              eligible={eligible}
              existing={props.settings.customSources}
              onAdd={(source) => apply([...props.settings.customSources, source])}
            />
          )}
        </div>
      </div>
    </section>
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
