import {
  acpAgentProfile,
  type AcpAgentAuthentication,
  type AcpAgentGoogleCloud,
  type AcpAgentKind,
  type AcpAgentProviderInstance,
  type ProviderInstance,
} from "@octant/contracts";
import { useRef, useState, type RefObject } from "react";
import { OctantAlert } from "../../ui/base/OctantAlert";
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
  const profile = acpAgentProfile(kind);
  const named = profile.postureLabels?.[posture];
  if (named !== undefined) return named;
  if (posture === "api-key") return profile.apiKeyLabel ?? "API key";
  if (posture === "agent-platform") return "Agent Platform";
  return "Provider CLI login (recommended)";
}

const AGENT_PLATFORM_GUIDANCE =
  "Uses this computer's Application Default Credentials (gcloud auth application-default login) for the project and location below.";

/** What a card says an ACP agent instance signs in with. */
export function acpAuthenticationFact(instance: AcpAgentProviderInstance): string {
  const profile = acpAgentProfile(instance.driverKind);
  const { authentication, googleCloud } = instance.configuration;
  switch (authentication) {
    case "api-key":
      return profile.apiKeyLabel ?? "API key";
    case "agent-platform":
      return googleCloud === undefined
        ? "Agent Platform"
        : `Agent Platform project ${googleCloud.project} (${googleCloud.location})`;
    case "subscription":
      return `${profile.name} subscription`;
    default:
      return (
        profile.postureLabels?.["provider-owned"] ?? `provider-owned ${profile.name} credentials`
      );
  }
}

/**
 * The Google Cloud project and location a form names for Agent Platform,
 * trimmed; the server checks their shape.
 */
export function googleCloudFromForm(data: FormData): AcpAgentGoogleCloud {
  return {
    project: String(data.get("googleCloudProject") ?? "").trim(),
    location: String(data.get("googleCloudLocation") ?? "").trim(),
  };
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
      {props.authentication === "agent-platform" ? (
        <>
          <p className="provider-settings__field-guidance">{AGENT_PLATFORM_GUIDANCE}</p>
          <label>
            <span>Google Cloud project</span>
            <OctantInput
              aria-label="Google Cloud project"
              className="settings-view__text-input window-no-drag"
              name="googleCloudProject"
              required
              spellCheck={false}
            />
          </label>
          <label>
            <span>Google Cloud location</span>
            <OctantInput
              aria-label="Google Cloud location"
              className="settings-view__text-input window-no-drag"
              name="googleCloudLocation"
              placeholder="us-central1"
              required
              spellCheck={false}
            />
          </label>
        </>
      ) : props.authentication === "api-key" ? (
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
  // The form saves without the browser's own validation, so a missing Cloud
  // project or location is caught here rather than sent and refused.
  const [googleCloudProblem, setGoogleCloudProblem] = useState<
    { readonly field: "project" | "location"; readonly message: string } | undefined
  >(undefined);
  // A profile whose personal sign-in carries limits says so beside the
  // choice itself, whichever sign-in is chosen.
  const personalSignInNote =
    profile.personalSignIn === undefined ? undefined : profile.authenticationNote;
  const authenticationDescription = [
    personalSignInNote,
    authentication === "provider-owned" || authentication === "subscription"
      ? profile.signInGuidance
      : undefined,
  ]
    .filter((sentence) => sentence !== undefined)
    .join(" ");
  return (
    <form
      className={`provider-card__edit provider-card__edit--${kind}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (authentication === "agent-platform") {
          const googleCloud = googleCloudFromForm(data);
          const missing =
            googleCloud.project === ""
              ? "project"
              : googleCloud.location === ""
                ? "location"
                : undefined;
          if (missing !== undefined) {
            setGoogleCloudProblem({
              field: missing,
              message: `Google Cloud ${missing} is required.`,
            });
            event.currentTarget
              .querySelector<HTMLInputElement>(
                `[name="${missing === "project" ? "googleCloudProject" : "googleCloudLocation"}"]`,
              )
              ?.focus();
            return;
          }
        }
        setGoogleCloudProblem(undefined);
        const enteredCredential = transientCredential(credentialInput.current);
        void props.onChange(
          props.instance.id,
          {
            kind: props.instance.configuration.kind,
            binaryPath: String(data.get("binaryPath") ?? ""),
            ...(authentication === undefined ? {} : { authentication }),
            ...(authentication === "agent-platform"
              ? { googleCloud: googleCloudFromForm(data) }
              : {}),
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
          {...(authenticationDescription === "" ? {} : { description: authenticationDescription })}
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
              setGoogleCloudProblem(undefined);
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
      {authentication === "agent-platform" ? (
        <>
          <SettingRow
            description={AGENT_PLATFORM_GUIDANCE}
            htmlFor={`provider-${props.instance.id}-google-cloud-project-control`}
            label="Google Cloud project"
            scope="host"
            settingId={`provider-${props.instance.id}-google-cloud-project`}
          >
            <OctantInput
              aria-invalid={googleCloudProblem?.field === "project" ? true : undefined}
              aria-label={`Google Cloud project for ${props.instance.displayName}`}
              className="settings-view__text-input"
              defaultValue={props.instance.configuration.googleCloud?.project ?? ""}
              id={`provider-${props.instance.id}-google-cloud-project-control`}
              name="googleCloudProject"
              required
              spellCheck={false}
            />
          </SettingRow>
          <SettingRow
            htmlFor={`provider-${props.instance.id}-google-cloud-location-control`}
            label="Google Cloud location"
            scope="host"
            settingId={`provider-${props.instance.id}-google-cloud-location`}
          >
            <OctantInput
              aria-invalid={googleCloudProblem?.field === "location" ? true : undefined}
              aria-label={`Google Cloud location for ${props.instance.displayName}`}
              className="settings-view__text-input"
              defaultValue={props.instance.configuration.googleCloud?.location ?? ""}
              id={`provider-${props.instance.id}-google-cloud-location-control`}
              name="googleCloudLocation"
              placeholder="us-central1"
              required
              spellCheck={false}
            />
          </SettingRow>
        </>
      ) : null}
      {authentication === "api-key" ? (
        <SettingRow
          {...(profile.authenticationNote === undefined || personalSignInNote !== undefined
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
      {authentication === "agent-platform" && googleCloudProblem !== undefined ? (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {googleCloudProblem.message}
        </OctantAlert>
      ) : null}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="secondary"
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
          variant="secondary"
          size="sm"
          aria-label={`Save Ollama settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
    </form>
  );
}
