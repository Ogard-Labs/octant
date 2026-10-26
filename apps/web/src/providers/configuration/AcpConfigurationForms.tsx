import {
  acpAgentProfile,
  type AcpAgentAuthentication,
  type AcpAgentKind,
  type AcpAgentProviderInstance,
  type ProviderInstance,
} from "@octant/contracts";
import { useRef, useState, type RefObject } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { SettingRow } from "../../settings/primitives";
import { emptyTransientCredential, transientCredential } from "../ProviderSettingsCredentials";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";

/** The postures Settings lets a person choose for an ACP agent, in profile order. */
export function offeredAcpAuthentication(
  kind: AcpAgentKind,
): ReadonlyArray<AcpAgentAuthentication> {
  const profile = acpAgentProfile(kind);
  return profile.offeredAuthentication ?? profile.authentication;
}

function postureLabel(kind: AcpAgentKind, posture: AcpAgentAuthentication): string {
  return posture === "api-key"
    ? (acpAgentProfile(kind).apiKeyLabel ?? "API key")
    : "Provider CLI login (recommended)";
}

/** What a card says an ACP agent instance signs in with. */
export function acpAuthenticationFact(instance: AcpAgentProviderInstance): string {
  const profile = acpAgentProfile(instance.driverKind);
  switch (instance.configuration.authentication) {
    case "api-key":
      return profile.apiKeyLabel ?? "API key";
    case "subscription":
      return `${profile.name} subscription`;
    default:
      return `provider-owned ${profile.name} credentials`;
  }
}

/**
 * The authentication part of the create form for any ACP agent: a choice when
 * its profile offers more than one posture, the key when the chosen posture is
 * an API key, and how to sign in otherwise.
 */
export function AcpAgentCreateAuthenticationFields(props: {
  readonly kind: AcpAgentKind;
  readonly authentication: AcpAgentAuthentication | undefined;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly onAuthenticationChange: (authentication: AcpAgentAuthentication) => void;
}) {
  const profile = acpAgentProfile(props.kind);
  const offered = offeredAcpAuthentication(props.kind);
  return (
    <>
      {profile.authenticationNote === undefined ? null : (
        <p className="provider-settings__field-guidance">{profile.authenticationNote}</p>
      )}
      {offered.length > 1 && props.authentication !== undefined ? (
        <label>
          <span>Authentication</span>
          <OctantSelectField
            aria-label={`${profile.name} authentication`}
            className="settings-view__select window-no-drag"
            onValueChange={(value) => {
              const next = offered.find((posture) => posture === value);
              if (next === undefined) return;
              if (next !== "api-key" && props.credentialInput.current !== null) {
                props.credentialInput.current.value = "";
              }
              props.onAuthenticationChange(next);
            }}
            options={offered.map((posture) => ({
              id: posture,
              label: postureLabel(props.kind, posture),
            }))}
            value={props.authentication}
          />
        </label>
      ) : null}
      {props.authentication === "api-key" ? (
        <label>
          <span>{postureLabel(props.kind, "api-key")}</span>
          <OctantInput
            aria-label={postureLabel(props.kind, "api-key")}
            autoComplete="new-password"
            className="settings-view__text-input window-no-drag"
            disabled={!props.credentialManagementAvailable}
            name="apiKey"
            ref={props.credentialInput}
            required
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Uses {profile.name}&apos;s own sign-in. {profile.signInGuidance}
        </p>
      )}
    </>
  );
}

/** A Settings card's configuration form for any ACP agent instance. */
export function AcpAgentConfigurationForm(props: {
  readonly instance: AcpAgentProviderInstance;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeAcpAgentConfiguration"];
}) {
  const kind = props.instance.driverKind;
  const profile = acpAgentProfile(kind);
  const offered = offeredAcpAuthentication(kind);
  const credentialInput = useRef<HTMLInputElement>(null);
  const saved = props.instance.configuration.authentication;
  // A saved posture Settings no longer offers (a Mistral Vibe instance
  // discovery registered on its subscription) opens on the first one it does.
  const [authentication, setAuthentication] = useState<AcpAgentAuthentication | undefined>(
    saved !== undefined && offered.includes(saved) ? saved : offered[0],
  );
  const binaryLabel = `${profile.executable} binary path`;
  return (
    <form
      className={`provider-card__edit provider-card__edit--${kind}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const enteredCredential = transientCredential(credentialInput.current);
        void props.onChange(
          props.instance.id,
          {
            kind: props.instance.configuration.kind,
            binaryPath: String(new FormData(event.currentTarget).get("binaryPath") ?? ""),
            ...(authentication === undefined ? {} : { authentication }),
          },
          authentication === "api-key"
            ? enteredCredential
            : emptyTransientCredential(enteredCredential),
        );
      }}
    >
      <SettingRow
        htmlFor={`provider-${props.instance.id}-binary-path-control`}
        label={binaryLabel}
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`${binaryLabel} for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          id={`provider-${props.instance.id}-binary-path-control`}
          name="binaryPath"
          required
        />
      </SettingRow>
      {offered.length > 1 && authentication !== undefined ? (
        <SettingRow
          {...(authentication === "api-key" ? {} : { description: profile.signInGuidance })}
          htmlFor={`provider-${props.instance.id}-authentication-control`}
          label="Authentication"
          scope="host"
          settingId={`provider-${props.instance.id}-authentication`}
        >
          <OctantSelectField
            aria-label={`${profile.name} authentication for ${props.instance.displayName}`}
            className="settings-view__select"
            id={`provider-${props.instance.id}-authentication-control`}
            onValueChange={(value) => {
              const next = offered.find((posture) => posture === value);
              if (next === undefined) return;
              if (next !== "api-key" && credentialInput.current !== null) {
                credentialInput.current.value = "";
              }
              setAuthentication(next);
            }}
            options={offered.map((posture) => ({
              id: posture,
              label: postureLabel(kind, posture),
            }))}
            value={authentication}
          />
        </SettingRow>
      ) : null}
      {authentication === "api-key" ? (
        <SettingRow
          {...(profile.authenticationNote === undefined
            ? {}
            : { description: profile.authenticationNote })}
          htmlFor={`provider-${props.instance.id}-api-key-control`}
          label={`${postureLabel(kind, "api-key")} (leave blank to preserve)`}
          scope="host"
          settingId={`provider-${props.instance.id}-api-key`}
        >
          <OctantInput
            aria-label={`${postureLabel(kind, "api-key")} for ${props.instance.displayName}`}
            autoComplete="new-password"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            id={`provider-${props.instance.id}-api-key-control`}
            name="apiKey"
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </SettingRow>
      ) : null}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save ${profile.name} settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
    </form>
  );
}

export function OllamaConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "ollama" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeOllamaConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void props.onChange(props.instance.id, {
          kind: "ollama-native-http",
          baseUrl: String(new FormData(event.currentTarget).get("baseUrl") ?? ""),
        });
      }}
    >
      <SettingRow
        htmlFor={`provider-${props.instance.id}-base-url-control`}
        description="Literal loopback native API only. Octant never manages the shared Ollama service or its models."
        label="Ollama API base URL"
        scope="host"
        settingId={`provider-${props.instance.id}-base-url`}
      >
        <OctantInput
          aria-label={`Ollama API base for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          id={`provider-${props.instance.id}-base-url-control`}
          name="baseUrl"
          required
          type="url"
        />
      </SettingRow>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Ollama settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
    </form>
  );
}
