import type {
  HiddenProviderModelRef,
  ProviderDataTag,
  ProviderDataTags,
  ProviderModelId,
  ProviderObservedState,
} from "@octant/contracts";
import { modelCarriesAppManagedTools } from "@octant/domain";
import { ChevronLeft } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AnthropicConfigurationForm,
  FoundryConfigurationForm,
  HttpConfigurationForm,
  OllamaConfigurationForm,
  SubscriptionEndpointSignIn,
} from "../../providers/ProviderSettingsConfiguration";
import {
  useCredentialStatus,
  type CredentialStatusController,
} from "../../providers/ProviderSettingsCredentials";
import { ModelContextWindowField } from "../../providers/ModelContextWindowField";
import type { ProviderOAuthSignInState } from "../../providers/ProviderOAuthSignIn";
import type { ProviderSettingsViewProps } from "../../providers/ProviderSettingsView";
import {
  capabilityLabels,
  driverLabel,
  formatProbeTimestamp,
  protocolLabel,
} from "../../providers/providerSettingsPresentation";
import type {
  ModelToolVerification,
  ProviderProbeFailure,
} from "../../providers/useProviderController";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../../ui/base/OctantConfirmDialog";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSwitch } from "../../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../../ui/base/OctantToggleGroup";
import { SettingRow, SettingsDisclosure, SettingsFactList, SettingsSection } from "../primitives";
import {
  endpointHost,
  endpointModelCount,
  endpointTakesKey,
  type EndpointFixKind,
  type EndpointSignIn,
  type EndpointStatus,
  type ModelEndpointInstance,
} from "./endpointStatus";
import { EndpointMark, EndpointState } from "./ModelEndpointRow";

/** Where the detail page puts focus when a row's fix opened it. */
export type EndpointDetailFocus = "key" | "address" | "model-ids";

export type ModelEndpointDetailProps = Pick<
  ProviderSettingsViewProps,
  | "credentialManagementAvailable"
  | "onRename"
  | "onChangeOpenAiCompatibleConfiguration"
  | "onChangeAnthropicCompatibleConfiguration"
  | "onChangeAzureFoundryConfiguration"
  | "onChangeOllamaConfiguration"
  | "onProviderCredentialStatus"
  | "onClearProviderCredential"
  | "onProviderOAuth"
  | "onOpenExternalUrl"
  | "onSetEnabled"
  | "onDataTagsChange"
  | "onModelDataTagsChange"
  | "onModelContextWindowChange"
  | "onRemove"
  | "onProbe"
  | "onHiddenModelsChange"
> & {
  readonly instance: ModelEndpointInstance;
  /** Last observed facts, kept while a check runs; presentation only. */
  readonly observed: ProviderObservedState | undefined;
  readonly status: EndpointStatus;
  readonly failure: ProviderProbeFailure | undefined;
  readonly signIn: EndpointSignIn | undefined;
  readonly signInOffer: { readonly accountLabel: string; readonly action: string } | undefined;
  readonly hiddenModels: ReadonlyArray<HiddenProviderModelRef>;
  readonly busy: boolean;
  readonly checking: boolean;
  readonly startSignIn: boolean;
  /** The click that opened this page to sign in sat beside the terms' consent line. */
  readonly signInConsentShown: boolean;
  readonly focusOnOpen: EndpointDetailFocus | undefined;
  readonly onBack: () => void;
  readonly onSignInState: (state: ProviderOAuthSignInState) => void;
  readonly onVerifyModelTools: (
    instanceId: ModelEndpointInstance["id"],
    modelId: ProviderModelId,
  ) => Promise<ModelToolVerification>;
  /** The model roles that name this endpoint's models, for the Remove confirmation. */
  readonly onRolesUsing?: (instanceId: string) => Promise<ReadonlyArray<string>>;
};

const FOCUS_SELECTORS: Readonly<Record<EndpointDetailFocus, string>> = {
  key: 'input[name="credential"]',
  address: 'input[name="baseUrl"]',
  "model-ids": 'textarea[name="manualModelIds"], textarea[name="deploymentIds"]',
};

/**
 * Settings › Octant Harness › one endpoint. It leads with whether the endpoint
 * works and its one fix, then its sign-in or key, its models, where its data
 * goes, its name and address, the precise terms under Diagnostics (folded
 * unless it is failing), and Remove last.
 */
export function ModelEndpointDetail(props: ModelEndpointDetailProps) {
  const { instance } = props;
  const name = instance.displayName;
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const failing = props.status.tone === "failed";
  const disabled = props.busy || props.checking;

  useEffect(() => {
    const target =
      props.focusOnOpen === undefined
        ? null
        : root.current?.querySelector<HTMLElement>(FOCUS_SELECTORS[props.focusOnOpen]);
    if (target !== null && target !== undefined) {
      target.focus();
      target.scrollIntoView?.({ block: "center" });
      return;
    }
    heading.current?.focus();
    // Focus moves once, when the page opens; later renders leave it alone.
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A dialog opened from this page renders in a portal: its Escape closes
    // the dialog, not the page.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!(event.target instanceof Node) || !root.current?.contains(event.target)) return;
    event.preventDefault();
    props.onBack();
  };

  const fix = props.status.fix;
  const runFix = (kind: EndpointFixKind) => {
    if (kind === "try-again" || kind === "check-now") {
      void props.onProbe(instance.id, { quiet: true });
      return;
    }
    const selector =
      kind === "replace-key" || kind === "add-key"
        ? FOCUS_SELECTORS.key
        : kind === "edit-address"
          ? FOCUS_SELECTORS.address
          : kind === "add-model-ids"
            ? FOCUS_SELECTORS["model-ids"]
            : '[data-endpoint-sign-in] button[type="button"]';
    const target = root.current?.querySelector<HTMLElement>(selector);
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  };

  const signInEndpoint =
    (instance.driverKind === "openai-compatible" ||
      instance.driverKind === "anthropic-compatible") &&
    instance.configuration.oauthDescriptorId !== undefined;
  const credential = useCredentialStatus(
    {
      instance,
      ...(props.observed === undefined ? {} : { observed: props.observed }),
      credentialManagementAvailable: props.credentialManagementAvailable,
      onProviderCredentialStatus: props.onProviderCredentialStatus,
    },
    signInEndpoint || !endpointTakesKey(instance),
  );
  const modelCount = endpointModelCount(instance, props.observed, props.hiddenModels);
  const checkedAt = props.failure?.failedAt ?? props.observed?.observedAt;

  return (
    <div
      aria-labelledby={headingId}
      className="endpoint-detail"
      onKeyDown={onKeyDown}
      ref={root}
      role="region"
    >
      <OctantButton
        aria-label="Back to Octant Harness"
        className="endpoint-detail__back window-no-drag"
        onClick={props.onBack}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeft aria-hidden="true" size={16} />
        Octant Harness
      </OctantButton>
      <header className="endpoint-detail__head">
        <EndpointMark instance={instance} size={20} />
        <div className="endpoint-detail__title">
          <h1 className="endpoint-detail__name" id={headingId} ref={heading} tabIndex={-1}>
            {name}
          </h1>
          <p className="endpoint-detail__state">
            <EndpointState status={props.status} />
            {modelCount === undefined ? null : <span>· {modelCount}</span>}
            {checkedAt === undefined ? null : <span>· checked {checkedAgo(checkedAt)}</span>}
          </p>
        </div>
        <div className="endpoint-detail__controls">
          <OctantButton
            aria-label={`Check ${name} now`}
            disabled={disabled || !instance.enabled}
            onClick={() => void props.onProbe(instance.id, { quiet: true })}
            size="sm"
            type="button"
            variant="ghost"
          >
            {props.checking ? "Checking…" : "Check now"}
          </OctantButton>
          <span className="endpoint-detail__use">
            <span aria-hidden="true">Use</span>
            <OctantSwitch
              checked={instance.enabled}
              disabled={disabled}
              label={`Use ${name}`}
              onCheckedChange={(enabled) => {
                void props.onSetEnabled(instance.id, enabled).then((updated) => {
                  if (updated && enabled) void props.onProbe(instance.id, { quiet: true });
                });
              }}
            />
          </span>
        </div>
      </header>
      {/* A sign-in fix with nothing to explain is the Sign-in section itself. */}
      {props.status.sentence === undefined &&
      (fix === undefined || fix.kind === "sign-in") ? null : (
        <div aria-live="polite">
          <OctantAlert
            action={
              fix === undefined ? undefined : (
                <OctantButton
                  aria-label={`${fix.label} for ${name}`}
                  disabled={disabled}
                  onClick={() => runFix(fix.kind)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {fix.label}
                </OctantButton>
              )
            }
            role="status"
            title={props.status.label}
            tone={failing ? "danger" : "neutral"}
          >
            {props.status.sentence ?? null}
          </OctantAlert>
        </div>
      )}
      <AccessSection
        {...props}
        credential={credential}
        disabled={disabled}
        onFocusKey={() => runFix("replace-key")}
        signInEndpoint={signInEndpoint}
      />
      <ModelsSection {...props} disabled={disabled} />
      <DataSection {...props} disabled={disabled} />
      <NameAndAddressSection {...props} credential={credential} disabled={disabled} />
      <DiagnosticsSection {...props} failing={failing} />
      <RemoveSection {...props} disabled={disabled} />
    </div>
  );
}

function AccessSection(
  props: ModelEndpointDetailProps & {
    readonly disabled: boolean;
    readonly credential: CredentialStatusController;
    readonly signInEndpoint: boolean;
    readonly onFocusKey: () => void;
  },
) {
  const { instance, credential } = props;
  const takesKey = endpointTakesKey(instance);
  if (props.signInEndpoint) {
    return (
      <SettingsSection title="Sign-in">
        <div className="endpoint-detail__panel" data-endpoint-sign-in="">
          {(instance.driverKind === "openai-compatible" ||
            instance.driverKind === "anthropic-compatible") && (
            <SubscriptionEndpointSignIn
              disabled={props.disabled}
              instance={instance}
              onStateChange={props.onSignInState}
              consentShown={props.signInConsentShown}
              startSignIn={props.startSignIn}
              {...(props.signInOffer === undefined
                ? {}
                : { signInLabel: props.signInOffer.action })}
              {...(props.onProviderOAuth === undefined
                ? {}
                : { onProviderOAuth: props.onProviderOAuth })}
              {...(props.onOpenExternalUrl === undefined
                ? {}
                : { onOpenExternalUrl: props.onOpenExternalUrl })}
            />
          )}
          {props.credentialManagementAvailable ? null : (
            <p className="endpoint-detail__note">
              Sign-in starts from the Octant app or a browser on this Mac.
            </p>
          )}
        </div>
      </SettingsSection>
    );
  }
  // An endpoint that sends no key has nothing to say about one: a keyless
  // endpoint used to read "Credential: Unavailable".
  if (!takesKey) return null;
  const status = credential.status;
  const detail = !props.credentialManagementAvailable
    ? "Keys are added and replaced from the Octant app on this Mac."
    : status === "stored"
      ? "Saved in this Mac's Keychain. Octant can't show it."
      : status === "missing"
        ? "No key is saved for it yet."
        : status === "checking"
          ? "Checking the Keychain…"
          : "Octant couldn't read the Keychain.";
  return (
    <SettingsSection title="API key">
      <div className="setgroup">
        <SettingRow
          description={detail}
          label="API key"
          labelledBySection
          scope="host"
          settingId={`endpoint-${String(instance.id)}-key`}
        >
          {props.credentialManagementAvailable ? (
            <OctantButton
              aria-label={`${status === "missing" ? "Add key" : "Replace key"} for ${instance.displayName}`}
              disabled={props.disabled}
              onClick={props.onFocusKey}
              size="sm"
              type="button"
              variant="outline"
            >
              {status === "missing" ? "Add key" : "Replace key"}
            </OctantButton>
          ) : null}
        </SettingRow>
      </div>
    </SettingsSection>
  );
}

type ModelFilter = "shown" | "hidden" | "all";

function ModelsSection(props: ModelEndpointDetailProps & { readonly disabled: boolean }) {
  const { instance, observed } = props;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [verifying, setVerifying] = useState<string>();
  const [verifyResult, setVerifyResult] = useState<string>();
  const models = observed?.models ?? [];
  const hidden = new Set(
    props.hiddenModels
      .filter((ref) => String(ref.providerInstanceId) === String(instance.id))
      .map((ref) => String(ref.modelId)),
  );
  const hiddenCount = models.filter((model) => hidden.has(String(model.id))).length;
  const search = query.trim().toLowerCase();
  const rows = models.filter((model) => {
    const isHidden = hidden.has(String(model.id));
    if (filter === "shown" && isHidden) return false;
    if (filter === "hidden" && !isHidden) return false;
    return `${model.displayName} ${model.id}`.toLowerCase().includes(search);
  });
  const setShown = (modelId: ProviderModelId, shown: boolean) => {
    const next = props.hiddenModels.filter(
      (ref) =>
        !(
          String(ref.providerInstanceId) === String(instance.id) &&
          String(ref.modelId) === String(modelId)
        ),
    );
    if (!shown) next.push({ providerInstanceId: instance.id, modelId });
    void props.onHiddenModelsChange(next);
  };
  const verify = (modelId: ProviderModelId) => {
    setVerifying(String(modelId));
    setVerifyResult(undefined);
    void props
      .onVerifyModelTools(instance.id, modelId)
      .then((outcome) => {
        setVerifyResult(
          outcome === "supported"
            ? `${String(modelId)} can use Octant's tools.`
            : outcome === "unsupported"
              ? `${String(modelId)} answered without calling a tool, so it stays Chat only.`
              : `Octant couldn't verify ${String(modelId)}. Try again later.`,
        );
      })
      .finally(() => setVerifying(undefined));
  };
  return (
    <SettingsSection
      description="Shown models appear in the model picker and in Model roles."
      title="Models"
    >
      {models.length === 0 ? (
        <div className="endpoint-detail__panel">
          <p className="endpoint-detail__note">
            {observed === undefined
              ? "Octant lists its models after a check."
              : "It lists no models. Add the model IDs you use under Name and address."}
          </p>
        </div>
      ) : (
        <div className="endpoint-models">
          <div className="endpoint-models__tools">
            <OctantInput
              aria-label={`Search ${instance.displayName} models`}
              className="endpoint-models__search"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={`Search ${models.length} ${models.length === 1 ? "model" : "models"}`}
              type="search"
              value={query}
            />
            <OctantToggleGroup<ModelFilter>
              aria-label="Which models to list"
              className="endpoint-models__filter"
              onValueChange={(value) => {
                const next = value[0];
                if (next !== undefined) setFilter(next);
              }}
              value={[filter]}
            >
              <OctantToggleGroupItem value="shown">
                Shown {models.length - hiddenCount}
              </OctantToggleGroupItem>
              <OctantToggleGroupItem value="hidden">Hidden {hiddenCount}</OctantToggleGroupItem>
              <OctantToggleGroupItem value="all">All</OctantToggleGroupItem>
            </OctantToggleGroup>
          </div>
          <p aria-live="polite" className="endpoint-models__status">
            {verifyResult ?? ""}
          </p>
          {rows.length === 0 ? (
            <p className="endpoint-detail__note">No models match.</p>
          ) : (
            <ul aria-label={`${instance.displayName} models`} className="endpoint-models__list">
              {rows.map((model) => {
                const isHidden = hidden.has(String(model.id));
                const readsImages = model.inputModalities.includes("image");
                const chatOnly =
                  observed !== undefined && !modelCarriesAppManagedTools(observed, model.id);
                return (
                  <li className="endpoint-model" key={String(model.id)}>
                    <span className="endpoint-model__id">{model.displayName}</span>
                    <span className="endpoint-model__tags">
                      {readsImages ? <span className="endpoint-tag">Reads images</span> : null}
                      {chatOnly ? (
                        <>
                          <span
                            className="endpoint-tag"
                            data-kind="chat-only"
                            title="Octant hasn't seen this model call a tool, so it answers without Octant's tools."
                          >
                            Chat only
                          </span>
                          <OctantButton
                            aria-label={`Verify tools for ${model.displayName}`}
                            disabled={props.disabled || verifying !== undefined}
                            onClick={() => verify(model.id)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {verifying === String(model.id) ? "Verifying…" : "Verify tools"}
                          </OctantButton>
                        </>
                      ) : null}
                    </span>
                    {/* Ollama reports its own windows; the HTTP endpoints take an override. */}
                    {props.onModelContextWindowChange === undefined ||
                    instance.driverKind === "ollama" ? null : (
                      <ModelContextWindowField
                        disabled={props.disabled}
                        model={model}
                        onChange={(contextWindow) =>
                          props.onModelContextWindowChange?.(
                            instance.id,
                            model.id,
                            contextWindow,
                          ) ?? Promise.resolve(false)
                        }
                      />
                    )}
                    <OctantSwitch
                      checked={!isHidden}
                      disabled={props.disabled}
                      label={`Show ${model.displayName} in the model picker`}
                      onCheckedChange={(shown) => setShown(model.id, shown)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <p className="endpoint-detail__note">
            Verify tools sends one request, which the service may bill.
          </p>
        </div>
      )}
    </SettingsSection>
  );
}

const DATA_TAG_COPY: Readonly<
  Record<ProviderDataTag, { readonly label: string; readonly detail: string }>
> = {
  eu: {
    label: "Data stays in the EU",
    detail: "The service processes and stores requests only in the EU.",
  },
  zdr: {
    label: "Nothing is kept after the reply",
    detail: "Zero data retention: the service stores no prompts or replies.",
  },
};

function toggleTag(tags: ReadonlyArray<ProviderDataTag>, tag: ProviderDataTag): ProviderDataTags {
  return tags.includes(tag) ? tags.filter((candidate) => candidate !== tag) : [...tags, tag];
}

function DataSection(props: ModelEndpointDetailProps & { readonly disabled: boolean }) {
  const { instance } = props;
  const tags = instance.dataTags ?? [];
  const models = props.observed?.models ?? [];
  const ownTags = models.filter((model) => (model.dataTags ?? []).length > 0).length;
  const dataId = useId();
  return (
    <SettingsSection
      description="You set these; Octant can't check them. A Project that requires one only uses models marked with it."
      title="Where your data goes"
    >
      <div className="endpoint-detail__panel endpoint-data">
        {(["eu", "zdr"] as const).map((tag) => (
          <label className="endpoint-data__choice" key={tag}>
            <OctantCheckbox
              aria-describedby={`${dataId}-${tag}`}
              aria-label={DATA_TAG_COPY[tag].label}
              checked={tags.includes(tag)}
              disabled={props.disabled}
              onChange={() => void props.onDataTagsChange(instance.id, toggleTag(tags, tag))}
            />
            <span>
              <span className="endpoint-data__label">{DATA_TAG_COPY[tag].label}</span>
              <span className="endpoint-data__detail" id={`${dataId}-${tag}`}>
                {DATA_TAG_COPY[tag].detail}
              </span>
            </span>
          </label>
        ))}
        {models.length === 0 ? null : (
          <SettingsDisclosure
            {...(ownTags === 0
              ? {}
              : { description: `${ownTags} ${ownTags === 1 ? "model is" : "models are"} set` })}
            title="Set these per model"
            variant="inline"
          >
            <ul className="endpoint-data__models">
              {models.map((model) => {
                const modelTags = model.dataTags ?? [];
                return (
                  <li key={String(model.id)}>
                    <span className="endpoint-model__id">{model.displayName}</span>
                    {(["eu", "zdr"] as const).map((tag) => (
                      <label className="endpoint-data__inline" key={tag}>
                        <OctantCheckbox
                          aria-label={`${DATA_TAG_COPY[tag].label}: ${model.displayName}`}
                          checked={modelTags.includes(tag)}
                          disabled={props.disabled}
                          onChange={() =>
                            void props.onModelDataTagsChange(
                              instance.id,
                              model.id,
                              toggleTag(modelTags, tag),
                            )
                          }
                        />
                        <span aria-hidden="true">{tag === "eu" ? "EU" : "Not kept"}</span>
                      </label>
                    ))}
                  </li>
                );
              })}
            </ul>
          </SettingsDisclosure>
        )}
      </div>
    </SettingsSection>
  );
}

function NameAndAddressSection(
  props: ModelEndpointDetailProps & {
    readonly disabled: boolean;
    readonly credential: CredentialStatusController;
  },
) {
  const { instance, credential } = props;
  const [saved, setSaved] = useState(false);
  let form: ReactNode = null;
  if (instance.driverKind === "openai-compatible") {
    form = (
      <HttpConfigurationForm
        credential={credential}
        credentialManagementAvailable={props.credentialManagementAvailable}
        disabled={props.disabled}
        instance={instance}
        key={`http:${instance.version}`}
        onChange={props.onChangeOpenAiCompatibleConfiguration}
        onClearCredential={props.onClearProviderCredential}
        {...(props.onProviderOAuth === undefined ? {} : { onProviderOAuth: props.onProviderOAuth })}
        {...(props.onOpenExternalUrl === undefined
          ? {}
          : { onOpenExternalUrl: props.onOpenExternalUrl })}
      />
    );
  } else if (instance.driverKind === "anthropic-compatible") {
    form = (
      <AnthropicConfigurationForm
        credential={credential}
        credentialManagementAvailable={props.credentialManagementAvailable}
        disabled={props.disabled}
        instance={instance}
        key={`anthropic:${instance.version}`}
        onChange={props.onChangeAnthropicCompatibleConfiguration}
        onClearCredential={props.onClearProviderCredential}
        {...(props.onProviderOAuth === undefined ? {} : { onProviderOAuth: props.onProviderOAuth })}
        {...(props.onOpenExternalUrl === undefined
          ? {}
          : { onOpenExternalUrl: props.onOpenExternalUrl })}
      />
    );
  } else if (instance.driverKind === "azure-foundry") {
    form = (
      <FoundryConfigurationForm
        credential={credential}
        credentialManagementAvailable={props.credentialManagementAvailable}
        disabled={props.disabled}
        instance={instance}
        key={`foundry:${instance.version}`}
        onChange={props.onChangeAzureFoundryConfiguration}
        onClearCredential={props.onClearProviderCredential}
      />
    );
  } else {
    form = (
      <OllamaConfigurationForm
        disabled={props.disabled}
        instance={instance}
        key={`ollama:${instance.version}`}
        onChange={props.onChangeOllamaConfiguration}
      />
    );
  }
  return (
    <SettingsSection title="Name and address">
      <div className="endpoint-detail__panel">
        <form
          className="provider-card__edit"
          key={`name:${instance.version}`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            const data = new FormData(event.currentTarget);
            void props.onRename(instance.id, String(data.get("displayName") ?? "")).then((ok) => {
              if (ok) setSaved(true);
            });
          }}
        >
          <SettingRow
            description="Shown in the model picker."
            htmlFor={`endpoint-${String(instance.id)}-name`}
            label="Name"
            scope="host"
            settingId={`endpoint-${String(instance.id)}-name`}
          >
            <span className="endpoint-detail__rename">
              <OctantInput
                aria-label={`Name for ${instance.displayName}`}
                className="settings-view__text-input"
                defaultValue={instance.displayName}
                id={`endpoint-${String(instance.id)}-name`}
                name="displayName"
                onChange={() => setSaved(false)}
                required
              />
              <OctantButton
                aria-label={`Save name for ${instance.displayName}`}
                disabled={props.disabled}
                size="sm"
                type="submit"
                variant="outline"
              >
                Save
              </OctantButton>
              <span aria-live="polite" className="endpoint-detail__saved" role="status">
                {saved ? "Saved" : ""}
              </span>
            </span>
          </SettingRow>
        </form>
        {form}
      </div>
    </SettingsSection>
  );
}

function authenticationFact(
  instance: ModelEndpointInstance,
  offer: { readonly accountLabel: string } | undefined,
): string {
  if (offer !== undefined) return `${offer.accountLabel} sign-in (bearer token)`;
  if (instance.driverKind === "ollama") return "None (this Mac only)";
  if (instance.driverKind === "azure-foundry") return "API key (api-key header)";
  const authentication = instance.configuration.authentication;
  if (authentication === "none") return "None";
  if (authentication === "api-key") return "API key (x-api-key header)";
  return "API key (bearer)";
}

function protocolFact(
  instance: ModelEndpointInstance,
  observed: ProviderObservedState | undefined,
): string {
  if (instance.driverKind === "ollama") return "Ollama's own API";
  const configured = `Set to ${protocolLabel(instance.configuration.protocol)}`;
  if (instance.driverKind === "anthropic-compatible") {
    return `${configured} · version ${instance.configuration.protocolVersion}`;
  }
  return observed?.observedProtocol === undefined
    ? `${configured} · no turn has used it yet`
    : `${configured} · last turn used ${protocolLabel(observed.observedProtocol)}`;
}

function DiagnosticsSection(props: ModelEndpointDetailProps & { readonly failing: boolean }) {
  const { instance, observed, failure } = props;
  const [copied, setCopied] = useState(false);
  const verified = observed?.verifiedToolModelIds?.length ?? 0;
  const supported =
    observed === undefined
      ? []
      : capabilityLabels.filter(([key]) => observed.capabilities[key] === "supported");
  const unsupported =
    observed === undefined
      ? []
      : capabilityLabels.filter(([key]) => observed.capabilities[key] !== "supported");
  const facts: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
    { label: "Address", value: instance.configuration.baseUrl },
    { label: "Kind", value: driverLabel(instance.driverKind) },
    { label: "Protocol", value: protocolFact(instance, observed) },
    { label: "Authentication", value: authenticationFact(instance, props.signInOffer) },
    {
      label: "Last check",
      value:
        failure !== undefined
          ? `${formatProbeTimestamp(failure.failedAt)} · failed (${failure.category}): ${failure.message}`
          : observed === undefined
            ? "Not checked yet"
            : `${formatProbeTimestamp(observed.observedAt)} · ${observed.readiness}${
                observed.message === undefined ? "" : `: ${observed.message}`
              }`,
    },
    {
      label: "Last successful check",
      value:
        observed?.lastSuccessfulProbeAt === undefined
          ? "Never"
          : `${formatProbeTimestamp(observed.lastSuccessfulProbeAt)} · ${observed.models.length} models listed`,
    },
    {
      label: "Tool use",
      value:
        observed === undefined
          ? "Not checked yet"
          : observed.capabilities.appManagedTools === "supported"
            ? "Every model"
            : verified === 0
              ? "Not verified on any model · all are Chat only"
              : `Verified on ${verified} ${verified === 1 ? "model" : "models"} · others are Chat only`,
    },
    ...(observed === undefined
      ? []
      : [
          {
            label: "Supports",
            value:
              supported.length === 0 ? "Nothing reported" : supported.map(([, l]) => l).join(", "),
          },
          {
            label: "Doesn't support",
            value: unsupported.length === 0 ? "—" : unsupported.map(([, l]) => l).join(", "),
          },
        ]),
  ];
  const copy = () => {
    const text = [
      `${instance.displayName} (${endpointHost(instance)})`,
      ...facts.map((fact) => `${fact.label}: ${fact.value}`),
    ].join("\n");
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <section aria-label="Diagnostics" className="endpoint-detail__diagnostics">
      <SettingsDisclosure
        // Opens by itself while the endpoint is failing, and stays folded otherwise.
        defaultOpen={props.failing}
        key={props.failing ? "failing" : "working"}
        title="Diagnostics"
      >
        <SettingsFactList facts={facts} />
        <div className="endpoint-detail__actions">
          <OctantButton onClick={copy} size="sm" type="button" variant="outline">
            Copy diagnostics
          </OctantButton>
          <span aria-live="polite" className="endpoint-detail__saved" role="status">
            {copied ? "Copied" : ""}
          </span>
        </div>
      </SettingsDisclosure>
    </section>
  );
}

function RemoveSection(props: ModelEndpointDetailProps & { readonly disabled: boolean }) {
  const { instance } = props;
  const [confirming, setConfirming] = useState(false);
  // "unknown" when the lookup failed: saying no role uses it could be false.
  const [roles, setRoles] = useState<ReadonlyArray<string> | "unknown" | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // The host keeps credential removal to the app on this Mac; an endpoint
  // that holds a key or a sign-in can't be removed from a browser.
  const blocked = instance.driverKind !== "ollama" && !props.credentialManagementAvailable;
  const open = () => {
    setConfirming(true);
    setRoles(undefined);
    void props
      .onRolesUsing?.(String(instance.id))
      .then(setRoles)
      .catch(() => setRoles("unknown"));
  };
  const rolesLine =
    props.onRolesUsing === undefined
      ? null
      : roles === undefined
        ? "Checking which model roles use it…"
        : roles === "unknown"
          ? "Octant couldn't check which model roles use it."
          : roles.length === 0
            ? "No model role uses its models."
            : `${roles.join(", ")} ${roles.length === 1 ? "uses" : "use"} its models, and will move to the next model in the role, or to the main model.`;
  return (
    <SettingsSection title="Remove" tone="danger">
      <div className="setgroup">
        <SettingRow
          description={
            blocked
              ? "Remove it from the Octant app on this Mac."
              : "Signs out and deletes its settings. Threads that used it keep their history."
          }
          label={`Remove ${instance.displayName}`}
          scope="host"
          settingId={`endpoint-${String(instance.id)}-remove`}
        >
          <OctantButton
            aria-label={`Remove ${instance.displayName}…`}
            disabled={props.disabled || blocked}
            onClick={open}
            ref={trigger}
            size="sm"
            type="button"
            variant="destructive"
          >
            Remove…
          </OctantButton>
        </SettingRow>
      </div>
      {confirming ? (
        <OctantConfirmDialog
          cancelLabel="Keep endpoint"
          confirmLabel="Remove endpoint"
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setPending(true);
            void props.onRemove(instance.id).finally(() => {
              setPending(false);
              setConfirming(false);
            });
          }}
          pending={pending}
          restoreFocus={trigger}
          title={`Remove ${instance.displayName}?`}
        >
          {`It signs out and deletes its settings; threads that used it keep their history.${
            rolesLine === null ? "" : ` ${rolesLine}`
          }`}
        </OctantConfirmDialog>
      ) : null}
    </SettingsSection>
  );
}

/** "just now", "4 min ago", or the date and time for anything older than an hour. */
function checkedAgo(timestamp: string): string {
  const elapsed = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  return formatProbeTimestamp(timestamp);
}
