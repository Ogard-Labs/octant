import {
  BFL_IMAGE_MODEL_PRESETS,
  GEMINI_IMAGE_MODEL_PRESETS,
  IDEOGRAM_IMAGE_MODEL_PRESETS,
  OPENAI_IMAGE_MODEL_PRESETS,
  type ProviderInstance,
} from "@octant/contracts";
import { useRef, type ReactNode, type RefObject } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { SettingRow } from "../../settings/primitives";
import {
  transientCredential,
  type CredentialStatusController,
} from "../ProviderSettingsCredentials";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";
import {
  openAiImageConfigurationFrom,
  geminiImageConfigurationFrom,
  bflImageConfigurationFrom,
  ideogramImageConfigurationFrom,
} from "./configurationValues";

function ProviderField(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label: string;
  readonly settingId?: string | undefined;
}) {
  if (props.settingId === undefined) {
    return (
      <label className={props.className}>
        <span>{props.label}</span>
        {props.children}
      </label>
    );
  }
  return (
    <SettingRow label={props.label} scope="host" settingId={props.settingId}>
      {props.children}
    </SettingRow>
  );
}

export function OpenAiImageFields(props: {
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly instance?: Extract<ProviderInstance, { driverKind: "openai-image" }>;
}) {
  const configuration = props.instance?.configuration;
  const settingId = (field: string) =>
    props.instance === undefined ? undefined : `provider-${props.instance.id}-${field}`;
  return (
    <>
      <ProviderField
        className="provider-settings__models-field"
        label="Model allowlist"
        settingId={settingId("model-allowlist")}
      >
        <OctantTextarea
          aria-label={
            props.instance === undefined
              ? "Model allowlist"
              : `Model allowlist for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.modelAllowlist.join(", ")}
          name="modelAllowlist"
          placeholder={OPENAI_IMAGE_MODEL_PRESETS.join(", ")}
          required
          rows={2}
        />
      </ProviderField>
      <ProviderField label="Default model" settingId={settingId("default-model")}>
        <OctantInput
          aria-label={
            props.instance === undefined
              ? "Default model"
              : `Default model for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.defaultModel}
          name="defaultModel"
          placeholder="gpt-image-2"
          required
        />
      </ProviderField>
      <ProviderField label="Quality" settingId={settingId("quality")}>
        <OctantSelectField
          aria-label={
            props.instance === undefined ? "Quality" : `Quality for ${props.instance.displayName}`
          }
          className="settings-view__select window-no-drag"
          defaultValue={configuration?.quality ?? ""}
          name="quality"
          options={[
            { id: "", label: "Provider default" },
            { id: "auto", label: "auto" },
            { id: "low", label: "low" },
            { id: "medium", label: "medium" },
            { id: "high", label: "high" },
          ]}
        />
      </ProviderField>
      <ProviderField label="Size" settingId={settingId("size")}>
        <OctantSelectField
          aria-label={
            props.instance === undefined ? "Size" : `Size for ${props.instance.displayName}`
          }
          className="settings-view__select window-no-drag"
          defaultValue={configuration?.size ?? ""}
          name="size"
          options={[
            { id: "", label: "Provider default" },
            { id: "auto", label: "auto" },
            { id: "1024x1024", label: "1024x1024" },
            { id: "1536x1024", label: "1536x1024" },
            { id: "1024x1536", label: "1024x1536" },
          ]}
        />
      </ProviderField>
      <ProviderField
        label={props.instance === undefined ? "API key" : "API key (leave blank to preserve)"}
        settingId={settingId("api-key")}
      >
        <OctantInput
          aria-label={
            props.instance === undefined ? "API key" : `API key for ${props.instance.displayName}`
          }
          autoComplete="new-password"
          className="settings-view__text-input window-no-drag"
          disabled={!props.credentialManagementAvailable}
          name="credential"
          ref={props.credentialInput}
          spellCheck={false}
          type="password"
        />
      </ProviderField>
      <p className="provider-settings__field-guidance">
        Suggested models are data, not a catalog Octant maintains:{" "}
        {OPENAI_IMAGE_MODEL_PRESETS.join(", ")}. Enter any model IDs. GPT Image models require
        OpenAI Organization Verification. The API key is stored write-only in Keychain. This profile
        has no editable base URL.
      </p>
      {!props.credentialManagementAvailable ? (
        <p className="provider-settings__field-guidance">
          Manage credentials in the Octant host app. Credential changes are unavailable in this
          browser.
        </p>
      ) : null}
    </>
  );
}

export function GeminiImageFields(props: {
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly instance?: Extract<ProviderInstance, { driverKind: "gemini-native-image" }>;
}) {
  const configuration = props.instance?.configuration;
  const settingId = (field: string) =>
    props.instance === undefined ? undefined : `provider-${props.instance.id}-${field}`;
  return (
    <>
      <ProviderField
        className="provider-settings__models-field"
        label="Model allowlist"
        settingId={settingId("model-allowlist")}
      >
        <OctantTextarea
          aria-label={
            props.instance === undefined
              ? "Model allowlist"
              : `Model allowlist for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.modelAllowlist.join(", ")}
          name="modelAllowlist"
          placeholder={GEMINI_IMAGE_MODEL_PRESETS.join(", ")}
          required
          rows={2}
        />
      </ProviderField>
      <ProviderField label="Default model" settingId={settingId("default-model")}>
        <OctantInput
          aria-label={
            props.instance === undefined
              ? "Default model"
              : `Default model for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.defaultModel}
          name="defaultModel"
          placeholder="gemini-3.1-flash-image"
          required
        />
      </ProviderField>
      <ProviderField label="Aspect ratio" settingId={settingId("aspect-ratio")}>
        <OctantSelectField
          aria-label={
            props.instance === undefined
              ? "Aspect ratio"
              : `Aspect ratio for ${props.instance.displayName}`
          }
          className="settings-view__select window-no-drag"
          defaultValue={configuration?.aspectRatio ?? ""}
          name="aspectRatio"
          options={[
            { id: "", label: "Provider default" },
            { id: "1:1", label: "1:1" },
            { id: "2:3", label: "2:3" },
            { id: "3:2", label: "3:2" },
            { id: "3:4", label: "3:4" },
            { id: "4:3", label: "4:3" },
            { id: "4:5", label: "4:5" },
            { id: "5:4", label: "5:4" },
            { id: "9:16", label: "9:16" },
            { id: "16:9", label: "16:9" },
            { id: "21:9", label: "21:9" },
          ]}
        />
      </ProviderField>
      <ProviderField label="Resolution" settingId={settingId("resolution")}>
        <OctantSelectField
          aria-label={
            props.instance === undefined
              ? "Resolution"
              : `Resolution for ${props.instance.displayName}`
          }
          className="settings-view__select window-no-drag"
          defaultValue={configuration?.resolution ?? ""}
          name="resolution"
          options={[
            { id: "", label: "Provider default" },
            { id: "1K", label: "1K" },
            { id: "2K", label: "2K" },
            { id: "4K", label: "4K" },
          ]}
        />
      </ProviderField>
      <ProviderField
        label={props.instance === undefined ? "API key" : "API key (leave blank to preserve)"}
        settingId={settingId("api-key")}
      >
        <OctantInput
          aria-label={
            props.instance === undefined ? "API key" : `API key for ${props.instance.displayName}`
          }
          autoComplete="new-password"
          className="settings-view__text-input window-no-drag"
          disabled={!props.credentialManagementAvailable}
          name="credential"
          ref={props.credentialInput}
          spellCheck={false}
          type="password"
        />
      </ProviderField>
      <p className="provider-settings__field-guidance">
        Suggested models are data, not a catalog Octant maintains:{" "}
        {GEMINI_IMAGE_MODEL_PRESETS.join(", ")}. Enter any model IDs. gemini-2.5-flash-image is a
        legacy suggestion. The API key is stored write-only in Keychain. This profile has no
        editable base URL.
      </p>
      {!props.credentialManagementAvailable ? (
        <p className="provider-settings__field-guidance">
          Manage credentials in the Octant host app. Credential changes are unavailable in this
          browser.
        </p>
      ) : null}
    </>
  );
}

export function BflImageFields(props: {
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly instance?: Extract<ProviderInstance, { driverKind: "bfl-image" }>;
}) {
  const configuration = props.instance?.configuration;
  const settingId = (field: string) =>
    props.instance === undefined ? undefined : `provider-${props.instance.id}-${field}`;
  return (
    <>
      <ProviderField
        className="provider-settings__models-field"
        label="Model allowlist"
        settingId={settingId("model-allowlist")}
      >
        <OctantTextarea
          aria-label={
            props.instance === undefined
              ? "Model allowlist"
              : `Model allowlist for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.modelAllowlist.join(", ")}
          name="modelAllowlist"
          placeholder={BFL_IMAGE_MODEL_PRESETS.join(", ")}
          required
          rows={2}
        />
      </ProviderField>
      <ProviderField label="Default model" settingId={settingId("default-model")}>
        <OctantInput
          aria-label={
            props.instance === undefined
              ? "Default model"
              : `Default model for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.defaultModel}
          name="defaultModel"
          placeholder="flux-pro-1.1"
          required
        />
      </ProviderField>
      <ProviderField
        label={props.instance === undefined ? "API key" : "API key (leave blank to preserve)"}
        settingId={settingId("api-key")}
      >
        <OctantInput
          aria-label={
            props.instance === undefined ? "API key" : `API key for ${props.instance.displayName}`
          }
          autoComplete="new-password"
          className="settings-view__text-input window-no-drag"
          disabled={!props.credentialManagementAvailable}
          name="credential"
          ref={props.credentialInput}
          spellCheck={false}
          type="password"
        />
      </ProviderField>
      <p className="provider-settings__field-guidance">
        Suggested models are data, not a catalog Octant maintains:{" "}
        {BFL_IMAGE_MODEL_PRESETS.join(", ")}. Enter any model IDs. The API key is stored write-only
        in Keychain. This profile has no editable base URL, quality, or size — Black Forest Labs
        generates one image per request with its own defaults.
      </p>
      {!props.credentialManagementAvailable ? (
        <p className="provider-settings__field-guidance">
          Manage credentials in the Octant host app. Credential changes are unavailable in this
          browser.
        </p>
      ) : null}
    </>
  );
}

export function IdeogramImageFields(props: {
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly instance?: Extract<ProviderInstance, { driverKind: "ideogram-image" }>;
}) {
  const configuration = props.instance?.configuration;
  const settingId = (field: string) =>
    props.instance === undefined ? undefined : `provider-${props.instance.id}-${field}`;
  return (
    <>
      <ProviderField
        className="provider-settings__models-field"
        label="Model allowlist"
        settingId={settingId("model-allowlist")}
      >
        <OctantTextarea
          aria-label={
            props.instance === undefined
              ? "Model allowlist"
              : `Model allowlist for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.modelAllowlist.join(", ")}
          name="modelAllowlist"
          placeholder={IDEOGRAM_IMAGE_MODEL_PRESETS.join(", ")}
          required
          rows={2}
        />
      </ProviderField>
      <ProviderField label="Default model" settingId={settingId("default-model")}>
        <OctantInput
          aria-label={
            props.instance === undefined
              ? "Default model"
              : `Default model for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.defaultModel}
          name="defaultModel"
          placeholder="ideogram-v3"
          required
        />
      </ProviderField>
      <ProviderField
        label={props.instance === undefined ? "API key" : "API key (leave blank to preserve)"}
        settingId={settingId("api-key")}
      >
        <OctantInput
          aria-label={
            props.instance === undefined ? "API key" : `API key for ${props.instance.displayName}`
          }
          autoComplete="new-password"
          className="settings-view__text-input window-no-drag"
          disabled={!props.credentialManagementAvailable}
          name="credential"
          ref={props.credentialInput}
          spellCheck={false}
          type="password"
        />
      </ProviderField>
      <p className="provider-settings__field-guidance">
        Suggested models are data, not a catalog Octant maintains:{" "}
        {IDEOGRAM_IMAGE_MODEL_PRESETS.join(", ")}. Enter any model IDs. The API key is stored
        write-only in Keychain. This profile has no editable base URL, rendering speed, or aspect
        ratio — Ideogram generates images with its own defaults.
      </p>
      {!props.credentialManagementAvailable ? (
        <p className="provider-settings__field-guidance">
          Manage credentials in the Octant host app. Credential changes are unavailable in this
          browser.
        </p>
      ) : null}
    </>
  );
}

interface OpenAiImageConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "openai-image" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeOpenAiImageConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

export function OpenAiImageConfigurationForm(props: OpenAiImageConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--image"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = openAiImageConfigurationFrom(new FormData(event.currentTarget));
        const enteredCredential = transientCredential(credentialInput.current);
        const generation =
          enteredCredential.value.length > 0 ? props.credential.beginMutation() : undefined;
        void props.onChange(props.instance.id, configuration, enteredCredential).then(
          (updated) => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, updated, "stored");
          },
          () => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, false, "stored");
          },
        );
      }}
    >
      <OpenAiImageFields
        credentialInput={credentialInput}
        credentialManagementAvailable={props.credentialManagementAvailable}
        instance={props.instance}
      />
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save OpenAI image settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
        {props.credentialManagementAvailable ? (
          <OctantButton
            disabled={props.disabled || props.credential.status !== "stored"}
            onClick={() => {
              const generation = props.credential.beginMutation();
              void props.onClearCredential(props.instance.id).then(
                (cleared) => {
                  props.credential.finishMutation(generation, cleared, "missing");
                },
                () => props.credential.finishMutation(generation, false, "missing"),
              );
            }}
            type="button"
            variant="destructive"
          >
            Clear stored API key for {props.instance.displayName}
          </OctantButton>
        ) : null}
      </div>
    </form>
  );
}

interface GeminiImageConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "gemini-native-image" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeGeminiImageConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

export function GeminiImageConfigurationForm(props: GeminiImageConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--image"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = geminiImageConfigurationFrom(new FormData(event.currentTarget));
        const enteredCredential = transientCredential(credentialInput.current);
        const generation =
          enteredCredential.value.length > 0 ? props.credential.beginMutation() : undefined;
        void props.onChange(props.instance.id, configuration, enteredCredential).then(
          (updated) => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, updated, "stored");
          },
          () => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, false, "stored");
          },
        );
      }}
    >
      <GeminiImageFields
        credentialInput={credentialInput}
        credentialManagementAvailable={props.credentialManagementAvailable}
        instance={props.instance}
      />
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Gemini image settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
        {props.credentialManagementAvailable ? (
          <OctantButton
            disabled={props.disabled || props.credential.status !== "stored"}
            onClick={() => {
              const generation = props.credential.beginMutation();
              void props.onClearCredential(props.instance.id).then(
                (cleared) => {
                  props.credential.finishMutation(generation, cleared, "missing");
                },
                () => props.credential.finishMutation(generation, false, "missing"),
              );
            }}
            type="button"
            variant="destructive"
          >
            Clear stored API key for {props.instance.displayName}
          </OctantButton>
        ) : null}
      </div>
    </form>
  );
}

interface BflImageConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "bfl-image" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeBflImageConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

export function BflImageConfigurationForm(props: BflImageConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--image"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = bflImageConfigurationFrom(new FormData(event.currentTarget));
        const enteredCredential = transientCredential(credentialInput.current);
        const generation =
          enteredCredential.value.length > 0 ? props.credential.beginMutation() : undefined;
        void props.onChange(props.instance.id, configuration, enteredCredential).then(
          (updated) => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, updated, "stored");
          },
          () => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, false, "stored");
          },
        );
      }}
    >
      <BflImageFields
        credentialInput={credentialInput}
        credentialManagementAvailable={props.credentialManagementAvailable}
        instance={props.instance}
      />
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Black Forest Labs image settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
        {props.credentialManagementAvailable ? (
          <OctantButton
            disabled={props.disabled || props.credential.status !== "stored"}
            onClick={() => {
              const generation = props.credential.beginMutation();
              void props.onClearCredential(props.instance.id).then(
                (cleared) => {
                  props.credential.finishMutation(generation, cleared, "missing");
                },
                () => props.credential.finishMutation(generation, false, "missing"),
              );
            }}
            type="button"
            variant="destructive"
          >
            Clear stored API key for {props.instance.displayName}
          </OctantButton>
        ) : null}
      </div>
    </form>
  );
}

interface IdeogramImageConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "ideogram-image" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeIdeogramImageConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

export function IdeogramImageConfigurationForm(props: IdeogramImageConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--image"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = ideogramImageConfigurationFrom(new FormData(event.currentTarget));
        const enteredCredential = transientCredential(credentialInput.current);
        const generation =
          enteredCredential.value.length > 0 ? props.credential.beginMutation() : undefined;
        void props.onChange(props.instance.id, configuration, enteredCredential).then(
          (updated) => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, updated, "stored");
          },
          () => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, false, "stored");
          },
        );
      }}
    >
      <IdeogramImageFields
        credentialInput={credentialInput}
        credentialManagementAvailable={props.credentialManagementAvailable}
        instance={props.instance}
      />
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Ideogram image settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
        {props.credentialManagementAvailable ? (
          <OctantButton
            disabled={props.disabled || props.credential.status !== "stored"}
            onClick={() => {
              const generation = props.credential.beginMutation();
              void props.onClearCredential(props.instance.id).then(
                (cleared) => {
                  props.credential.finishMutation(generation, cleared, "missing");
                },
                () => props.credential.finishMutation(generation, false, "missing"),
              );
            }}
            type="button"
            variant="destructive"
          >
            Clear stored API key for {props.instance.displayName}
          </OctantButton>
        ) : null}
      </div>
    </form>
  );
}
