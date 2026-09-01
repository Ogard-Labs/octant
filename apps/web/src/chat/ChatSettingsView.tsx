import type { ChatCommand, ChatSettings } from "@octant/contracts/chat";
import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderRegistrySnapshot,
} from "@octant/contracts/providers";
import { buildModelPickerGroups } from "@octant/domain";
import { useMemo, useState } from "react";
import { ModelPicker } from "../providers/ModelPicker";
import { SettingRow } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export type UpdateChatSettingsCommand = Extract<
  ChatCommand,
  { readonly kind: "update-chat-settings" }
>;

export interface ChatSettingsViewProps {
  readonly settings: ChatSettings;
  readonly providerSnapshot?: ProviderRegistrySnapshot;
  readonly busy?: boolean;
  readonly message?: string;
  readonly onUpdate: (command: UpdateChatSettingsCommand) => Promise<boolean> | boolean;
}

export function ChatSettingsView(props: ChatSettingsViewProps) {
  const [draft, setDraft] = useState(() => draftFrom(props.settings));
  const [endpointError, setEndpointError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const groups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: props.providerSnapshot?.instances ?? [],
        observedByInstance: new Map(
          (props.providerSnapshot?.observedStates ?? []).map(
            (state) => [state.instanceId, state] as const,
          ),
        ),
        providerOrder: props.providerSnapshot?.defaults.providerOrder,
        mode: "chat",
        currentSelection:
          draft.defaultProviderInstanceId === "" || draft.defaultModelId === ""
            ? undefined
            : {
                providerInstanceId: draft.defaultProviderInstanceId as ProviderInstanceId,
                modelId: draft.defaultModelId as ProviderModelId,
              },
      }),
    [props.providerSnapshot, draft.defaultProviderInstanceId, draft.defaultModelId],
  );
  const selectedProviderInstanceId =
    draft.defaultProviderInstanceId === ""
      ? undefined
      : (draft.defaultProviderInstanceId as ProviderInstanceId);
  const selectedModelId =
    draft.defaultModelId === "" ? undefined : (draft.defaultModelId as ProviderModelId);
  const hasSelection = selectedProviderInstanceId !== undefined && selectedModelId !== undefined;

  const busy = props.busy === true || saving;

  function setEndpoint(value: string) {
    setDraft((current) => ({ ...current, searxngBaseUrl: value }));
    setEndpointError(endpointValidationMessage(value));
  }

  return (
    <section
      aria-labelledby="chat-defaults-heading"
      className="settings-card-section settings-card-section--open chat-settings"
    >
      <h2 id="chat-defaults-heading">Chat defaults</h2>
      <p className="settings-section-note">
        These defaults apply only to new threads. Existing threads keep their explicit values.
      </p>
      {props.message === undefined ? null : (
        <p className="provider-settings__alert" role="alert">
          {props.message}
        </p>
      )}
      <form
        aria-label="Chat defaults"
        className="setgroup"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          const nextEndpointError = endpointValidationMessage(draft.searxngBaseUrl);
          if (nextEndpointError !== undefined) {
            setEndpointError(nextEndpointError);
            return;
          }
          if (!hasSelection) {
            setFormError("Choose a ready provider and model for new Chat threads.");
            return;
          }
          const instructions = draft.defaultPersonalityInstructions.trim();
          if (instructions.length === 0) {
            setFormError("Enter calm personality instructions.");
            return;
          }
          setFormError(undefined);
          const searxngBaseUrl = draft.searxngBaseUrl.trim();
          const command: UpdateChatSettingsCommand = {
            kind: "update-chat-settings",
            expectedVersion: props.settings.version,
            defaultProviderInstanceId: selectedProviderInstanceId,
            defaultModelId: selectedModelId,
            defaultResearchEnabled: draft.defaultResearchEnabled,
            defaultResearchRouting: draft.defaultResearchRouting,
            ...(searxngBaseUrl === "" ? {} : { searxngBaseUrl }),
            defaultPersonalityInstructions: instructions,
            ...(props.settings.providerFallback === undefined
              ? {}
              : { providerFallback: props.settings.providerFallback }),
          };
          setSaving(true);
          try {
            if (!(await props.onUpdate(command))) {
              setFormError("Chat defaults were not saved. Review the values and try again.");
            }
          } catch {
            setFormError("Chat defaults were not saved. Review the values and try again.");
          } finally {
            setSaving(false);
          }
        }}
      >
        <SettingRow
          description="The provider and model a new Chat thread starts with."
          label="Default provider and model"
          scope="host"
          settingId="chat-default-model"
        >
          <ModelPicker
            ariaLabel="Default Chat provider and model"
            groups={groups}
            onSelect={(selection) => {
              setDraft((current) => ({
                ...current,
                defaultProviderInstanceId: String(selection.providerInstanceId),
                defaultModelId: String(selection.modelId),
              }));
              setFormError(undefined);
            }}
            selectedModelId={selectedModelId}
            selectedProviderInstanceId={selectedProviderInstanceId}
          />
        </SettingRow>
        <SettingRow
          description="New Chat threads start with research turned on."
          label="Research by default"
          scope="host"
          settingId="chat-research-enabled"
        >
          <OctantSwitch
            checked={draft.defaultResearchEnabled}
            disabled={busy}
            label="Enable research by default"
            onCheckedChange={(defaultResearchEnabled) => {
              setDraft((current) => ({ ...current, defaultResearchEnabled }));
            }}
          />
        </SettingRow>
        <SettingRow
          description="Where research requests go when a thread does not choose."
          label="Default research backend"
          scope="host"
          settingId="chat-research-backend"
        >
          <OctantSelectField
            aria-label="Default research backend"
            className="settings-view__select window-no-drag"
            disabled={busy}
            onValueChange={(value) => {
              const defaultResearchRouting = value as ChatSettings["defaultResearchRouting"];
              setDraft((current) => ({
                ...current,
                defaultResearchRouting,
              }));
            }}
            options={[
              { id: "automatic", label: "Automatic" },
              { id: "searxng", label: "SearXNG" },
              { id: "provider-native", label: "Provider-native" },
            ]}
            value={draft.defaultResearchRouting}
          />
        </SettingRow>
        <SettingRow
          description="HTTPS, or HTTP on a loopback address."
          label="SearXNG base URL"
          scope="host"
          settingId="chat-searxng-url"
        >
          <OctantInput
            aria-describedby={endpointError === undefined ? undefined : "searxng-base-url-error"}
            aria-invalid={endpointError === undefined ? undefined : true}
            aria-label="SearXNG base URL"
            className="settings-view__text-input"
            disabled={busy}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
            placeholder="https://search.example"
            type="url"
            value={draft.searxngBaseUrl}
          />
        </SettingRow>
        {endpointError === undefined ? null : (
          <p className="provider-settings__alert" id="searxng-base-url-error" role="alert">
            {endpointError}
          </p>
        )}
        <SettingRow
          description="How a new Chat thread carries itself before you say otherwise."
          label="Calm personality instructions"
          scope="host"
          settingId="chat-personality"
        >
          <OctantTextarea
            aria-label="Calm personality instructions"
            className="settings-view__text-input"
            disabled={busy}
            onChange={(event) => {
              const defaultPersonalityInstructions = event.currentTarget.value;
              setDraft((current) => ({
                ...current,
                defaultPersonalityInstructions,
              }));
            }}
            rows={3}
            value={draft.defaultPersonalityInstructions}
          />
        </SettingRow>
        {formError === undefined ? null : (
          <p className="provider-settings__alert" role="alert">
            {formError}
          </p>
        )}
        <SettingRow
          description="Threads created after saving use these defaults."
          label="Save"
          scope="host"
          settingId="chat-save"
        >
          <OctantButton disabled={busy} size="sm" type="submit" variant="secondary">
            {saving ? "Saving Chat defaults…" : "Save Chat defaults"}
          </OctantButton>
        </SettingRow>
      </form>
    </section>
  );
}

function draftFrom(settings: ChatSettings) {
  return {
    defaultProviderInstanceId:
      settings.defaultProviderInstanceId === undefined
        ? ""
        : String(settings.defaultProviderInstanceId),
    defaultModelId: settings.defaultModelId === undefined ? "" : String(settings.defaultModelId),
    defaultResearchEnabled: settings.defaultResearchEnabled,
    defaultResearchRouting: settings.defaultResearchRouting,
    searxngBaseUrl: settings.searxngBaseUrl ?? "",
    defaultPersonalityInstructions: settings.defaultPersonalityInstructions,
  };
}

function endpointValidationMessage(value: string): string | undefined {
  const endpoint = value.trim();
  if (endpoint === "") return undefined;
  try {
    const url = new URL(endpoint);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      endpoint.includes("?") ||
      endpoint.includes("#")
    ) {
      return "Use a base URL without credentials, query, or fragment.";
    }
    if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      return undefined;
    }
  } catch {
    // The same message covers malformed and disallowed endpoints.
  }
  return "Use HTTPS or a loopback HTTP address.";
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}
