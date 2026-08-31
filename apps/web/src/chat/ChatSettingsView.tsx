import type { ChatCommand, ChatSettings } from "@octant/contracts/chat";
import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderRegistrySnapshot,
} from "@octant/contracts/providers";
import { buildModelPickerGroups } from "@octant/domain";
import { useMemo, useState } from "react";
import { ModelPicker } from "../providers/ModelPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
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
    <section aria-labelledby="chat-defaults-heading" className="provider-settings">
      <div className="provider-settings__intro">
        <div>
          <h2 id="chat-defaults-heading">Chat defaults</h2>
          <p>Choose the defaults Octant uses when you start a new Chat thread.</p>
        </div>
      </div>
      <p className="provider-settings__hint">
        These defaults apply only to new threads. Existing threads keep their explicit values.
      </p>
      {props.message === undefined ? null : (
        <p className="provider-settings__alert" role="alert">
          {props.message}
        </p>
      )}
      <form
        aria-label="Chat defaults"
        className="provider-settings__form setgroup"
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
        <label className="settings-view__field settings-view__field--block">
          <span>Default provider and model</span>
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
        </label>
        <label className="settings-view__toggle">
          <OctantCheckbox
            aria-label="Enable research by default"
            checked={draft.defaultResearchEnabled}
            className="settings-view__checkbox"
            disabled={busy}
            onChange={(event) => {
              const defaultResearchEnabled = event.currentTarget.checked;
              setDraft((current) => ({
                ...current,
                defaultResearchEnabled,
              }));
            }}
          />
          <span>Enable research by default</span>
        </label>
        <label className="settings-view__field">
          <span>Default research backend</span>
          <OctantSelectField
            aria-label="Default research backend"
            className="settings-view__select"
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
        </label>
        <label className="settings-view__field">
          <span>SearXNG base URL</span>
          <OctantInput
            aria-describedby={endpointError === undefined ? undefined : "searxng-base-url-error"}
            aria-invalid={endpointError === undefined ? undefined : true}
            className="settings-view__text-input"
            disabled={busy}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
            placeholder="https://search.example"
            type="url"
            value={draft.searxngBaseUrl}
          />
        </label>
        {endpointError === undefined ? null : (
          <p className="provider-settings__alert" id="searxng-base-url-error" role="alert">
            {endpointError}
          </p>
        )}
        <label className="settings-view__field">
          <span>Calm personality instructions</span>
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
        </label>
        {formError === undefined ? null : (
          <p className="provider-settings__alert" role="alert">
            {formError}
          </p>
        )}
        <OctantButton
          className="settings-view__action"
          disabled={busy}
          type="submit"
          variant="secondary"
        >
          {saving ? "Saving Chat defaults…" : "Save Chat defaults"}
        </OctantButton>
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
