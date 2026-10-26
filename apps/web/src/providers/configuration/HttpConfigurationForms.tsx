import {
  type DirectoryIssuerBinding,
  type OpenAiCompatibleProviderConfiguration,
  type AnthropicCompatibleProviderConfiguration,
  type ProviderInstance,
  type ProviderInstanceId,
} from "@octant/contracts";
import {
  AZURE_FOUNDRY_DIRECTORY_SIGN_IN,
  GATEWAY_DIRECTORY_SIGN_IN,
  normalizeOpenAiCompatibleBaseUrl,
  subscriptionDescriptorIdOf,
  subscriptionOAuthOffers,
} from "@octant/domain";
import type { SubscriptionOAuthOffer } from "@octant/contracts/host-oauth";
import { useRef, useState } from "react";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { SettingRow } from "../../settings/primitives";
import {
  emptyTransientCredential,
  HttpCredentialFields,
  transientCredential,
  type CredentialStatusController,
} from "../ProviderSettingsCredentials";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";
import {
  ProviderOAuthSignInPanel,
  type ProviderOAuthCommand,
  type ProviderOAuthSignInState,
} from "../ProviderOAuthSignIn";
import {
  configurationFrom,
  anthropicConfigurationFrom,
  foundryConfigurationFrom,
  gatewayDirectoryFrom,
  isDirectoryGuid,
  isGatewayDirectory,
} from "./configurationValues";

interface HttpConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "openai-compatible" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeOpenAiCompatibleConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
  readonly onProviderOAuth?: (
    command: ProviderOAuthCommand,
  ) => Promise<import("../ProviderOAuthSignIn").ProviderOAuthCommandResult | undefined>;
  readonly onOpenExternalUrl?: (url: string) => void;
}

export function HttpConfigurationForm(props: HttpConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  // An endpoint created by a subscription sign-in keeps the endpoint its offer
  // names and holds that sign-in instead of a key: the row shows the sign-in,
  // so the form keeps the fixed values without offering to change them.
  const subscription = boundSubscriptionOffer(props.instance);
  const saved = props.instance.configuration;
  const directory = saved.authentication === "directory-oauth" ? saved.directory : undefined;
  return (
    <form
      className="provider-card__edit provider-card__edit--http"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (directory !== undefined && !isGatewayDirectory(gatewayDirectoryFrom(data))) {
          setProblem(GATEWAY_DIRECTORY_PROBLEM);
          return;
        }
        setProblem(undefined);
        const formed = configurationFrom(data);
        const configuration: OpenAiCompatibleProviderConfiguration =
          saved.authentication === "directory-oauth" || formed.authentication === "directory-oauth"
            ? formed
            : {
                ...formed,
                ...(subscription === undefined
                  ? {}
                  : { baseUrl: saved.baseUrl, authentication: saved.authentication }),
                ...(saved.oauthDescriptorId === undefined
                  ? {}
                  : { oauthDescriptorId: saved.oauthDescriptorId }),
              };
        const enteredCredential = transientCredential(credentialInput.current);
        const key =
          configuration.authentication === "bearer"
            ? enteredCredential
            : emptyTransientCredential(enteredCredential);
        const generation =
          configuration.authentication === "bearer" && key.value.length > 0
            ? props.credential.beginMutation()
            : undefined;
        void props.onChange(props.instance.id, configuration, key).then(
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
      {saved.authentication === "directory-oauth" ? (
        <>
          <BaseUrlField
            ariaLabel={`API base URL for ${props.instance.displayName}`}
            instanceId={props.instance.id}
            label="API base URL"
            savedBaseUrl={saved.baseUrl}
            takesKey={false}
          />
          <GatewayDirectoryFields
            directory={saved.directory}
            instanceId={props.instance.id}
            instanceName={props.instance.displayName}
          />
        </>
      ) : subscription === undefined ? (
        <>
          <BaseUrlField
            ariaLabel={`API base URL for ${props.instance.displayName}`}
            instanceId={props.instance.id}
            label="API base URL"
            savedBaseUrl={saved.baseUrl}
            takesKey={saved.authentication !== "none"}
          />
          <HttpCredentialFields
            authentication={saved.authentication}
            authenticationLabel={`Authentication for ${props.instance.displayName}`}
            credentialInput={credentialInput}
            credentialLabel={`API key for ${props.instance.displayName}`}
            credentialManagementAvailable={props.credentialManagementAvailable}
          />
          <DirectEndpointSignIn
            baseUrl={props.instance.configuration.baseUrl}
            disabled={props.disabled}
            driverKind="openai-compatible"
            instanceId={props.instance.id}
            {...(props.onProviderOAuth === undefined
              ? {}
              : { onProviderOAuth: props.onProviderOAuth })}
            {...(props.onOpenExternalUrl === undefined
              ? {}
              : { onOpenExternalUrl: props.onOpenExternalUrl })}
            onUseApiKey={() => credentialInput.current?.focus()}
          />
        </>
      ) : (
        <>
          <p className="provider-settings__field-guidance">
            Uses your {subscription.accountLabel} sign-in at{" "}
            <span className="oct-meta--mono">{props.instance.configuration.baseUrl}</span>. The
            endpoint is fixed for this sign-in.
          </p>
        </>
      )}
      <SettingRow
        label="Protocol preference"
        scope="host"
        settingId={`provider-${props.instance.id}-protocol`}
      >
        <OctantSelectField
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
          options={[
            { id: "auto", label: "Automatic" },
            { id: "responses", label: "Responses" },
            { id: "chat-completions", label: "Chat Completions" },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Manual model IDs"
        scope="host"
        settingId={`provider-${props.instance.id}-manual-model-ids`}
      >
        <OctantTextarea
          aria-label={`Manual model IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </SettingRow>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        {directory === undefined ? KEYED_GUIDANCE : GATEWAY_DIRECTORY_GUIDANCE}
      </p>
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save HTTP settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
        {props.credentialManagementAvailable &&
        subscription === undefined &&
        directory === undefined ? (
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

/**
 * The catalog offer an endpoint is bound to, when it was created by (or has
 * completed) a subscription sign-in. The server binds the descriptor id on a
 * finished sign-in and refuses a bearer whose base URL leaves the offer's
 * endpoint, so this is presentation only.
 */
export function boundSubscriptionOffer(
  instance: Extract<ProviderInstance, { driverKind: "openai-compatible" | "anthropic-compatible" }>,
): SubscriptionOAuthOffer | undefined {
  const descriptorId = subscriptionDescriptorIdOf(instance.configuration);
  if (descriptorId === undefined) return undefined;
  return subscriptionOAuthOffers().find(
    (offer) =>
      String(offer.descriptor.descriptorId) === String(descriptorId) &&
      offer.driverKinds.includes(instance.driverKind),
  );
}

/**
 * The sign-in a subscription endpoint's row shows: who is signed in, and sign
 * out or sign in again. `startSignIn` begins the sign-in as soon as the
 * terms are acknowledged, for an endpoint the person just added by choosing
 * the sign-in.
 */
export function SubscriptionEndpointSignIn(props: {
  readonly instance: Extract<
    ProviderInstance,
    { driverKind: "openai-compatible" | "anthropic-compatible" }
  >;
  readonly disabled: boolean;
  readonly startSignIn?: boolean;
  readonly consentShown?: boolean;
  readonly signInLabel?: string;
  readonly onStateChange?: (state: ProviderOAuthSignInState) => void;
  readonly onProviderOAuth?: (
    command: ProviderOAuthCommand,
  ) => Promise<import("../ProviderOAuthSignIn").ProviderOAuthCommandResult | undefined>;
  readonly onOpenExternalUrl?: (url: string) => void;
}) {
  const offer = boundSubscriptionOffer(props.instance);
  if (offer === undefined) return null;
  return (
    <ProviderOAuthSignInPanel
      accountLabel={offer.accountLabel}
      descriptorId={offer.descriptor.descriptorId}
      disabled={props.disabled}
      instanceId={props.instance.id}
      {...(props.startSignIn === true ? { startSignIn: true } : {})}
      {...(props.consentShown === true ? { consentShown: true } : {})}
      {...(props.signInLabel === undefined ? {} : { signInLabel: props.signInLabel })}
      {...(props.onStateChange === undefined ? {} : { onStateChange: props.onStateChange })}
      {...(props.onProviderOAuth === undefined ? {} : { run: props.onProviderOAuth })}
      {...(props.onOpenExternalUrl === undefined ? {} : { openUrl: props.onOpenExternalUrl })}
      termsSummary={offer.termsSummary}
    />
  );
}

interface AnthropicConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "anthropic-compatible" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeAnthropicCompatibleConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
  readonly onProviderOAuth?: (
    command: ProviderOAuthCommand,
  ) => Promise<import("../ProviderOAuthSignIn").ProviderOAuthCommandResult | undefined>;
  readonly onOpenExternalUrl?: (url: string) => void;
}

export function AnthropicConfigurationForm(props: AnthropicConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const saved = props.instance.configuration;
  const directory = saved.authentication === "directory-oauth" ? saved.directory : undefined;
  return (
    <form
      className="provider-card__edit provider-card__edit--http"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (directory !== undefined && !isGatewayDirectory(gatewayDirectoryFrom(data))) {
          setProblem(GATEWAY_DIRECTORY_PROBLEM);
          return;
        }
        setProblem(undefined);
        const formed = anthropicConfigurationFrom(data);
        const configuration: AnthropicCompatibleProviderConfiguration =
          saved.authentication === "directory-oauth" ||
          formed.authentication === "directory-oauth" ||
          saved.oauthDescriptorId === undefined
            ? formed
            : { ...formed, oauthDescriptorId: saved.oauthDescriptorId };
        const enteredCredential = transientCredential(credentialInput.current);
        const key =
          configuration.authentication !== "none"
            ? enteredCredential
            : emptyTransientCredential(enteredCredential);
        const generation =
          configuration.authentication !== "none" && key.value.length > 0
            ? props.credential.beginMutation()
            : undefined;
        void props.onChange(props.instance.id, configuration, key).then(
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
      <BaseUrlField
        ariaLabel={`API base URL for ${props.instance.displayName}`}
        instanceId={props.instance.id}
        label="API base URL"
        savedBaseUrl={saved.baseUrl}
        takesKey={saved.authentication !== "none" && directory === undefined}
      />
      {saved.authentication === "directory-oauth" ? (
        <GatewayDirectoryFields
          directory={saved.directory}
          instanceId={props.instance.id}
          instanceName={props.instance.displayName}
        />
      ) : (
        <>
          <HttpCredentialFields
            authentication={saved.authentication}
            authenticationLabel={`Authentication for ${props.instance.displayName}`}
            credentialInput={credentialInput}
            credentialLabel={`API key for ${props.instance.displayName}`}
            credentialManagementAvailable={props.credentialManagementAvailable}
            supportsApiKey
          />
          <DirectEndpointSignIn
            baseUrl={saved.baseUrl}
            disabled={props.disabled}
            driverKind="anthropic-compatible"
            instanceId={props.instance.id}
            {...(props.onProviderOAuth === undefined
              ? {}
              : { onProviderOAuth: props.onProviderOAuth })}
            {...(props.onOpenExternalUrl === undefined
              ? {}
              : { onOpenExternalUrl: props.onOpenExternalUrl })}
            onUseApiKey={() => credentialInput.current?.focus()}
          />
        </>
      )}
      <SettingRow
        label="Anthropic protocol version"
        scope="host"
        settingId={`provider-${props.instance.id}-protocol-version`}
      >
        <OctantInput
          aria-label={`Anthropic protocol version for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.protocolVersion}
          name="protocolVersion"
          required
        />
      </SettingRow>
      <SettingRow
        label="Protocol preference"
        scope="host"
        settingId={`provider-${props.instance.id}-protocol`}
      >
        <OctantSelectField
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
          options={[
            { id: "auto", label: "Automatic" },
            { id: "messages", label: "Messages" },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Manual model IDs"
        scope="host"
        settingId={`provider-${props.instance.id}-manual-model-ids`}
      >
        <OctantTextarea
          aria-label={`Manual model IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </SettingRow>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        {directory === undefined ? KEYED_GUIDANCE : GATEWAY_DIRECTORY_GUIDANCE}
      </p>
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Anthropic settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
        {props.credentialManagementAvailable && directory === undefined ? (
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

interface FoundryConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "azure-foundry" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeAzureFoundryConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

export function FoundryConfigurationForm(props: FoundryConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const saved = props.instance.configuration;
  // The form keeps the way the instance signs in unless the person changes
  // it: an organization sign-in saved through this form stays one.
  const [signIn, setSignIn] = useState(saved.authentication);
  const [problem, setProblem] = useState<string>();
  const savedDirectory = saved.authentication === "directory-oauth" ? saved.directory : undefined;
  const name = props.instance.displayName;
  return (
    <form
      className="provider-card__edit provider-card__edit--http"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (
          signIn === "directory-oauth" &&
          !(
            isDirectoryGuid(String(data.get("tenantId") ?? "")) &&
            isDirectoryGuid(String(data.get("clientId") ?? ""))
          )
        ) {
          setProblem(DIRECTORY_IDS_PROBLEM);
          return;
        }
        setProblem(undefined);
        const configuration = foundryConfigurationFrom(data);
        // An organization sign-in holds no key, so none is sent with it.
        const typed = transientCredential(credentialInput.current);
        const enteredCredential = signIn === "api-key" ? typed : emptyTransientCredential(typed);
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
      <BaseUrlField
        ariaLabel={`Foundry OpenAI v1 base URL for ${name}`}
        instanceId={props.instance.id}
        label="Foundry OpenAI v1 base URL"
        savedBaseUrl={saved.baseUrl}
        takesKey={signIn === "api-key"}
      />
      <SettingRow
        label="Sign in with"
        scope="host"
        settingId={`provider-${props.instance.id}-authentication`}
      >
        <OctantSelectField
          aria-label={`Authentication for ${name}`}
          className="settings-view__select"
          name="authentication"
          onValueChange={(value) =>
            setSignIn(value === "directory-oauth" ? "directory-oauth" : "api-key")
          }
          options={[
            { id: "api-key", label: "API key (api-key header)" },
            { id: "directory-oauth", label: "Organization account (Microsoft Entra ID)" },
          ]}
          value={signIn}
        />
      </SettingRow>
      {signIn === "api-key" ? (
        <label>
          <span>API key (leave blank to preserve)</span>
          <OctantInput
            aria-label={`API key for ${name}`}
            autoComplete="new-password"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            name="credential"
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <DirectoryIdFields
          clientId={savedDirectory === undefined ? "" : String(savedDirectory.clientId)}
          deviceCodeSignIn={
            saved.authentication === "directory-oauth" && saved.deviceCodeSignIn === true
          }
          instanceId={props.instance.id}
          instanceName={name}
          tenantId={savedDirectory === undefined ? "" : String(savedDirectory.tenantId)}
        />
      )}
      {saved.authentication !== signIn ? (
        <p
          className="provider-settings__field-guidance provider-settings__field-guidance--between-rows"
          role="status"
        >
          {signIn === "api-key"
            ? "Saving removes this endpoint's organization sign-in from this computer. Enter an API key to keep using it."
            : "Saving removes this endpoint's stored API key. Sign in with your organization account afterwards."}
        </p>
      ) : null}
      <SettingRow
        label="Protocol preference"
        scope="host"
        settingId={`provider-${props.instance.id}-protocol`}
      >
        <OctantSelectField
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
          options={[
            { id: "auto", label: "Automatic" },
            { id: "responses", label: "Responses" },
            { id: "chat-completions", label: "Chat Completions" },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Deployment IDs"
        scope="host"
        settingId={`provider-${props.instance.id}-deployment-ids`}
      >
        <OctantTextarea
          aria-label={`Deployment IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </SettingRow>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        {signIn === "api-key"
          ? "The base URL must end with /openai/v1/. API keys are stored write-only in Keychain and sent as the api-key header. List deployments in the order you want them to appear."
          : "The base URL must end with /openai/v1/ on an openai.azure.com, services.ai.azure.com, or cognitiveservices.azure.com address. Changing the tenant, client, or address signs this endpoint out. List deployments in the order you want them to appear."}
      </p>
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Azure AI Foundry settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
        {props.credentialManagementAvailable && saved.authentication === "api-key" ? (
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

const KEYED_GUIDANCE = "Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts.";
const GATEWAY_DIRECTORY_GUIDANCE =
  "The gateway's address must be HTTPS. Changing its client, scope, or address signs this endpoint out. The issuer is fixed; add a new endpoint to sign in at another.";

/** What the person is told when a gateway's issuer, client, or scope is not one the host takes. */
export const GATEWAY_DIRECTORY_PROBLEM =
  "Enter your organization's issuer (the https address its sign-in tokens name), the client ID it registered for Octant, and the one scope your gateway requires, such as gateway.models.";

/**
 * A gateway's organization sign-in: the issuer, fixed when the endpoint was
 * added, and the client and scope, which may change and sign the endpoint
 * out. None of it is secret.
 */
function GatewayDirectoryFields(props: {
  readonly instanceId: ProviderInstanceId;
  readonly instanceName: string;
  readonly directory: DirectoryIssuerBinding;
}) {
  return (
    <>
      <input name="authentication" type="hidden" value="directory-oauth" />
      <input name="issuer" type="hidden" value={String(props.directory.issuer)} />
      <SettingRow
        label="Sign-in issuer"
        scope="host"
        settingId={`provider-${props.instanceId}-directory-issuer`}
      >
        <span className="oct-meta--mono">{String(props.directory.issuer)}</span>
      </SettingRow>
      <SettingRow
        label="Client ID"
        scope="host"
        settingId={`provider-${props.instanceId}-directory-client`}
      >
        <OctantInput
          aria-label={`Client ID for ${props.instanceName}`}
          autoComplete="off"
          className="settings-view__text-input"
          defaultValue={String(props.directory.clientId)}
          name="clientId"
          spellCheck={false}
        />
      </SettingRow>
      <SettingRow
        label="Scope"
        scope="host"
        settingId={`provider-${props.instanceId}-directory-scope`}
      >
        <OctantInput
          aria-label={`Scope for ${props.instanceName}`}
          autoComplete="off"
          className="settings-view__text-input"
          defaultValue={String(props.directory.scope)}
          name="scope"
          spellCheck={false}
        />
      </SettingRow>
    </>
  );
}

/** What the person is told when a pasted tenant or client id is not a GUID. */
export const DIRECTORY_IDS_PROBLEM =
  "Enter the directory (tenant) ID and the application (client) ID your organization registered, each a GUID such as 6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f.";

/**
 * The tenant and client an organization sign-in binds to. Neither is secret:
 * the client is a public app the organization registered in its own tenant.
 * Pasted ids are lowercased when saved, since the host compares them exactly.
 */
function DirectoryIdFields(props: {
  readonly instanceId: ProviderInstanceId;
  readonly instanceName: string;
  readonly tenantId: string;
  readonly clientId: string;
  /** Whether the host-local command may sign this endpoint in with a device code. */
  readonly deviceCodeSignIn: boolean;
}) {
  return (
    <>
      <SettingRow
        label="Directory (tenant) ID"
        scope="host"
        settingId={`provider-${props.instanceId}-directory-tenant`}
      >
        <OctantInput
          aria-label={`Directory (tenant) ID for ${props.instanceName}`}
          autoComplete="off"
          className="settings-view__text-input"
          defaultValue={props.tenantId}
          name="tenantId"
          placeholder="00000000-0000-0000-0000-000000000000"
          spellCheck={false}
        />
      </SettingRow>
      <SettingRow
        label="Application (client) ID"
        scope="host"
        settingId={`provider-${props.instanceId}-directory-client`}
      >
        <OctantInput
          aria-label={`Application (client) ID for ${props.instanceName}`}
          autoComplete="off"
          className="settings-view__text-input"
          defaultValue={props.clientId}
          name="clientId"
          placeholder="00000000-0000-0000-0000-000000000000"
          spellCheck={false}
        />
      </SettingRow>
      <SettingRow
        label="Sign in from this host's terminal"
        scope="host"
        settingId={`provider-${props.instanceId}-directory-device-code`}
      >
        <label className="endpoint-flow__check">
          <OctantCheckbox
            aria-describedby={`provider-${props.instanceId}-directory-device-code-guidance`}
            aria-label={`Allow sign-in with a code from this host's terminal for ${props.instanceName}`}
            defaultChecked={props.deviceCodeSignIn}
            name="deviceCodeSignIn"
          />
          <span>
            <span>Allow sign-in with a code from this host's terminal</span>
            <span
              className="endpoint-flow__hint"
              id={`provider-${props.instanceId}-directory-device-code-guidance`}
            >
              For a host without the Octant desktop app: run{" "}
              <code>octant provider sign-in "{props.instanceName}"</code> on the host and enter the
              code it shows on any device. Leave this off unless you need it; many organizations
              block signing in with a code.
            </span>
          </span>
        </label>
      </SettingRow>
    </>
  );
}

/**
 * Sign in with the organization account an Azure AI Foundry endpoint or a
 * gateway binds to. The host builds the sign-in from the endpoint's own
 * directory, client, and address; this panel only starts it and shows the
 * public state.
 */
export function DirectoryEndpointSignIn(props: {
  readonly instance: Extract<
    ProviderInstance,
    { driverKind: "azure-foundry" | "openai-compatible" | "anthropic-compatible" }
  >;
  readonly disabled: boolean;
  readonly startSignIn?: boolean;
  readonly consentShown?: boolean;
  readonly onStateChange?: (state: ProviderOAuthSignInState) => void;
  readonly onProviderOAuth?: (
    command: ProviderOAuthCommand,
  ) => Promise<import("../ProviderOAuthSignIn").ProviderOAuthCommandResult | undefined>;
  readonly onOpenExternalUrl?: (url: string) => void;
}) {
  if (props.instance.configuration.authentication !== "directory-oauth") return null;
  const signIn =
    props.instance.driverKind === "azure-foundry"
      ? AZURE_FOUNDRY_DIRECTORY_SIGN_IN
      : GATEWAY_DIRECTORY_SIGN_IN;
  return (
    <ProviderOAuthSignInPanel
      accountLabel={signIn.accountLabel}
      descriptorId={signIn.descriptorId}
      disabled={props.disabled}
      instanceId={props.instance.id}
      localSignOut
      signInLabel="Sign in with your organization"
      {...(props.startSignIn === true ? { startSignIn: true } : {})}
      {...(props.consentShown === true ? { consentShown: true } : {})}
      {...(props.onStateChange === undefined ? {} : { onStateChange: props.onStateChange })}
      {...(props.onProviderOAuth === undefined ? {} : { run: props.onProviderOAuth })}
      {...(props.onOpenExternalUrl === undefined ? {} : { openUrl: props.onOpenExternalUrl })}
      termsSummary={signIn.termsSummary}
    />
  );
}

function DirectEndpointSignIn(props: {
  readonly instanceId: string;
  readonly driverKind: "openai-compatible" | "anthropic-compatible";
  readonly baseUrl: string;
  readonly disabled: boolean;
  readonly onUseApiKey: () => void;
  readonly onProviderOAuth?: (
    command: ProviderOAuthCommand,
  ) => Promise<import("../ProviderOAuthSignIn").ProviderOAuthCommandResult | undefined>;
  readonly onOpenExternalUrl?: (url: string) => void;
}) {
  // Several offers can share a driver kind (OpenRouter and the ChatGPT plan
  // both serve openai-compatible endpoints), so the offer is selected by the
  // instance's configured base URL: the offer whose allowed endpoint matches
  // the base URL's canonical origin. When more than one offer matches, the
  // person picks explicitly.
  const candidates = subscriptionOAuthOffers().filter(
    (candidate: SubscriptionOAuthOffer) =>
      candidate.driverKinds.includes(props.driverKind) &&
      originsMatch(candidate.allowedEndpoint, props.baseUrl),
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(
    candidates.length === 1 ? candidates[0]?.descriptor.descriptorId : undefined,
  );
  const offer =
    candidates.find((candidate) => candidate.descriptor.descriptorId === selectedId) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (offer === undefined) {
    if (candidates.length <= 1) return null;
    return (
      <SettingRow
        label="Sign-in account"
        scope="host"
        settingId={`provider-${props.instanceId}-oauth-offer`}
      >
        <OctantSelectField
          aria-label={`Sign-in account for ${props.instanceId}`}
          className="settings-view__select"
          defaultValue=""
          name="oauthOffer"
          onValueChange={(value) => setSelectedId(value || undefined)}
          options={candidates.map((candidate) => ({
            id: candidate.descriptor.descriptorId,
            label: candidate.accountLabel,
          }))}
        />
      </SettingRow>
    );
  }
  return (
    <ProviderOAuthSignInPanel
      accountLabel={offer.accountLabel}
      descriptorId={offer.descriptor.descriptorId}
      disabled={props.disabled}
      instanceId={props.instanceId}
      onUseApiKey={props.onUseApiKey}
      {...(props.onProviderOAuth === undefined ? {} : { run: props.onProviderOAuth })}
      {...(props.onOpenExternalUrl === undefined ? {} : { openUrl: props.onOpenExternalUrl })}
      termsSummary={offer.termsSummary}
    />
  );
}

function originsMatch(allowedEndpoint: string, baseUrl: string): boolean {
  try {
    return new URL(allowedEndpoint).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The host deletes an endpoint's stored key when its base URL changes, so a
 * key typed for one server is never sent to another. Say so while the address
 * differs from the saved one, before Save, rather than leaving the next check
 * to report a missing key without a reason.
 */
function BaseUrlField(props: {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly ariaLabel: string;
  readonly savedBaseUrl: string;
  readonly takesKey: boolean;
}) {
  const [value, setValue] = useState(props.savedBaseUrl);
  const noteId = `endpoint-base-url-key-note-${props.instanceId}`;
  const changed = props.takesKey && !sameAddress(value, props.savedBaseUrl);
  return (
    <>
      <SettingRow
        label={props.label}
        scope="host"
        settingId={`provider-${props.instanceId}-base-url`}
      >
        <OctantInput
          aria-describedby={`endpoint-guidance-${props.instanceId}${changed ? ` ${noteId}` : ""}`}
          aria-label={props.ariaLabel}
          className="settings-view__text-input"
          name="baseUrl"
          onChange={(event) => setValue(event.currentTarget.value)}
          required
          type="url"
          value={value}
        />
      </SettingRow>
      {changed ? (
        <p
          className="provider-settings__field-guidance provider-settings__field-guidance--between-rows"
          id={noteId}
          role="status"
        >
          Saving a different address removes this endpoint&apos;s stored API key, so it is never
          sent to the new server. Enter the key again to keep using the endpoint.
        </p>
      ) : null}
    </>
  );
}

/**
 * The host compares the addresses it stores after normalising them, so a
 * spelling that normalises to the saved one (a missing trailing slash) keeps
 * the key. An address that cannot be normalised is treated as different.
 */
function sameAddress(entered: string, saved: string): boolean {
  if (entered === saved) return true;
  try {
    return normalizeOpenAiCompatibleBaseUrl(entered) === normalizeOpenAiCompatibleBaseUrl(saved);
  } catch {
    return false;
  }
}
