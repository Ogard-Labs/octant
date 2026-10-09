import type {
  AgentEligibleModelRef,
  HiddenProviderModelRef,
  HostId,
  NativeHarnessRoutingSettings,
  NativeHarnessSlotId,
  ProviderModelId,
  ProviderObservedState,
} from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import { Globe, MessagesSquare, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ProviderGlyph } from "../../providers/ProviderGlyph";
import { parseManualModelIds } from "../../providers/configuration/configurationValues";
import { BedrockMantleGuide } from "../../providers/configuration/ProviderCreateForm";
import type { ProviderSettingsViewProps } from "../../providers/ProviderSettingsView";
import type {
  ModelToolCheck,
  ProviderProbeFailure,
  TransientProviderCredential,
} from "../../providers/useProviderController";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { SettingsDisclosure } from "../primitives";
import {
  ASSIGNABLE_ROLES,
  ENDPOINT_KINDS,
  azureFoundryBaseUrl,
  endpointKindPresentation,
  looksLikeAzureFoundry,
  mayTakeAgentWork,
  modelsToList,
  withFirstChoice,
  type EndpointKind,
  type ToolCheck,
} from "./addEndpointSteps";
import { NEEDS_KEY_LABEL, type EndpointStatus, type ModelEndpointInstance } from "./endpointStatus";
import type { EndpointDetailFocus } from "./ModelEndpointDetail";
import { EndpointState } from "./ModelEndpointRow";

/** The endpoint Add endpoint made, as the page last saw it. */
export interface AddedEndpoint {
  readonly instance: ModelEndpointInstance;
  readonly observed: ProviderObservedState | undefined;
  readonly status: EndpointStatus;
  readonly checking: boolean;
}

export type AddEndpointStep = "kind" | "connect" | "models" | "verify" | "agents" | "done";

const STEP_NAMES: ReadonlyArray<{ readonly step: AddEndpointStep; readonly name: string }> = [
  { step: "kind", name: "Kind" },
  { step: "connect", name: "Connect" },
  { step: "models", name: "Models" },
  { step: "verify", name: "Verify tools" },
  { step: "agents", name: "Agents" },
];

export type AddEndpointFlowProps = Pick<
  ProviderSettingsViewProps,
  | "busy"
  | "credentialManagementAvailable"
  | "defaults"
  | "onCreateOpenAiCompatible"
  | "onCreateAnthropicCompatible"
  | "onCreateAzureFoundry"
  | "onCreateOllama"
  | "onChangeOpenAiCompatibleConfiguration"
  | "onChangeAnthropicCompatibleConfiguration"
  | "onChangeAzureFoundryConfiguration"
  | "onHiddenModelsChange"
  | "onAgentEligibleModelsChange"
  | "onProbe"
  | "onVerifyModelTools"
> & {
  /** The endpoint this flow added, once the registry lists it. */
  readonly added: AddedEndpoint | undefined;
  /** A tool check that says what stopped it; without it the flow uses Verify tools. */
  readonly onCheckModelTools?: (
    instanceId: ModelEndpointInstance["id"],
    modelId: ProviderModelId,
  ) => Promise<ModelToolCheck>;
  /** Where Octant Harness roles are read and saved; absent leaves roles to Model roles. */
  readonly roles?: {
    readonly client: Pick<NativeHarnessClient, "routing" | "updateRouting">;
    readonly hostId: HostId;
  };
  /** Told after the flow saved Octant Harness roles, so a roles view can read them again. */
  readonly onRolesSaved?: () => void;
  /** The sign-ins offered before the kinds, on the first step only. */
  readonly signIns?: ReactNode;
  readonly onStepChange?: (step: AddEndpointStep) => void;
  readonly onOpenAdded: (focus?: EndpointDetailFocus) => void;
  readonly onClose: () => void;
};

/**
 * Add endpoint, one step at a time: the kind, then its address and key, then
 * which of its models to use, a tool check for each, and optionally agent
 * work for the verified ones. The endpoint exists from the Connect step on,
 * so closing the dialog at any later step keeps it; a failed check never
 * stops it being added.
 */
export function AddEndpointFlow(props: AddEndpointFlowProps) {
  const [step, setStepState] = useState<AddEndpointStep>("kind");
  const [kind, setKind] = useState<EndpointKind>("openai-compatible");
  const [chosen, setChosen] = useState<ReadonlyArray<ProviderModelId>>([]);
  const [checks, setChecks] = useState<Readonly<Record<string, ToolCheck>>>({});
  const { onStepChange } = props;
  const setStep = (next: AddEndpointStep) => {
    setStepState(next);
    onStepChange?.(next);
  };
  const added = props.added;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Each step moves focus to its own heading, so a screen reader hears
    // where the flow went rather than staying on a button that is gone.
    if (step !== "kind") headingRef.current?.focus();
  }, [step]);

  let body: ReactNode;
  if (step === "kind") {
    body = (
      <KindStep
        headingRef={headingRef}
        onChoose={(next) => {
          setKind(next);
          setStep("connect");
        }}
        signIns={props.signIns}
      />
    );
  } else if (step === "connect") {
    body = (
      <ConnectStep
        {...props}
        headingRef={headingRef}
        kind={kind}
        onBack={() => setStep("kind")}
        onContinue={() => setStep("models")}
        onKindChange={setKind}
      />
    );
  } else if (added === undefined) {
    body = null;
  } else if (step === "models") {
    body = (
      <ModelsStep
        {...props}
        added={added}
        headingRef={headingRef}
        onContinue={(models) => {
          setChosen(models);
          setChecks({});
          setStep(models.length === 0 ? "done" : "verify");
        }}
        onSkip={() => setStep("done")}
      />
    );
  } else if (step === "verify") {
    body = (
      <VerifyStep
        {...props}
        added={added}
        checks={checks}
        chosen={chosen}
        headingRef={headingRef}
        onChecks={setChecks}
        onContinue={() => setStep("agents")}
      />
    );
  } else if (step === "agents") {
    body = (
      <AgentsStep
        {...props}
        added={added}
        checks={checks}
        chosen={chosen}
        headingRef={headingRef}
        onDone={() => setStep("done")}
      />
    );
  } else {
    body = (
      <DoneStep
        added={added}
        checks={checks}
        chosen={chosen}
        headingRef={headingRef}
        onClose={props.onClose}
        onOpenAdded={props.onOpenAdded}
      />
    );
  }

  return (
    <div className="endpoint-flow">
      {step === "done" ? null : <FlowSteps current={step} />}
      {body}
    </div>
  );
}

function FlowSteps(props: { readonly current: AddEndpointStep }) {
  const index = STEP_NAMES.findIndex((entry) => entry.step === props.current);
  return (
    <ol aria-label="Steps" className="endpoint-flow__steps">
      {STEP_NAMES.map((entry, position) => (
        <li
          {...(position === index ? { "aria-current": "step" as const } : {})}
          className="endpoint-flow__step"
          data-state={position < index ? "done" : position === index ? "current" : "next"}
          key={entry.step}
        >
          <span aria-hidden="true" className="endpoint-flow__step-number">
            {position + 1}
          </span>
          <span className="endpoint-flow__step-name">{entry.name}</span>
        </li>
      ))}
    </ol>
  );
}

type HeadingRef = RefObject<HTMLHeadingElement | null>;

function StepHeading(props: {
  readonly headingRef: HeadingRef;
  readonly children: ReactNode;
  readonly detail?: ReactNode;
}) {
  return (
    <div className="endpoint-flow__head">
      <h3 className="endpoint-flow__title" ref={props.headingRef} tabIndex={-1}>
        {props.children}
      </h3>
      {props.detail === undefined ? null : <p className="endpoint-flow__detail">{props.detail}</p>}
    </div>
  );
}

function KindMark(props: { readonly kind: EndpointKind }) {
  return (
    <span aria-hidden="true" className="endpoint-mark">
      {props.kind === "openai-compatible" ? (
        <Globe size={16} />
      ) : props.kind === "anthropic-compatible" ? (
        <MessagesSquare size={16} />
      ) : (
        <ProviderGlyph
          displayName={endpointKindPresentation(props.kind).title}
          driverKind={props.kind}
          size={16}
        />
      )}
    </span>
  );
}

function KindStep(props: {
  readonly headingRef: HeadingRef;
  readonly signIns: ReactNode;
  readonly onChoose: (kind: EndpointKind) => void;
}) {
  return (
    <>
      {props.signIns}
      <StepHeading headingRef={props.headingRef}>Or connect one by its address</StepHeading>
      <ul aria-label="Kinds of endpoint" className="endpoint-kinds">
        {ENDPOINT_KINDS.map((entry) => (
          <li key={entry.kind}>
            <OctantButton
              className="endpoint-kind"
              onClick={() => props.onChoose(entry.kind)}
              type="button"
              variant="bare"
            >
              <KindMark kind={entry.kind} />
              <span className="endpoint-kind__text">
                <span className="endpoint-kind__name">{entry.title}</span>
                <span className="endpoint-kind__detail">{entry.detail}</span>
              </span>
            </OctantButton>
          </li>
        ))}
      </ul>
    </>
  );
}

const EMPTY_CREDENTIAL: TransientProviderCredential = { value: "", clear: () => undefined };

function credentialFrom(input: HTMLInputElement | null): TransientProviderCredential {
  return {
    value: input?.value ?? "",
    clear: () => {
      if (input !== null) input.value = "";
    },
  };
}

type ConnectStepProps = AddEndpointFlowProps & {
  readonly headingRef: HeadingRef;
  readonly kind: EndpointKind;
  readonly onKindChange: (kind: EndpointKind) => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
};

function ConnectStep(props: ConnectStepProps) {
  const presentation = endpointKindPresentation(props.kind);
  const [name, setName] = useState(presentation.defaultName ?? "");
  const [url, setUrl] = useState(presentation.defaultUrl ?? "");
  const [noKey, setNoKey] = useState(false);
  const [keyHeader, setKeyHeader] = useState<"api-key" | "bearer">("api-key");
  const [protocol, setProtocol] = useState("auto");
  const [protocolVersion, setProtocolVersion] = useState("2023-06-01");
  const [deployments, setDeployments] = useState<ReadonlyArray<ProviderModelId>>([]);
  const [problem, setProblem] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const credentialInput = useRef<HTMLInputElement>(null);
  const ids = useId();
  const added = props.added;

  if (added !== undefined) {
    const { status } = added;
    const failing = status.tone === "failed";
    return (
      <>
        <StepHeading headingRef={props.headingRef}>Added {added.instance.displayName}</StepHeading>
        <div aria-live="polite" className="endpoint-add__result">
          <p className="endpoint-add__result-head">
            <EndpointState status={status} />
          </p>
          {status.sentence === undefined ? null : <p>{status.sentence}</p>}
          {status.tone === "checking" ? null : (
            <p className="endpoint-flow__detail">
              {failing
                ? "It's added, and you can fix it now or later from its page. You can still choose its models."
                : "Next, choose the models you want to use."}
            </p>
          )}
        </div>
        <div className="endpoint-flow__actions">
          {status.fix?.kind === "try-again" ? (
            <OctantButton
              onClick={() => void props.onProbe(added.instance.id, { quiet: true })}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </OctantButton>
          ) : failing && status.fix !== undefined ? (
            <OctantButton
              onClick={() => props.onOpenAdded(focusForFix(status))}
              size="sm"
              type="button"
              variant="outline"
            >
              Open details to fix
            </OctantButton>
          ) : null}
          <OctantButton
            disabled={status.tone === "checking"}
            onClick={props.onContinue}
            size="sm"
            type="button"
          >
            Continue
          </OctantButton>
        </div>
      </>
    );
  }

  const keysHere = props.credentialManagementAvailable;
  const takesKey = presentation.key !== "none" && !noKey;
  const azureSuggested = props.kind === "openai-compatible" && looksLikeAzureFoundry(url);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (trimmedName.length === 0) return setProblem("Give it a name.");
    if (trimmedUrl.length === 0) return setProblem("Enter its address.");
    const credential =
      keysHere && takesKey ? credentialFrom(credentialInput.current) : EMPTY_CREDENTIAL;
    if (props.kind === "azure-foundry" && keysHere && credential.value.length === 0) {
      return setProblem("Enter the Azure AI Foundry API key.");
    }
    // Azure lists base models, not deployments, so the host needs at least
    // one deployment name before it can add the endpoint.
    if (props.kind === "azure-foundry" && deployments.length === 0) {
      return setProblem("Name at least one deployment.");
    }
    setProblem(undefined);
    setSubmitting(true);
    let operation: Promise<boolean>;
    if (props.kind === "ollama") {
      operation = props.onCreateOllama(trimmedName, {
        kind: "ollama-native-http",
        baseUrl: trimmedUrl,
      });
    } else if (props.kind === "azure-foundry") {
      operation = props.onCreateAzureFoundry(
        trimmedName,
        {
          kind: "azure-foundry-openai-http",
          baseUrl: trimmedUrl,
          authentication: "api-key",
          protocol: protocol as "auto" | "responses" | "chat-completions",
          manualModelIds: deployments,
        },
        credential,
      );
    } else if (props.kind === "anthropic-compatible") {
      operation = props.onCreateAnthropicCompatible(
        trimmedName,
        {
          kind: "anthropic-compatible-http",
          baseUrl: trimmedUrl,
          authentication: noKey ? "none" : keyHeader,
          protocol: protocol === "messages" ? "messages" : "auto",
          protocolVersion: protocolVersion.trim() || "2023-06-01",
          manualModelIds: [],
        },
        credential,
      );
    } else {
      operation = props.onCreateOpenAiCompatible(
        trimmedName,
        {
          kind: "openai-compatible-http",
          baseUrl: trimmedUrl,
          authentication: noKey ? "none" : "bearer",
          protocol: protocol as "auto" | "responses" | "chat-completions",
          manualModelIds: [],
        },
        credential,
      );
    }
    void operation.finally(() => setSubmitting(false));
  };

  return (
    <form
      aria-label={`Connect ${presentation.title}`}
      className="endpoint-flow__form"
      noValidate
      onSubmit={submit}
    >
      <StepHeading detail={presentation.detail} headingRef={props.headingRef}>
        <KindMark kind={props.kind} /> {presentation.title}
      </StepHeading>
      <div className="endpoint-flow__field">
        <label htmlFor={`${ids}-name-input`}>Name</label>
        <OctantInput
          aria-describedby={`${ids}-name`}
          className="settings-view__text-input"
          id={`${ids}-name-input`}
          name="displayName"
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <span className="endpoint-flow__hint" id={`${ids}-name`}>
          How it appears in the model picker.
        </span>
      </div>
      <div className="endpoint-flow__field">
        <label htmlFor={`${ids}-url-input`}>{presentation.urlLabel}</label>
        <OctantInput
          aria-describedby={`${ids}-url`}
          className="settings-view__text-input"
          id={`${ids}-url-input`}
          inputMode="url"
          name="baseUrl"
          onChange={(event) => setUrl(event.currentTarget.value)}
          placeholder={presentation.urlPlaceholder}
          spellCheck={false}
          type="url"
          value={url}
        />
        <span className="endpoint-flow__hint" id={`${ids}-url`}>
          {presentation.urlHint}
        </span>
      </div>
      {azureSuggested ? (
        <OctantAlert
          action={
            <OctantButton
              onClick={() => {
                props.onKindChange("azure-foundry");
                setUrl(azureFoundryBaseUrl(url));
                setNoKey(false);
                setProtocol("auto");
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Switch to Azure AI Foundry
            </OctantButton>
          }
          testId="endpoint-azure-suggestion"
          title="This looks like an Azure AI Foundry address"
          tone="accent"
        >
          Azure needs its own kind: it sends the key as an api-key header and lists your deployments
          by name.
        </OctantAlert>
      ) : null}
      {presentation.key === "none" || noKey ? null : keysHere ? (
        <div className="endpoint-flow__field">
          <label htmlFor={`${ids}-key-input`}>API key</label>
          <OctantInput
            aria-describedby={`${ids}-key`}
            autoComplete="new-password"
            className="settings-view__text-input"
            id={`${ids}-key-input`}
            name="credential"
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
          <span className="endpoint-flow__hint" id={`${ids}-key`}>
            {presentation.key === "required"
              ? "Saved in this Mac's Keychain. Octant can't show it again."
              : "Saved in this Mac's Keychain. For a server that takes no key, choose that under Advanced."}
          </span>
        </div>
      ) : (
        <div className="endpoint-flow__field">
          <span>API key</span>
          <p className="endpoint-flow__note" data-testid="endpoint-key-later">
            This browser can't store keys. Add it now and it shows Needs key; then add the key in
            the Octant desktop app on this Mac.
            {presentation.key === "optional"
              ? " A server that takes no key works from here: choose that under Advanced."
              : null}
          </p>
        </div>
      )}
      {props.kind === "azure-foundry" ? (
        <DeploymentChips deployments={deployments} onChange={setDeployments} />
      ) : null}
      {props.kind === "ollama" ? null : (
        <SettingsDisclosure title="Advanced" variant="inline">
          <div className="endpoint-flow__advanced">
            <div className="endpoint-flow__field">
              <span>Protocol</span>
              <OctantSelectField
                aria-label="Protocol"
                className="settings-view__select"
                onValueChange={setProtocol}
                options={
                  props.kind === "anthropic-compatible"
                    ? [
                        { id: "auto", label: "Automatic" },
                        { id: "messages", label: "Messages" },
                      ]
                    : [
                        { id: "auto", label: "Automatic" },
                        { id: "responses", label: "Responses" },
                        { id: "chat-completions", label: "Chat Completions" },
                      ]
                }
                value={protocol}
              />
              <span className="endpoint-flow__hint">
                Automatic picks what the service supports. Change it only if a check fails.
              </span>
            </div>
            {props.kind === "anthropic-compatible" ? (
              <>
                <div className="endpoint-flow__field">
                  <span>How the key is sent</span>
                  <OctantSelectField
                    aria-label="How the key is sent"
                    className="settings-view__select"
                    onValueChange={(value) =>
                      setKeyHeader(value === "bearer" ? "bearer" : "api-key")
                    }
                    options={[
                      { id: "api-key", label: "x-api-key header" },
                      { id: "bearer", label: "Bearer token" },
                    ]}
                    value={keyHeader}
                  />
                </div>
                <label className="endpoint-flow__field">
                  <span>Anthropic API version</span>
                  <OctantInput
                    aria-label="Anthropic API version"
                    className="settings-view__text-input"
                    onChange={(event) => setProtocolVersion(event.currentTarget.value)}
                    value={protocolVersion}
                  />
                </label>
              </>
            ) : null}
            {presentation.key === "optional" ? (
              <label className="endpoint-flow__check">
                <OctantCheckbox
                  aria-describedby={`${ids}-no-key`}
                  checked={noKey}
                  onChange={(event) => setNoKey(event.currentTarget.checked)}
                />
                <span>
                  <span>It takes no key</span>
                  <span className="endpoint-flow__hint" id={`${ids}-no-key`}>
                    Only for a server on this computer, such as one at 127.0.0.1.
                  </span>
                </span>
              </label>
            ) : null}
          </div>
        </SettingsDisclosure>
      )}
      {props.kind === "openai-compatible" ? (
        <SettingsDisclosure title="Connecting Amazon Bedrock?" variant="inline">
          <BedrockMantleGuide />
        </SettingsDisclosure>
      ) : null}
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <div className="endpoint-flow__actions">
        <OctantButton onClick={props.onBack} size="sm" type="button" variant="ghost">
          Back
        </OctantButton>
        <OctantButton disabled={props.busy || submitting} size="sm" type="submit">
          {submitting ? "Adding…" : "Check and add"}
        </OctantButton>
      </div>
    </form>
  );
}

function focusForFix(status: EndpointStatus): EndpointDetailFocus | undefined {
  const kind = status.fix?.kind;
  if (kind === "replace-key" || kind === "add-key") return "key";
  if (kind === "edit-address") return "address";
  if (kind === "add-model-ids") return "model-ids";
  return undefined;
}

type ModelsStepProps = AddEndpointFlowProps & {
  readonly added: AddedEndpoint;
  readonly headingRef: HeadingRef;
  readonly onContinue: (models: ReadonlyArray<ProviderModelId>) => void;
  readonly onSkip: () => void;
};

function ModelsStep(props: ModelsStepProps) {
  const { instance, observed } = props.added;
  if (instance.driverKind === "azure-foundry") return <DeploymentsStep {...props} />;
  return <CatalogueStep {...props} key={observed === undefined ? "unlisted" : "listed"} />;
}

function manualIdsOf(instance: ModelEndpointInstance): ReadonlyArray<ProviderModelId> {
  return instance.configuration.kind === "ollama-native-http"
    ? []
    : instance.configuration.manualModelIds;
}

/** Saves model IDs typed in the flow, then checks the endpoint so its list includes them. */
async function saveModelIds(
  props: AddEndpointFlowProps,
  instance: ModelEndpointInstance,
  ids: ReadonlyArray<ProviderModelId>,
): Promise<boolean> {
  const current = manualIdsOf(instance).map(String);
  if (ids.length === current.length && ids.every((id, index) => String(id) === current[index])) {
    return true;
  }
  let saved = false;
  if (instance.driverKind === "azure-foundry") {
    saved = await props.onChangeAzureFoundryConfiguration(
      instance.id,
      { ...instance.configuration, manualModelIds: ids },
      EMPTY_CREDENTIAL,
    );
  } else if (instance.driverKind === "openai-compatible") {
    saved = await props.onChangeOpenAiCompatibleConfiguration(
      instance.id,
      { ...instance.configuration, manualModelIds: ids },
      EMPTY_CREDENTIAL,
    );
  } else if (instance.driverKind === "anthropic-compatible") {
    saved = await props.onChangeAnthropicCompatibleConfiguration(
      instance.id,
      { ...instance.configuration, manualModelIds: ids },
      EMPTY_CREDENTIAL,
    );
  }
  if (saved) await props.onProbe(instance.id, { quiet: true });
  return saved;
}

/**
 * Azure deployment names as chips. A name typed but not yet confirmed is
 * added when the field loses focus, so it is never silently dropped.
 */
function DeploymentChips(props: {
  readonly deployments: ReadonlyArray<ProviderModelId>;
  readonly onChange: (deployments: ReadonlyArray<ProviderModelId>) => void;
}) {
  const [draft, setDraft] = useState("");
  const ids = useId();
  const addDraft = () => {
    const next = parseManualModelIds(draft).filter(
      (id) => !props.deployments.some((existing) => String(existing) === String(id)),
    );
    setDraft("");
    if (next.length > 0) props.onChange([...props.deployments, ...next]);
  };
  return (
    <div className="endpoint-flow__field">
      <label htmlFor={`${ids}-input`}>Deployments</label>
      {props.deployments.length === 0 ? null : (
        <ul aria-label="Deployments" className="endpoint-chips">
          {props.deployments.map((deployment) => (
            <li className="endpoint-chip" key={String(deployment)}>
              <span className="endpoint-chip__label">{String(deployment)}</span>
              <OctantButton
                aria-label={`Remove deployment ${String(deployment)}`}
                onClick={() =>
                  props.onChange(
                    props.deployments.filter((entry) => String(entry) !== String(deployment)),
                  )
                }
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" size={12} />
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
      <div className="endpoint-flow__add-row">
        <OctantInput
          aria-describedby={`${ids}-hint`}
          aria-label="Deployment name"
          className="settings-view__text-input"
          id={`${ids}-input`}
          onBlur={addDraft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addDraft();
            }
          }}
          placeholder="my-gpt-deployment"
          spellCheck={false}
          value={draft}
        />
        <OctantButton
          disabled={draft.trim().length === 0}
          onClick={addDraft}
          size="sm"
          type="button"
          variant="outline"
        >
          Add deployment
        </OctantButton>
      </div>
      <span className="endpoint-flow__hint" id={`${ids}-hint`}>
        The names you gave your deployments in Azure, not the base model names. Press Enter after
        each.
      </span>
    </div>
  );
}

function DeploymentsStep(props: ModelsStepProps) {
  const { instance } = props.added;
  const [deployments, setDeployments] = useState<ReadonlyArray<ProviderModelId>>(
    manualIdsOf(instance),
  );
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  return (
    <>
      <StepHeading
        detail="Azure lists base models, not your deployments. Add any other deployment you want to use; the first is listed first in the model picker."
        headingRef={props.headingRef}
      >
        Deployments
      </StepHeading>
      <DeploymentChips deployments={deployments} onChange={setDeployments} />
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <ModelsActions
        busy={props.busy || saving}
        count={deployments.length}
        kind="azure-foundry"
        onContinue={() => {
          setSaving(true);
          void saveModelIds(props, instance, deployments)
            .then((saved) => {
              if (saved) props.onContinue(deployments);
              else setProblem("Octant couldn't save the deployments. Try again.");
            })
            .finally(() => setSaving(false));
        }}
        onSkip={props.onSkip}
      />
    </>
  );
}

function CatalogueStep(props: ModelsStepProps) {
  const { instance, observed, checking } = props.added;
  const local = instance.driverKind === "ollama";
  const catalogue = observed?.models ?? [];
  const [query, setQuery] = useState("");
  // A short list starts with every model chosen; a long catalogue starts with
  // none, so the person picks the few they use rather than hiding hundreds.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(catalogue.length <= 8 ? catalogue.map((model) => String(model.id)) : []),
  );
  const [typedIds, setTypedIds] = useState<ReadonlyArray<ProviderModelId>>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const ids = useId();
  const searchable = catalogue.length > 8;
  const { listed, more } = modelsToList(catalogue, searchable ? query : "", chosen);
  const toggle = (modelId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(modelId);
    else next.delete(modelId);
    setChosen(next);
  };
  const addById = () => {
    const next = parseManualModelIds(draft).filter(
      (id) =>
        !typedIds.some((existing) => String(existing) === String(id)) &&
        !catalogue.some((model) => String(model.id) === String(id)),
    );
    const listedMatches = parseManualModelIds(draft).filter((id) =>
      catalogue.some((model) => String(model.id) === String(id)),
    );
    setTypedIds([...typedIds, ...next]);
    setChosen(new Set([...chosen, ...[...next, ...listedMatches].map(String)]));
    setDraft("");
  };
  const picks = [
    ...catalogue.filter((model) => chosen.has(String(model.id))).map((model) => model.id),
    ...typedIds.filter((id) => chosen.has(String(id))),
  ];
  const finish = async (): Promise<void> => {
    const manual = [
      ...manualIdsOf(instance),
      ...typedIds.filter(
        (id) =>
          chosen.has(String(id)) &&
          !manualIdsOf(instance).some((existing) => String(existing) === String(id)),
      ),
    ];
    if (!(await saveModelIds(props, instance, manual))) {
      setProblem("Octant couldn't save the model IDs. Try again.");
      return;
    }
    // Models left unchosen stay out of the model picker; the endpoint's page
    // can show them again.
    const others: ReadonlyArray<HiddenProviderModelRef> = (
      props.defaults.hiddenModels ?? []
    ).filter((ref) => String(ref.providerInstanceId) !== String(instance.id));
    const hidden = catalogue
      .filter((model) => !chosen.has(String(model.id)))
      .map((model) => ({ providerInstanceId: instance.id, modelId: model.id }));
    const priorHidden = (props.defaults.hiddenModels ?? []).filter(
      (ref) => String(ref.providerInstanceId) === String(instance.id),
    );
    if (hidden.length > 0 || priorHidden.length > 0) {
      await props.onHiddenModelsChange([...others, ...hidden]);
    }
    props.onContinue(picks);
  };

  let list: ReactNode;
  if (checking && catalogue.length === 0) {
    list = (
      <p className="endpoint-flow__note" role="status">
        Checking which models it lists…
      </p>
    );
  } else if (catalogue.length === 0 && typedIds.length === 0) {
    list = (
      <p className="endpoint-flow__note">
        {local
          ? "Ollama lists no installed models. Install one with ollama pull, then check again."
          : "It lists no models yet. Add the IDs of the models you use below."}
      </p>
    );
  } else {
    list = (
      <>
        {searchable ? (
          <OctantInput
            aria-label={`Search ${catalogue.length} models`}
            className="endpoint-models__search"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={`Search ${catalogue.length} models`}
            type="search"
            value={query}
          />
        ) : null}
        <ul aria-label={local ? "Installed models" : "Models"} className="endpoint-pick">
          {listed.map((model) => (
            <li key={String(model.id)}>
              <label className="endpoint-flow__check">
                <OctantCheckbox
                  checked={chosen.has(String(model.id))}
                  onChange={(event) => toggle(String(model.id), event.currentTarget.checked)}
                />
                <span className="endpoint-pick__name">{model.displayName}</span>
                {model.inputModalities.includes("image") ? (
                  <span className="endpoint-tag">Reads images</span>
                ) : null}
              </label>
            </li>
          ))}
          {typedIds.map((id) => (
            <li key={`typed-${String(id)}`}>
              <label className="endpoint-flow__check">
                <OctantCheckbox
                  checked={chosen.has(String(id))}
                  onChange={(event) => toggle(String(id), event.currentTarget.checked)}
                />
                <span className="endpoint-pick__name">{String(id)}</span>
                <span className="endpoint-tag">Added by ID</span>
              </label>
            </li>
          ))}
        </ul>
        {more === 0 ? null : (
          <p className="endpoint-flow__hint" role="status">
            {more} more {more === 1 ? "matches" : "match"}. Search to narrow the list.
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <StepHeading
        detail={
          local
            ? "The models installed in Ollama on this computer. Chosen ones appear in the model picker."
            : "Chosen models appear in the model picker. The rest stay hidden until you show them from the endpoint's page."
        }
        headingRef={props.headingRef}
      >
        {local ? "Installed models" : "Models"}
      </StepHeading>
      {list}
      {local ? (
        catalogue.length === 0 && !checking ? (
          <div className="endpoint-flow__actions">
            <OctantButton
              onClick={() => void props.onProbe(instance.id, { quiet: true })}
              size="sm"
              type="button"
              variant="outline"
            >
              Check again
            </OctantButton>
          </div>
        ) : null
      ) : (
        <div className="endpoint-flow__add-row">
          <OctantInput
            aria-describedby={`${ids}-by-id`}
            aria-label="Model ID"
            className="settings-view__text-input"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addById();
              }
            }}
            placeholder="vendor/model-name"
            spellCheck={false}
            value={draft}
          />
          <OctantButton
            disabled={draft.trim().length === 0}
            onClick={addById}
            size="sm"
            type="button"
            variant="outline"
          >
            Add by ID
          </OctantButton>
          <span className="endpoint-flow__hint" id={`${ids}-by-id`}>
            For a model the service serves but doesn't list.
          </span>
        </div>
      )}
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <ModelsActions
        busy={props.busy || saving || checking}
        count={picks.length}
        kind={instance.driverKind}
        onContinue={() => {
          setSaving(true);
          void finish().finally(() => setSaving(false));
        }}
        onSkip={props.onSkip}
      />
    </>
  );
}

function ModelsActions(props: {
  readonly busy: boolean;
  readonly count: number;
  readonly kind: ModelEndpointInstance["driverKind"];
  readonly onContinue: () => void;
  readonly onSkip: () => void;
}) {
  const requests = props.kind === "ollama" ? 0 : props.count;
  return (
    <>
      {props.count === 0 ? (
        <p className="endpoint-flow__hint" role="status">
          Choose at least one {props.kind === "azure-foundry" ? "deployment" : "model"} to go on, or
          skip for now.
        </p>
      ) : null}
      {requests === 0 ? null : (
        <p className="endpoint-flow__hint">
          Next, Octant checks each model can use its tools: one short request per model, which the
          service may bill.
        </p>
      )}
      <div className="endpoint-flow__actions">
        <OctantButton onClick={props.onSkip} size="sm" type="button" variant="ghost">
          Skip for now
        </OctantButton>
        <OctantButton
          disabled={props.busy || props.count === 0}
          onClick={props.onContinue}
          size="sm"
          type="button"
        >
          {requests === 0
            ? "Continue"
            : `Continue and verify tools (${requests} ${requests === 1 ? "request" : "requests"})`}
        </OctantButton>
      </div>
    </>
  );
}

const OLLAMA_CHAT_ONLY =
  "Octant's tools don't run through Ollama yet, so its models answer in chat only.";

function keyMissingReason(keysHere: boolean): string {
  return keysHere
    ? "No API key is saved for it yet. Add one, then retry."
    : "It needs its API key, which you add in the Octant desktop app.";
}

/** Why a tool check left a model Chat only, in words that say what to do. */
export function chatOnlyReason(check: ModelToolCheck, keysHere: boolean): string {
  if (check.outcome !== "failed") {
    return check.outcome === "unsupported" ? "It answered without calling Octant's test tool." : "";
  }
  const failure: ProviderProbeFailure | undefined = check.failure;
  if (failure === undefined) return "The check didn't finish.";
  if (
    failure.category === "unauthenticated" ||
    failure.category === "unauthorized" ||
    failure.reason === "authentication-required"
  ) {
    return keysHere
      ? "The service turned down the key, or no key is saved."
      : keyMissingReason(false);
  }
  if (failure.category === "rate-limited") return "The service is limiting requests right now.";
  if (failure.category === "unavailable" || failure.category === "interrupted") {
    return "The service didn't answer the check.";
  }
  return failure.message;
}

type VerifyStepProps = AddEndpointFlowProps & {
  readonly added: AddedEndpoint;
  readonly headingRef: HeadingRef;
  readonly chosen: ReadonlyArray<ProviderModelId>;
  readonly checks: Readonly<Record<string, ToolCheck>>;
  readonly onChecks: (
    update: (current: Readonly<Record<string, ToolCheck>>) => Readonly<Record<string, ToolCheck>>,
  ) => void;
  readonly onContinue: () => void;
};

function VerifyStep(props: VerifyStepProps) {
  const { instance } = props.added;
  const local = instance.driverKind === "ollama";
  const mounted = useRef(true);
  const started = useRef(false);
  const { onChecks } = props;
  const set = (modelId: ProviderModelId, check: ToolCheck) => {
    if (mounted.current) onChecks((current) => ({ ...current, [String(modelId)]: check }));
  };
  const run = async (modelId: ProviderModelId): Promise<void> => {
    set(modelId, { kind: "running" });
    const check: ModelToolCheck =
      props.onCheckModelTools === undefined
        ? await props
            .onVerifyModelTools(instance.id, modelId)
            .then((outcome): ModelToolCheck => ({ outcome }))
        : await props.onCheckModelTools(instance.id, modelId);
    // The host answers a check on a keyless endpoint with a generic failure,
    // so the endpoint's own Needs key state names the reason instead.
    const keyMissing = check.outcome === "failed" && props.added.status.label === NEEDS_KEY_LABEL;
    set(
      modelId,
      check.outcome === "supported"
        ? { kind: "verified" }
        : {
            kind: "chat-only",
            reason: keyMissing
              ? keyMissingReason(props.credentialManagementAvailable)
              : chatOnlyReason(check, props.credentialManagementAvailable),
            retry: true,
          },
    );
  };

  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      const verified = new Set((props.added.observed?.verifiedToolModelIds ?? []).map(String));
      // One request at a time, in the order the models were chosen; a model
      // already verified needs none.
      void (async () => {
        for (const modelId of props.chosen) {
          if (local) {
            // The step says once why every Ollama model is Chat only.
            set(modelId, { kind: "chat-only", reason: "", retry: false });
          } else if (verified.has(String(modelId))) {
            set(modelId, { kind: "verified" });
          } else {
            set(modelId, { kind: "waiting" });
          }
        }
        if (local) return;
        for (const modelId of props.chosen) {
          if (!mounted.current) return;
          if (verified.has(String(modelId))) continue;
          await run(modelId);
        }
      })();
    }
    return () => {
      mounted.current = false;
    };
    // The checks start once, when the step opens; Retry runs one again.
  }, []);

  const states = props.chosen.map((modelId) => props.checks[String(modelId)]);
  const running = states.some((check) => check?.kind === "running" || check?.kind === "waiting");
  const verifiedCount = states.filter((check) => check?.kind === "verified").length;
  const nameOf = (modelId: ProviderModelId) =>
    props.added.observed?.models.find((model) => String(model.id) === String(modelId))
      ?.displayName ?? String(modelId);
  return (
    <>
      <StepHeading
        detail={
          local
            ? OLLAMA_CHAT_ONLY
            : "Octant gives its tools only to a model it has seen call one. A model that doesn't is still added, for chat."
        }
        headingRef={props.headingRef}
      >
        Verify tools
      </StepHeading>
      <ul aria-label="Tool checks" className="endpoint-verify">
        {props.chosen.map((modelId) => {
          const check = props.checks[String(modelId)];
          const name = nameOf(modelId);
          return (
            <li className="endpoint-verify__row" key={String(modelId)}>
              <span className="endpoint-verify__name">{name}</span>
              <span aria-live="polite" className="endpoint-verify__state">
                {check === undefined || check.kind === "waiting" ? (
                  <span className="endpoint-state" data-tone="unchecked">
                    <span aria-hidden="true" className="endpoint-state__dot" />
                    Waiting
                  </span>
                ) : check.kind === "running" ? (
                  <span className="endpoint-state" data-tone="checking">
                    <span aria-hidden="true" className="endpoint-state__dot" />
                    Checking…
                  </span>
                ) : check.kind === "verified" ? (
                  <span className="endpoint-state" data-tone="ready">
                    <span aria-hidden="true" className="endpoint-state__dot" />
                    Verified
                  </span>
                ) : (
                  <>
                    <span className="chat-only-verify">
                      <span className="chat-only-verify__label">Chat only</span>
                      {check.retry ? (
                        <>
                          <span aria-hidden="true" className="chat-only-verify__separator">
                            ·
                          </span>
                          <OctantButton
                            aria-label={`Retry the tool check for ${name}`}
                            disabled={running}
                            onClick={() => void run(modelId)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Retry
                          </OctantButton>
                        </>
                      ) : null}
                    </span>
                    {check.reason === "" ? null : (
                      <span className="endpoint-verify__reason">{check.reason}</span>
                    )}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="endpoint-flow__hint" role="status">
        {running
          ? "Checking one model at a time…"
          : `${verifiedCount} of ${props.chosen.length} verified for tools. Chat only models are added and answer in chat.`}
      </p>
      <div className="endpoint-flow__actions">
        <OctantButton disabled={running} onClick={props.onContinue} size="sm" type="button">
          Continue
        </OctantButton>
      </div>
    </>
  );
}

type AgentsStepProps = AddEndpointFlowProps & {
  readonly added: AddedEndpoint;
  readonly headingRef: HeadingRef;
  readonly chosen: ReadonlyArray<ProviderModelId>;
  readonly checks: Readonly<Record<string, ToolCheck>>;
  readonly onDone: () => void;
};

type RoutingState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly settings: NativeHarnessRoutingSettings }
  | { readonly kind: "unavailable"; readonly message: string };

function AgentsStep(props: AgentsStepProps) {
  const { instance, observed } = props.added;
  const eligible = new Set(
    (props.defaults.agentEligibleModels ?? [])
      .filter((ref) => String(ref.providerInstanceId) === String(instance.id))
      .map((ref) => String(ref.modelId)),
  );
  const [agentPicks, setAgentPicks] = useState<ReadonlySet<string>>(() => new Set());
  const [rolePicks, setRolePicks] = useState<Readonly<Record<string, string>>>({});
  const [routing, setRouting] = useState<RoutingState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const ids = useId();
  const rolesClient = props.roles?.client;
  const load = async () => {
    if (rolesClient === undefined) return;
    try {
      setRouting({ kind: "ready", settings: await rolesClient.routing() });
    } catch (error) {
      setRouting({
        kind: "unavailable",
        message:
          error instanceof NativeHarnessClientFailure
            ? error.message
            : "Model roles couldn't be read.",
      });
    }
  };
  useEffect(() => {
    void load();
    // Read once when the step opens; a stale save reads them again.
  }, []);

  const nameOf = (modelId: ProviderModelId | string) =>
    observed?.models.find((model) => String(model.id) === String(modelId))?.displayName ??
    String(modelId);
  const readsImages = (modelId: ProviderModelId) =>
    observed?.models
      .find((model) => String(model.id) === String(modelId))
      ?.inputModalities.includes("image") === true;
  const verified = props.chosen.filter((modelId) =>
    mayTakeAgentWork(props.checks[String(modelId)]),
  );
  const chatOnly = props.chosen.filter(
    (modelId) => !mayTakeAgentWork(props.checks[String(modelId)]),
  );

  const finish = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      const newlyEligible = verified.filter(
        (modelId) => agentPicks.has(String(modelId)) && !eligible.has(String(modelId)),
      );
      if (newlyEligible.length > 0) {
        const next: ReadonlyArray<AgentEligibleModelRef> = [
          ...(props.defaults.agentEligibleModels ?? []),
          ...newlyEligible.map((modelId) => ({ providerInstanceId: instance.id, modelId })),
        ];
        if (next.length > 16) {
          setProblem(
            "Helper agents can use at most 16 models. Remove some from Model roles first.",
          );
          return;
        }
        if (!(await props.onAgentEligibleModelsChange(next))) {
          setProblem("Octant couldn't save which models helper agents use. Try again.");
          return;
        }
      }
      const picks = Object.entries(rolePicks).filter(([, modelId]) => modelId !== "");
      if (picks.length > 0 && props.roles !== undefined && routing.kind === "ready") {
        const hostId = props.roles.hostId;
        let configuration = routing.settings.configuration;
        for (const [slotId, modelId] of picks) {
          const role = ASSIGNABLE_ROLES.find((entry) => String(entry.id) === slotId);
          const model = verified.find((entry) => String(entry) === modelId);
          if (role === undefined || model === undefined) continue;
          configuration = withFirstChoice(configuration, role.id, {
            hostId,
            providerInstanceId: instance.id,
            modelId: model,
          });
        }
        const result = await props.roles.client.updateRouting({
          configuration,
          expectedVersion: routing.settings.version,
        });
        if (result.kind === "routing-refused") {
          if (result.reason === "stale-version") {
            setProblem("Model roles changed elsewhere. Octant reloaded them; choose again.");
            setRolePicks({});
            await load();
          } else {
            setProblem(result.message);
          }
          return;
        }
        props.onRolesSaved?.();
      }
      props.onDone();
    } catch (error) {
      setProblem(
        error instanceof NativeHarnessClientFailure
          ? error.message
          : "Octant couldn't save the roles. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const currentFirst = (slotId: NativeHarnessSlotId): string | undefined => {
    if (routing.kind !== "ready") return undefined;
    const first = routing.settings.configuration.slots.find(
      (slot) => String(slot.id) === String(slotId),
    )?.candidates[0];
    if (first === undefined) return undefined;
    return String(first.providerInstanceId) === String(instance.id)
      ? nameOf(first.modelId)
      : String(first.modelId);
  };

  return (
    <>
      <StepHeading
        detail="Optional. Octant's agent can hand work to these models. Only models verified for tools can take it."
        headingRef={props.headingRef}
      >
        Agents
      </StepHeading>
      {verified.length === 0 ? (
        <p className="endpoint-flow__note">
          None of these models is verified for tools yet, so none can take agent work. You can
          verify tools later from the endpoint's page.
        </p>
      ) : null}
      <fieldset className="endpoint-flow__group">
        <legend>Helper agents</legend>
        <ul className="endpoint-pick">
          {props.chosen.map((modelId) => {
            const allowed = mayTakeAgentWork(props.checks[String(modelId)]);
            const already = eligible.has(String(modelId));
            return (
              <li key={String(modelId)}>
                <label className="endpoint-flow__check">
                  <OctantCheckbox
                    {...(allowed ? {} : { "aria-describedby": `${ids}-chat-only` })}
                    aria-label={`Helper agents can use ${nameOf(modelId)}`}
                    checked={already || agentPicks.has(String(modelId))}
                    disabled={!allowed || already || saving}
                    onChange={(event) => {
                      const next = new Set(agentPicks);
                      if (event.currentTarget.checked) next.add(String(modelId));
                      else next.delete(String(modelId));
                      setAgentPicks(next);
                    }}
                  />
                  <span className="endpoint-pick__name">{nameOf(modelId)}</span>
                  {allowed ? null : (
                    <span className="endpoint-tag" data-kind="chat-only">
                      Chat only
                    </span>
                  )}
                  {already ? <span className="endpoint-tag">Already used</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
        {chatOnly.length === 0 ? null : (
          <p className="endpoint-flow__hint" id={`${ids}-chat-only`}>
            Chat only models can't take agent work, not even jobs that send no tools. Verify tools
            first.
          </p>
        )}
      </fieldset>
      {props.roles === undefined || verified.length === 0 ? null : (
        <fieldset className="endpoint-flow__group">
          <legend>Octant Harness roles</legend>
          {routing.kind === "loading" ? (
            <p className="endpoint-flow__note" role="status">
              Reading Model roles…
            </p>
          ) : routing.kind === "unavailable" ? (
            <p className="endpoint-flow__note">{routing.message}</p>
          ) : (
            <>
              <p className="endpoint-flow__hint">
                A model you choose becomes the role's first choice; what the role had stays as its
                backup.
              </p>
              <div className="endpoint-roles">
                {ASSIGNABLE_ROLES.map((role) => {
                  const options = verified.filter(
                    (modelId) => role.needsImages !== true || readsImages(modelId),
                  );
                  if (options.length === 0) return null;
                  const current = currentFirst(role.id);
                  return (
                    <div className="endpoint-flow__field endpoint-roles__role" key={role.id}>
                      <span>{role.label}</span>
                      <OctantSelectField
                        aria-label={role.label}
                        className="settings-view__select"
                        disabled={saving}
                        onValueChange={(value) =>
                          setRolePicks({ ...rolePicks, [String(role.id)]: value })
                        }
                        options={[
                          {
                            id: "",
                            label: current === undefined ? "Leave as it is" : `Keep ${current}`,
                          },
                          ...options.map((modelId) => ({
                            id: String(modelId),
                            label: nameOf(modelId),
                          })),
                        ]}
                        value={rolePicks[String(role.id)] ?? ""}
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </fieldset>
      )}
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <div className="endpoint-flow__actions">
        <OctantButton
          disabled={saving}
          onClick={props.onDone}
          size="sm"
          type="button"
          variant="ghost"
        >
          Skip
        </OctantButton>
        <OctantButton disabled={saving} onClick={() => void finish()} size="sm" type="button">
          {saving ? "Saving…" : "Finish"}
        </OctantButton>
      </div>
    </>
  );
}

function DoneStep(props: {
  readonly added: AddedEndpoint;
  readonly headingRef: HeadingRef;
  readonly chosen: ReadonlyArray<ProviderModelId>;
  readonly checks: Readonly<Record<string, ToolCheck>>;
  readonly onOpenAdded: (focus?: EndpointDetailFocus) => void;
  readonly onClose: () => void;
}) {
  const verified = props.chosen.filter((modelId) =>
    mayTakeAgentWork(props.checks[String(modelId)]),
  ).length;
  const chatOnly = props.chosen.length - verified;
  return (
    <>
      <StepHeading headingRef={props.headingRef}>
        Added {props.added.instance.displayName}
      </StepHeading>
      <div aria-live="polite" className="endpoint-add__result">
        <p className="endpoint-add__result-head">
          <EndpointState status={props.added.status} />
        </p>
        {props.added.status.sentence === undefined ? null : <p>{props.added.status.sentence}</p>}
        {props.chosen.length === 0 ? null : (
          <p className="endpoint-flow__detail">
            {[
              `${props.chosen.length} ${props.chosen.length === 1 ? "model" : "models"} in the model picker`,
              verified === 0 ? undefined : `${verified} verified for tools`,
              chatOnly === 0 ? undefined : `${chatOnly} Chat only`,
            ]
              .filter((part): part is string => part !== undefined)
              .join(" · ")}
          </p>
        )}
      </div>
      <div className="endpoint-flow__actions">
        <OctantButton onClick={() => props.onOpenAdded()} size="sm" type="button" variant="outline">
          Open details
        </OctantButton>
        <OctantButton onClick={props.onClose} size="sm" type="button">
          Done
        </OctantButton>
      </div>
    </>
  );
}
