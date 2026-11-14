import {
  acpAgentConfigurationKind,
  isAcpAgentKind,
  type ClaudeAccountAccent,
  type ProviderInstance,
} from "@octant/contracts";
import { useMemo, useRef, useState } from "react";
import { hostCredentialStore, useHostPlatform } from "../../platform";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import { OctantInput } from "../../ui/base/OctantInput";
import { moveWithinRadioGroup } from "../../ui/base/radioGroupKeys";
import { ClaudeAccountAccentPicker } from "../configuration/ClaudeAccountFields";
import { claudeConfigurationFromFields } from "../configuration/claudeAccountValues";
import type { ProviderCreateProviderType } from "../configuration/ProviderCreateForm";
import { ProviderGlyph } from "../ProviderGlyph";
import { emptyTransientCredential, transientCredential } from "../ProviderSettingsCredentials";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";
import { WizardConnectStep, WizardDoneStep } from "./WizardConnectSteps";
import {
  detectedBinaryPath,
  suggestedProviderName,
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  wizardAuthentication,
  wizardProviderCards,
  wizardProviderName,
  wizardSignInChoices,
  type WizardStep,
} from "./addProviderWizardModel";
import "./add-provider-wizard.css";

export type AddProviderWizardProps = Pick<
  ProviderSettingsViewProps,
  | "busy"
  | "credentialManagementAvailable"
  | "instances"
  | "observedByInstance"
  | "probingIds"
  | "onCreate"
  | "onCreateClaude"
  | "onCreateAcpAgent"
  | "onProbe"
> & {
  readonly providerTypes: ReadonlyArray<ProviderCreateProviderType>;
  readonly discoverySnapshot: ProviderSettingsViewProps["discoverySnapshot"];
  /** The page's last provider message, said when the host refuses the add. */
  readonly message?: string;
  /** Opened from a provider card's "Add account": its provider and suggestions. */
  readonly preset?: {
    readonly providerType: ProviderCreateProviderType;
    readonly displayName: string;
    readonly binaryPath: string;
  };
  readonly onClose: () => void;
};

/**
 * One guided way to add a provider account, for every agent runtime. The
 * dialog keeps one size through every step; the steps scroll inside it. The
 * account is created by the Details step's "Add" and exists from the Connect
 * step on, so Cancel before that adds nothing.
 */
export function AddProviderWizard(props: AddProviderWizardProps) {
  const hostPlatform = useHostPlatform();
  const store = hostCredentialStore(hostPlatform);
  const [step, setStep] = useState<WizardStep>("provider");
  const [type, setType] = useState<ProviderCreateProviderType>(
    props.preset?.providerType ?? props.providerTypes[0] ?? "opencode",
  );
  const [choiceByType, setChoiceByType] = useState<Readonly<Record<string, string>>>({});
  const [name, setName] = useState(props.preset?.displayName ?? "");
  const [nameEdited, setNameEdited] = useState(props.preset !== undefined);
  // A card's own binary is the detected one unless it is a different path.
  const [binaryEdit, setBinaryEdit] = useState<string | undefined>(() =>
    props.preset === undefined ||
    props.preset.binaryPath === "" ||
    props.preset.binaryPath ===
      detectedBinaryPath(props.preset.providerType, props.instances, props.discoverySnapshot)
      ? undefined
      : props.preset.binaryPath,
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [accent, setAccent] = useState<ClaudeAccountAccent | "">("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const knownIds = useRef<ReadonlySet<string>>(new Set());
  const [createdName, setCreatedName] = useState<string | undefined>(undefined);
  const credentialInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const binaryInput = useRef<HTMLInputElement>(null);

  const cards = useMemo(
    () =>
      wizardProviderCards({
        types: props.providerTypes,
        instances: props.instances,
        snapshot: props.discoverySnapshot,
        credentialManagementAvailable: props.credentialManagementAvailable,
      }),
    [
      props.providerTypes,
      props.instances,
      props.discoverySnapshot,
      props.credentialManagementAvailable,
    ],
  );
  const providerName = wizardProviderName(type);
  const choices = wizardSignInChoices(type, store);
  const choice = choices.find((candidate) => candidate.id === choiceByType[type]) ?? choices[0];
  const detected = detectedBinaryPath(type, props.instances, props.discoverySnapshot);
  const binary = binaryEdit ?? detected ?? "";
  const hasAccount = type === "claude" || type === "codex";
  const shownName = nameEdited ? name : suggestedProviderName(type, props.instances);
  const selectedCard = cards.find((card) => card.type === type);
  const stepIndex = WIZARD_STEPS.indexOf(step);

  const validate = (target: WizardStep): string | undefined => {
    if (target === "provider" && selectedCard?.unavailable !== undefined) {
      return selectedCard.unavailable;
    }
    if (target === "sign-in" && choice?.needsKey === true) {
      if (!props.credentialManagementAvailable) {
        return `${providerName} needs an API key, and this browser cannot store one. Choose another sign-in or add it in the Octant desktop app.`;
      }
      if (isAcpAgentKind(type) && (credentialInput.current?.value ?? "") === "") {
        return `${choice.label} is required.`;
      }
    }
    return undefined;
  };

  const next = () => {
    const refusal = validate(step);
    if (refusal !== undefined) {
      setProblem(refusal);
      return;
    }
    setProblem(undefined);
    const following = WIZARD_STEPS[stepIndex + 1];
    if (following !== undefined) setStep(following);
  };

  const create = () => {
    const trimmedName = shownName.trim();
    if (trimmedName === "") {
      setProblem("Provider name is required.");
      nameInput.current?.focus();
      return;
    }
    if (binary.trim() === "") {
      setAdvancedOpen(true);
      setBinaryEdit(binaryEdit ?? "");
      setProblem(`${providerName} binary is required. Enter its path under Advanced.`);
      return;
    }
    setProblem(undefined);
    knownIds.current = new Set(props.instances.map((instance) => String(instance.id)));
    const authentication = wizardAuthentication(type, choice?.id ?? "");
    let operation: Promise<boolean>;
    if (type === "opencode" || type === "pi" || type === "oh-my-pi") {
      operation = props.onCreate(type, trimmedName, binary);
    } else if (type === "codex") {
      operation = props.onCreate(type, trimmedName, binary, ...(accent === "" ? [] : [accent]));
    } else if (type === "claude") {
      const entered = transientCredential(credentialInput.current);
      const apiKey = authentication.claude === "api-key";
      operation = props.onCreateClaude(
        trimmedName,
        claudeConfigurationFromFields({
          binaryPath: binary,
          authentication: authentication.claude ?? "subscription",
          accent,
        }),
        apiKey ? entered : emptyTransientCredential(entered),
      );
    } else if (isAcpAgentKind(type)) {
      const entered = transientCredential(credentialInput.current);
      operation = props.onCreateAcpAgent(
        trimmedName,
        {
          kind: acpAgentConfigurationKind(type),
          binaryPath: binary,
          ...(authentication.acp === undefined ? {} : { authentication: authentication.acp }),
        },
        authentication.acp === "api-key" ? entered : emptyTransientCredential(entered),
      );
    } else {
      setProblem(`${providerName} is added from its own settings page.`);
      return;
    }
    setCreating(true);
    void operation
      .then((ok) => {
        if (!ok) {
          setProblem(props.message ?? "Octant could not add this provider. Nothing was changed.");
          return;
        }
        if (credentialInput.current !== null) credentialInput.current.value = "";
        setCreatedName(trimmedName);
        setStep("connect");
      })
      .finally(() => setCreating(false));
  };

  // The new account is the one the list gained under the name just created.
  const created: ProviderInstance | undefined =
    createdName === undefined
      ? undefined
      : props.instances.find(
          (instance) =>
            !knownIds.current.has(String(instance.id)) && instance.displayName === createdName,
        );

  const onCard = step === "provider";
  const afterCreate = step === "connect" || step === "done";
  return (
    <OctantDialog
      className="add-provider-wizard"
      label="Add provider account"
      labelledBy="add-provider-wizard-title"
      onClose={props.onClose}
      open
    >
      <header className="add-provider-wizard__head">
        <h2 id="add-provider-wizard-title">Add provider account</h2>
        <ol aria-label="Steps" className="add-provider-wizard__steps">
          {WIZARD_STEPS.map((candidate, index) => (
            <li
              aria-current={candidate === step ? "step" : undefined}
              data-state={index < stepIndex ? "done" : candidate === step ? "current" : "todo"}
              key={candidate}
            >
              <span aria-hidden="true">{index + 1}</span>
              {WIZARD_STEP_LABELS[candidate]}
            </li>
          ))}
        </ol>
      </header>
      <div className="add-provider-wizard__body">
        <section hidden={!onCard}>
          <p className="add-provider-wizard__lead">Choose what to add an account for.</p>
          <div
            aria-label="Provider"
            className="add-provider-wizard__cards"
            onKeyDown={moveWithinRadioGroup}
            role="radiogroup"
          >
            {cards.map((card) => (
              <OctantButton
                aria-checked={type === card.type}
                aria-describedby={`wizard-card-${card.type}-detail`}
                className="add-provider-wizard__card"
                data-unavailable={card.unavailable === undefined ? undefined : "true"}
                key={card.type}
                onClick={() => {
                  setType(card.type);
                  setProblem(undefined);
                }}
                role="radio"
                type="button"
                variant="bare"
              >
                <ProviderGlyph driverKind={card.type} displayName={card.name} size={20} />
                <span className="add-provider-wizard__card-text">
                  <span className="add-provider-wizard__card-name">{card.name}</span>
                  <span
                    className="add-provider-wizard__card-detail"
                    id={`wizard-card-${card.type}-detail`}
                  >
                    {card.unavailable ??
                      `${card.description} ${card.found ? "Found on this computer." : "Not found on this computer yet."}`}
                  </span>
                </span>
              </OctantButton>
            ))}
          </div>
        </section>
        <section hidden={step !== "sign-in"}>
          <p className="add-provider-wizard__lead">How should {providerName} sign in?</p>
          <div
            aria-label="Sign-in"
            className="add-provider-wizard__cards"
            onKeyDown={moveWithinRadioGroup}
            role="radiogroup"
          >
            {choices.map((candidate) => (
              <OctantButton
                aria-checked={choice?.id === candidate.id}
                className="add-provider-wizard__card"
                key={candidate.id}
                onClick={() => {
                  setChoiceByType((current) => ({ ...current, [type]: candidate.id }));
                  if (!candidate.needsKey && credentialInput.current !== null) {
                    credentialInput.current.value = "";
                  }
                  setProblem(undefined);
                }}
                role="radio"
                type="button"
                variant="bare"
              >
                <span className="add-provider-wizard__card-text">
                  <span className="add-provider-wizard__card-name">{candidate.label}</span>
                  <span className="add-provider-wizard__card-detail">{candidate.detail}</span>
                </span>
              </OctantButton>
            ))}
          </div>
          {/* Mounted for every step so a typed key survives Back and Next; it
              is read from the field only when the account is created. */}
          <label className="add-provider-wizard__field" hidden={choice?.needsKey !== true}>
            <span>{choice?.label ?? "API key"}</span>
            <OctantInput
              aria-label={choice?.label ?? "API key"}
              autoComplete="new-password"
              disabled={!props.credentialManagementAvailable}
              ref={credentialInput}
              spellCheck={false}
              type="password"
            />
          </label>
          {choice?.needsKey === true && !props.credentialManagementAvailable ? (
            <p className="add-provider-wizard__hint">
              This browser cannot store API keys. Add the account in the Octant desktop app, or
              choose another sign-in.
            </p>
          ) : null}
        </section>
        <section hidden={step !== "details"}>
          <label className="add-provider-wizard__field">
            <span>Provider name</span>
            <OctantInput
              aria-label="Provider name"
              onChange={(event) => {
                setName(event.currentTarget.value);
                setNameEdited(true);
              }}
              ref={nameInput}
              value={shownName}
            />
          </label>
          {hasAccount ? (
            <div className="add-provider-wizard__field">
              <span>Account accent</span>
              <ClaudeAccountAccentPicker
                id="add-provider-wizard-accent"
                label="Account accent"
                onChange={setAccent}
                value={accent}
              />
              <span className="add-provider-wizard__hint">
                Shown as a color on this account in the model picker.
              </span>
            </div>
          ) : null}
          <OctantButton
            aria-expanded={advancedOpen}
            className="add-provider-wizard__advanced"
            onClick={() => setAdvancedOpen((open) => !open)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Advanced
          </OctantButton>
          {advancedOpen ? (
            <div className="add-provider-wizard__advanced-body">
              <div className="add-provider-wizard__field">
                <span>{providerName} binary</span>
                {binaryEdit === undefined && detected !== undefined ? (
                  <div className="add-provider-wizard__binary">
                    <code>{detected}</code>
                    <OctantButton
                      onClick={() => {
                        setBinaryEdit(detected);
                        queueMicrotask(() => binaryInput.current?.focus());
                      }}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Change…
                    </OctantButton>
                  </div>
                ) : (
                  <OctantInput
                    aria-label={`${providerName} binary`}
                    onChange={(event) => setBinaryEdit(event.currentTarget.value)}
                    placeholder="/absolute/path/to/binary"
                    ref={binaryInput}
                    value={binary}
                  />
                )}
              </div>
              {hasAccount ? (
                <div className="add-provider-wizard__field">
                  <span>Account directory</span>
                  <OctantInput
                    aria-label="Account directory"
                    readOnly
                    value="Assigned by Octant when the account is added"
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
        {step === "connect" ? (
          <WizardConnectStep
            instance={created}
            observed={created === undefined ? undefined : props.observedByInstance.get(created.id)}
            onProbe={props.onProbe}
            probing={created !== undefined && props.probingIds.has(created.id)}
            providerName={providerName}
          />
        ) : null}
        {step === "done" ? (
          <WizardDoneStep
            instance={created}
            observed={created === undefined ? undefined : props.observedByInstance.get(created.id)}
            providerName={providerName}
          />
        ) : null}
      </div>
      <div aria-live="polite" className="add-provider-wizard__problem">
        {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
      </div>
      <footer className="add-provider-wizard__foot">
        {step === "done" ? null : (
          <OctantButton onClick={props.onClose} type="button" variant="ghost">
            {afterCreate ? "Close" : "Cancel"}
          </OctantButton>
        )}
        <span className="add-provider-wizard__spacer" />
        {step === "provider" || afterCreate ? null : (
          <OctantButton
            disabled={creating}
            onClick={() => {
              setProblem(undefined);
              const previous = WIZARD_STEPS[stepIndex - 1];
              if (previous !== undefined) setStep(previous);
            }}
            type="button"
            variant="secondary"
          >
            Back
          </OctantButton>
        )}
        {step === "details" ? (
          <OctantButton disabled={props.busy || creating} onClick={create} type="button">
            {creating ? "Adding…" : `Add ${providerName}`}
          </OctantButton>
        ) : step === "done" ? (
          <OctantButton onClick={props.onClose} type="button">
            Finish
          </OctantButton>
        ) : (
          <OctantButton onClick={next} type="button">
            Next
          </OctantButton>
        )}
      </footer>
    </OctantDialog>
  );
}
