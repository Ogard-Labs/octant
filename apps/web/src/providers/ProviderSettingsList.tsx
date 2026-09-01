import type {
  AgentEligibleModelRef,
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
  ProviderModelId,
  ProviderObservedState,
} from "@octant/contracts";
import { isImageProfileDriverKind } from "@octant/domain";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { ProviderGlyph } from "./ProviderGlyph";
import {
  AnthropicConfigurationForm,
  ClaudeConfigurationForm,
  DevinConfigurationForm,
  FoundryConfigurationForm,
  GeminiImageConfigurationForm,
  GrokConfigurationForm,
  HttpConfigurationForm,
  OpenAiImageConfigurationForm,
  KiloConfigurationForm,
  OhMyPiConfigurationForm,
  OllamaConfigurationForm,
  PiConfigurationForm,
  VibeConfigurationForm,
} from "./ProviderSettingsConfiguration";
import { credentialStatusLabel, useCredentialStatus } from "./ProviderSettingsCredentials";
import {
  capabilityLabels,
  driverLabel,
  formatProbeTimestamp,
  incompatibleReadinessFacts,
  protocolLabel,
  providerRowReadinessLabel,
  titleCase,
} from "./providerSettingsPresentation";
import type { ProviderSettingsViewProps } from "./ProviderSettingsView";

export type ProviderSettingsListProps = Pick<
  ProviderSettingsViewProps,
  | "status"
  | "instances"
  | "defaults"
  | "observedByInstance"
  | "probingIds"
  | "busy"
  | "credentialManagementAvailable"
  | "onRename"
  | "onChangeBinary"
  | "onChangeClaudeConfiguration"
  | "onChangeDevinConfiguration"
  | "onChangeKiloConfiguration"
  | "onChangePiConfiguration"
  | "onChangeOhMyPiConfiguration"
  | "onChangeOllamaConfiguration"
  | "onChangeMistralVibeConfiguration"
  | "onChangeGrokConfiguration"
  | "onChangeOpenAiCompatibleConfiguration"
  | "onChangeAnthropicCompatibleConfiguration"
  | "onChangeAzureFoundryConfiguration"
  | "onChangeOpenAiImageConfiguration"
  | "onChangeGeminiImageConfiguration"
  | "onProviderCredentialStatus"
  | "onClearProviderCredential"
  | "onBeginProviderAuthentication"
  | "onCompleteProviderAuthentication"
  | "onSetEnabled"
  | "onRemove"
  | "onProbe"
  | "onVerifyFoundryTools"
  | "onProviderOrderChange"
  | "onAgentEligibleModelsChange"
> & {
  readonly discoverySnapshot: DiscoverySnapshot | undefined;
  readonly createForm?: ReactNode;
};

export function ProviderSettingsList(props: ProviderSettingsListProps) {
  const [reordering, setReordering] = useState(false);
  // Row order is the order the model picker offers providers in, so the list
  // renders in that order and the row grips edit it directly.
  const ordered = useMemo(() => {
    const explicit = props.defaults.providerOrder ?? [];
    const explicitSet = new Set(explicit);
    const orderedInstances = explicit
      .map((id) => props.instances.find((instance) => instance.id === id))
      .filter((instance): instance is ProviderInstance => instance !== undefined);
    const remaining = props.instances.filter((instance) => !explicitSet.has(instance.id));
    return [...orderedInstances, ...remaining];
  }, [props.instances, props.defaults.providerOrder]);
  const readinessSummary = useMemo(() => {
    let ready = 0;
    let needsSetup = 0;
    let off = 0;
    for (const instance of ordered) {
      if (!instance.enabled) {
        off += 1;
      } else if (props.observedByInstance.get(instance.id)?.readiness === "ready") {
        ready += 1;
      } else {
        needsSetup += 1;
      }
    }
    return { ready, needsSetup, off };
  }, [ordered, props.observedByInstance]);

  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= ordered.length) return;
    const reordered = [...ordered];
    const [moved] = reordered.splice(index, 1);
    if (moved !== undefined) reordered.splice(next, 0, moved);
    void props.onProviderOrderChange(reordered.map((instance) => instance.id));
  }

  return props.status !== "ready" ? null : (
    <>
      <section aria-label="Providers" className="setgroup">
        <div className="setgroup-head">
          <span>Providers</span>
          <span className="setgroup-gap" />
          {ordered.length < 2 ? null : (
            <OctantButton
              aria-pressed={reordering}
              onClick={() => setReordering((current) => !current)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {reordering ? "Done reordering" : "Reorder providers"}
            </OctantButton>
          )}
        </div>
        <p className="setgroup-note">
          {reordering
            ? "Use the arrow controls to change the model-picker order."
            : "The first ready provider is the default for new threads."}
        </p>
        {ordered.length === 0 ? null : (
          <div
            aria-label="Provider readiness summary"
            className="provider-settings__summary"
            role="status"
          >
            <span>
              <strong>{readinessSummary.ready}</strong> ready
            </span>
            <span>
              <strong>{readinessSummary.needsSetup}</strong> needs setup
            </span>
            <span>
              <strong>{readinessSummary.off}</strong> off
            </span>
          </div>
        )}
        {ordered.length === 0 ? (
          <p className="provider-settings__empty">No providers configured.</p>
        ) : (
          <div className="provlist">
            {ordered.map((instance, index) => (
              <ProviderRow
                busy={props.busy}
                count={ordered.length}
                credentialManagementAvailable={props.credentialManagementAvailable}
                index={index}
                instance={instance}
                key={instance.id}
                {...(props.discoverySnapshot === undefined
                  ? {}
                  : { discoverySnapshot: props.discoverySnapshot })}
                {...(props.observedByInstance.get(instance.id) === undefined
                  ? {}
                  : { observed: props.observedByInstance.get(instance.id)! })}
                onChangeBinary={props.onChangeBinary}
                onChangeClaudeConfiguration={props.onChangeClaudeConfiguration}
                onChangeMistralVibeConfiguration={props.onChangeMistralVibeConfiguration}
                onChangeGrokConfiguration={props.onChangeGrokConfiguration}
                onChangeDevinConfiguration={props.onChangeDevinConfiguration}
                onChangeKiloConfiguration={props.onChangeKiloConfiguration}
                onChangePiConfiguration={props.onChangePiConfiguration}
                onChangeOhMyPiConfiguration={props.onChangeOhMyPiConfiguration}
                onChangeOllamaConfiguration={props.onChangeOllamaConfiguration}
                onChangeOpenAiCompatibleConfiguration={props.onChangeOpenAiCompatibleConfiguration}
                onChangeAnthropicCompatibleConfiguration={
                  props.onChangeAnthropicCompatibleConfiguration
                }
                onChangeAzureFoundryConfiguration={props.onChangeAzureFoundryConfiguration}
                onChangeOpenAiImageConfiguration={props.onChangeOpenAiImageConfiguration}
                onChangeGeminiImageConfiguration={props.onChangeGeminiImageConfiguration}
                onClearProviderCredential={props.onClearProviderCredential}
                onBeginProviderAuthentication={props.onBeginProviderAuthentication}
                onCompleteProviderAuthentication={props.onCompleteProviderAuthentication}
                onMove={move}
                onProbe={props.onProbe}
                onVerifyFoundryTools={props.onVerifyFoundryTools}
                onProviderCredentialStatus={props.onProviderCredentialStatus}
                onRemove={props.onRemove}
                onRename={props.onRename}
                onSetEnabled={props.onSetEnabled}
                probing={props.probingIds.has(instance.id)}
                reordering={reordering}
              />
            ))}
          </div>
        )}
        {props.createForm === undefined ? null : (
          <div className="setgroup-foot">{props.createForm}</div>
        )}
      </section>
      {ordered.length === 0 ? null : (
        <AgentEligibleModelsControls
          agentEligibleModels={props.defaults.agentEligibleModels}
          busy={props.busy}
          instances={props.instances}
          observedByInstance={props.observedByInstance}
          onAgentEligibleModelsChange={props.onAgentEligibleModelsChange}
        />
      )}
    </>
  );
}

function agentEligibleModelKey(ref: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}): string {
  return `${ref.providerInstanceId}:${ref.modelId}`;
}

/**
 * Settings-defined default agent-eligible pool. Membership is a
 * selection default consumed by the composer pool control: toggling a model
 * never configures credentials, activates a provider, or widens authority,
 * and only configured, ready providers expose selectable models.
 */
function AgentEligibleModelsControls(props: {
  readonly busy: boolean;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly agentEligibleModels: ReadonlyArray<AgentEligibleModelRef> | undefined;
  readonly onAgentEligibleModelsChange: (
    agentEligibleModels: ReadonlyArray<AgentEligibleModelRef>,
  ) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const selected = props.agentEligibleModels ?? [];
  const selectedKeys = useMemo(
    () => new Set(selected.map(agentEligibleModelKey)),
    [props.agentEligibleModels],
  );
  const available = useMemo(() => {
    const rows: Array<{
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerName: string;
      readonly modelId: ProviderModelId;
      readonly modelName: string;
    }> = [];
    for (const instance of props.instances) {
      if (!instance.enabled || isImageProfileDriverKind(instance.driverKind)) continue;
      const observed = props.observedByInstance.get(instance.id);
      if (observed === undefined || observed.readiness !== "ready") continue;
      for (const model of observed.models) {
        rows.push({
          providerInstanceId: instance.id,
          providerName: instance.displayName,
          modelId: model.id,
          modelName: model.displayName,
        });
      }
    }
    return rows;
  }, [props.instances, props.observedByInstance]);
  const availableKeys = useMemo(() => new Set(available.map(agentEligibleModelKey)), [available]);
  // Stored refs whose model is no longer observed remain visible and
  // removable so a stale default never silently lingers.
  const stale = selected.filter((ref) => !availableKeys.has(agentEligibleModelKey(ref)));

  function toggle(ref: AgentEligibleModelRef, enabled: boolean) {
    const next = enabled
      ? [...selected, ref]
      : selected.filter((value) => agentEligibleModelKey(value) !== agentEligibleModelKey(ref));
    void props.onAgentEligibleModelsChange(next);
  }

  return (
    <section
      aria-label="Agent-eligible models"
      className="agent-eligible-models"
      data-expanded={open}
    >
      <OctantButton
        aria-controls="agent-eligible-models-list"
        aria-expanded={open}
        aria-label="Agent-eligible models"
        className="agent-eligible-models__trigger window-no-drag"
        onClick={() => setOpen((current) => !current)}
        type="button"
        variant="ghost"
      >
        <span>Agent-eligible models</span>
        <span className="agent-eligible-models__count">{selected.length}</span>
        <ChevronDown
          aria-hidden="true"
          className="agent-eligible-models__disclosure-icon"
          size={16}
        />
      </OctantButton>
      {open ? (
        <div className="agent-eligible-models__body" id="agent-eligible-models-list">
          <p className="provider-settings__hint">
            Default pool offered by the composer&apos;s multi-model control. Membership never
            configures credentials, activates a provider, or widens authority — composers can only
            narrow this pool, and routing re-checks each model at send time.
          </p>
          {available.length === 0 && stale.length === 0 ? (
            <p className="agent-eligible-models__empty">
              No configured, ready models are available. Run a connection check on an enabled
              provider to list its models.
            </p>
          ) : (
            <ul className="agent-eligible-models__list">
              {available.map((row) => {
                const ref: AgentEligibleModelRef = {
                  providerInstanceId: row.providerInstanceId,
                  modelId: row.modelId,
                };
                const key = agentEligibleModelKey(ref);
                return (
                  <li className="agent-eligible-models__item" key={key}>
                    <label className="agent-eligible-models__option">
                      <OctantCheckbox
                        aria-label={`${row.providerName} — ${row.modelName}`}
                        checked={selectedKeys.has(key)}
                        className="window-no-drag"
                        disabled={props.busy}
                        onChange={(event) => toggle(ref, event.currentTarget.checked)}
                      />
                      <span>
                        {row.providerName} — {row.modelName}
                      </span>
                    </label>
                  </li>
                );
              })}
              {stale.map((ref) => {
                const providerName =
                  props.instances.find((instance) => instance.id === ref.providerInstanceId)
                    ?.displayName ?? String(ref.providerInstanceId);
                const key = agentEligibleModelKey(ref);
                return (
                  <li className="agent-eligible-models__item" key={key}>
                    <label className="agent-eligible-models__option agent-eligible-models__option--unavailable">
                      <OctantCheckbox
                        aria-label={`${providerName} — ${ref.modelId} (unavailable)`}
                        checked
                        className="window-no-drag"
                        disabled={props.busy}
                        onChange={() => toggle(ref, false)}
                      />
                      <span>
                        {providerName} — {String(ref.modelId)} (unavailable)
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

interface ProviderRowProps {
  readonly instance: ProviderInstance;
  readonly observed?: ProviderObservedState;
  readonly discoverySnapshot?: DiscoverySnapshot;
  readonly busy: boolean;
  readonly probing: boolean;
  readonly reordering: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly index: number;
  readonly count: number;
  readonly onMove: (index: number, direction: -1 | 1) => void;
  readonly onRename: ProviderSettingsViewProps["onRename"];
  readonly onChangeBinary: ProviderSettingsViewProps["onChangeBinary"];
  readonly onChangeClaudeConfiguration: ProviderSettingsViewProps["onChangeClaudeConfiguration"];
  readonly onChangeDevinConfiguration: ProviderSettingsViewProps["onChangeDevinConfiguration"];
  readonly onChangeKiloConfiguration: ProviderSettingsViewProps["onChangeKiloConfiguration"];
  readonly onChangePiConfiguration: ProviderSettingsViewProps["onChangePiConfiguration"];
  readonly onChangeOhMyPiConfiguration: ProviderSettingsViewProps["onChangeOhMyPiConfiguration"];
  readonly onChangeOllamaConfiguration: ProviderSettingsViewProps["onChangeOllamaConfiguration"];
  readonly onChangeMistralVibeConfiguration: ProviderSettingsViewProps["onChangeMistralVibeConfiguration"];
  readonly onChangeGrokConfiguration: ProviderSettingsViewProps["onChangeGrokConfiguration"];
  readonly onChangeOpenAiCompatibleConfiguration: ProviderSettingsViewProps["onChangeOpenAiCompatibleConfiguration"];
  readonly onChangeAnthropicCompatibleConfiguration: ProviderSettingsViewProps["onChangeAnthropicCompatibleConfiguration"];
  readonly onChangeAzureFoundryConfiguration: ProviderSettingsViewProps["onChangeAzureFoundryConfiguration"];
  readonly onChangeOpenAiImageConfiguration: ProviderSettingsViewProps["onChangeOpenAiImageConfiguration"];
  readonly onChangeGeminiImageConfiguration: ProviderSettingsViewProps["onChangeGeminiImageConfiguration"];
  readonly onProviderCredentialStatus: ProviderSettingsViewProps["onProviderCredentialStatus"];
  readonly onClearProviderCredential: ProviderSettingsViewProps["onClearProviderCredential"];
  readonly onBeginProviderAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteProviderAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
  readonly onSetEnabled: ProviderSettingsViewProps["onSetEnabled"];
  readonly onRemove: ProviderSettingsViewProps["onRemove"];
  readonly onProbe: ProviderSettingsViewProps["onProbe"];
  readonly onVerifyFoundryTools: ProviderSettingsViewProps["onVerifyFoundryTools"];
}

function ProviderRow(props: ProviderRowProps) {
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const disabled = props.busy || props.probing;
  const readiness = props.probing ? "checking" : props.observed?.readiness;
  const autoRegisteredDisabled = isDisabledDiscoveryInstance(
    props.instance,
    props.discoverySnapshot,
  );
  const isCli =
    props.instance.driverKind === "codex" ||
    props.instance.driverKind === "opencode" ||
    props.instance.driverKind === "kimi-code";
  const isClaude = props.instance.driverKind === "claude";
  const isVibe = props.instance.driverKind === "mistral-vibe";
  const isGrok = props.instance.driverKind === "grok";
  const isDevin = props.instance.driverKind === "devin";
  const isKilo = props.instance.driverKind === "kilo";
  const isPi = props.instance.driverKind === "pi";
  const isOhMyPi = props.instance.driverKind === "oh-my-pi";
  const isOllama = props.instance.driverKind === "ollama";
  const isHttp = props.instance.driverKind === "openai-compatible";
  const isAnthropicHttp = props.instance.driverKind === "anthropic-compatible";
  const isFoundry = props.instance.driverKind === "azure-foundry";
  const isOpenAiImage = props.instance.driverKind === "openai-image";
  const isGeminiImage = props.instance.driverKind === "gemini-native-image";
  const isImageProfile = isOpenAiImage || isGeminiImage;
  const usesCredential =
    isHttp ||
    isAnthropicHttp ||
    isFoundry ||
    isImageProfile ||
    ((isClaude || isVibe || isGrok) && props.instance.configuration.authentication === "api-key");
  const credential = useCredentialStatus(props, !usesCredential);
  const label = driverLabel(props.instance.driverKind);
  const runtimeLabel = isClaude
    ? "Agent SDK"
    : isVibe || isGrok || isDevin || isKilo
      ? "ACP"
      : isPi || isOhMyPi
        ? "RPC"
        : isCli
          ? "CLI"
          : isImageProfile
            ? "Image"
            : "HTTP";
  const toggleEnabled = async () => {
    const nextEnabled = !props.instance.enabled;
    const updated = await props.onSetEnabled(props.instance.id, nextEnabled);
    if (updated && nextEnabled && autoRegisteredDisabled) {
      await props.onProbe(props.instance.id);
    }
  };
  const name = props.instance.displayName;
  return (
    <article
      aria-label={name}
      className="provrow"
      data-enabled={props.instance.enabled ? "true" : "false"}
      data-reordering={props.reordering ? "true" : "false"}
    >
      {props.reordering ? (
        <span className="prov-grip-slot">
          <OctantButton
            aria-label={`Move ${name} up`}
            className="prov-grip window-no-drag"
            disabled={props.busy || props.index === 0}
            onClick={() => props.onMove(props.index, -1)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ChevronUp aria-hidden="true" size={14} />
          </OctantButton>
          <OctantButton
            aria-label={`Move ${name} down`}
            className="prov-grip window-no-drag"
            disabled={props.busy || props.index === props.count - 1}
            onClick={() => props.onMove(props.index, 1)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ChevronDown aria-hidden="true" size={14} />
          </OctantButton>
        </span>
      ) : null}
      <span className="icon-mark">
        <ProviderGlyph displayName={name} driverKind={props.instance.driverKind} size={16} />
      </span>
      <span className="prov-main">
        <span className="prov-name">{name}</span>
        <span className="prov-meta">
          {label} {runtimeLabel}
        </span>
      </span>
      <span className="prov-models">
        {props.observed === undefined ||
        (props.observed.models.length === 0 && props.observed.readiness !== "ready")
          ? null
          : `${props.observed.models.length} ${props.observed.models.length === 1 ? "model" : "models"}`}
      </span>
      <span className="prov-status">
        <span className={readinessBadgeClass(props.instance.enabled ? readiness : undefined)}>
          {!props.instance.enabled
            ? "Off"
            : readiness === undefined
              ? "Not checked"
              : providerRowReadinessLabel(readiness, props.observed?.models.length ?? 0)}
        </span>
      </span>
      <span className="prov-actions">
        <OctantButton
          size="icon"
          aria-controls={`provider-details-${props.instance.id}`}
          aria-expanded={detailsOpen}
          aria-label={`Details for ${name}`}
          className="prov-details-trigger window-no-drag"
          onClick={() => setDetailsOpen((current) => !current)}
          type="button"
          variant="ghost"
        >
          <ChevronDown aria-hidden="true" className="prov-details-icon" size={14} />
        </OctantButton>
        <OctantSwitch
          checked={props.instance.enabled}
          disabled={disabled}
          label={`Enable ${name}`}
          onCheckedChange={() => void toggleEnabled()}
        />
      </span>
      {detailsOpen ? (
        <div className="prov-details" id={`provider-details-${props.instance.id}`}>
          {props.observed === undefined ? null : (
            <div className="provider-card__facts">
              <span>Process: {titleCase(props.observed.processState)}</span>
              <span>Version: {props.observed.detectedVersion ?? "Unavailable"}</span>
              <span>Models: {props.observed.models.length}</span>
              <span>
                Last check:{" "}
                {props.observed.lastSuccessfulProbeAt === undefined ? (
                  "No successful check"
                ) : (
                  <time dateTime={props.observed.lastSuccessfulProbeAt}>
                    {formatProbeTimestamp(props.observed.lastSuccessfulProbeAt)}
                  </time>
                )}
              </span>
            </div>
          )}
          {!isHttp ? null : (
            <div className="provider-card__facts provider-card__facts--http">
              <span>{props.instance.configuration.baseUrl}</span>
              <span>
                Configured protocol: {protocolLabel(props.instance.configuration.protocol)}
              </span>
              <span>
                Observed protocol:{" "}
                {props.observed?.observedProtocol === undefined
                  ? "Not observed by a real turn"
                  : protocolLabel(props.observed.observedProtocol)}
              </span>
              <span>Authentication: {titleCase(props.instance.configuration.authentication)}</span>
              <span>
                Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
              </span>
            </div>
          )}
          {!isAnthropicHttp ? null : (
            <div className="provider-card__facts provider-card__facts--http">
              <span>{props.instance.configuration.baseUrl}</span>
              <span>Protocol version: {props.instance.configuration.protocolVersion}</span>
              <span>
                Configured protocol: {protocolLabel(props.instance.configuration.protocol)}
              </span>
              <span>Authentication: {titleCase(props.instance.configuration.authentication)}</span>
              <span>
                Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
              </span>
            </div>
          )}
          {!isFoundry ? null : (
            <div className="provider-card__facts provider-card__facts--http">
              <span>{props.instance.configuration.baseUrl}</span>
              <span>
                Configured protocol: {protocolLabel(props.instance.configuration.protocol)}
              </span>
              <span>
                Observed protocol:{" "}
                {props.observed?.observedProtocol === undefined
                  ? "Not observed by a real turn"
                  : protocolLabel(props.observed.observedProtocol)}
              </span>
              <span>Authentication: API key</span>
              <span>
                Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
              </span>
              <span>
                Tool support:{" "}
                <strong>
                  {(props.observed?.verifiedToolModelIds?.length ?? 0) > 0
                    ? `Verified (${props.observed?.verifiedToolModelIds?.length} deployment${(props.observed?.verifiedToolModelIds?.length ?? 0) > 1 ? "s" : ""})`
                    : "Unverified (non-generating Connection Check)"}
                </strong>
              </span>
              <span>Deployments:</span>
              {props.instance.configuration.manualModelIds.map((modelId) => {
                const isVerified = props.observed?.verifiedToolModelIds?.some(
                  (id) => String(id) === String(modelId),
                );
                return (
                  <span key={String(modelId)}>
                    <OctantButton
                      disabled={disabled || !props.instance.enabled}
                      onClick={() => void props.onVerifyFoundryTools(props.instance.id, modelId)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {props.probing
                        ? "Verifying…"
                        : `Verify tools for ${modelId}${isVerified ? " (verified)" : ""}`}
                    </OctantButton>
                  </span>
                );
              })}
            </div>
          )}
          {!isClaude ? null : (
            <div className="provider-card__facts provider-card__facts--claude">
              <span>
                Authentication:{" "}
                {props.instance.configuration.authentication === "api-key"
                  ? "Anthropic API key"
                  : "Claude subscription"}
              </span>
              {props.instance.configuration.authentication === "api-key" ? (
                <span>
                  Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
                </span>
              ) : null}
            </div>
          )}
          {!isVibe ? null : (
            <div className="provider-card__facts provider-card__facts--vibe">
              <span>
                Authentication:{" "}
                {props.instance.configuration.authentication === "api-key"
                  ? "Mistral API key"
                  : "Mistral subscription"}
              </span>
              {props.instance.configuration.authentication === "api-key" ? (
                <span>
                  Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
                </span>
              ) : null}
            </div>
          )}
          {!isGrok ? null : (
            <div className="provider-card__facts provider-card__facts--grok">
              <span>
                Authentication:{" "}
                {props.instance.configuration.authentication === "api-key"
                  ? "xAI API key"
                  : "xAI subscription"}
              </span>
              {props.instance.configuration.authentication === "api-key" ? (
                <span>
                  Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
                </span>
              ) : null}
            </div>
          )}
          {!isDevin ? null : (
            <div className="provider-card__facts provider-card__facts--devin">
              <span>Authentication: Devin subscription</span>
            </div>
          )}
          {!isPi ? null : (
            <div className="provider-card__facts provider-card__facts--pi">
              <span>Authentication: provider-owned Pi credentials</span>
            </div>
          )}
          {!isOhMyPi ? null : (
            <div className="provider-card__facts provider-card__facts--oh-my-pi">
              <span>Authentication: provider-owned Oh My Pi credentials</span>
              <span>Supported version: {props.instance.configuration.supportedVersion}</span>
            </div>
          )}
          {!isKilo ? null : (
            <div className="provider-card__facts provider-card__facts--kilo">
              <span>Authentication: provider-owned Kilo credentials</span>
            </div>
          )}
          {!isOllama ? null : (
            <div className="provider-card__facts provider-card__facts--ollama">
              <span>{props.instance.configuration.baseUrl}</span>
              <span>Authentication: none (loopback only)</span>
              <span>Service lifecycle: user-managed</span>
            </div>
          )}
          {!isOpenAiImage ? null : (
            <div className="provider-card__facts provider-card__facts--image">
              <span>Default model: {props.instance.configuration.defaultModel}</span>
              <span>Allowlist: {props.instance.configuration.modelAllowlist.join(", ")}</span>
              {props.instance.configuration.quality === undefined ? null : (
                <span>Quality: {props.instance.configuration.quality}</span>
              )}
              {props.instance.configuration.size === undefined ? null : (
                <span>Size: {props.instance.configuration.size}</span>
              )}
              <span>
                Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
              </span>
            </div>
          )}
          {!isGeminiImage ? null : (
            <div className="provider-card__facts provider-card__facts--image">
              <span>Default model: {props.instance.configuration.defaultModel}</span>
              <span>Allowlist: {props.instance.configuration.modelAllowlist.join(", ")}</span>
              {props.instance.configuration.aspectRatio === undefined ? null : (
                <span>Aspect ratio: {props.instance.configuration.aspectRatio}</span>
              )}
              {props.instance.configuration.resolution === undefined ? null : (
                <span>Resolution: {props.instance.configuration.resolution}</span>
              )}
              <span>
                Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
              </span>
            </div>
          )}
          {autoRegisteredDisabled ? (
            <p className="provider-card__guidance">Detected on this host — enable to use</p>
          ) : null}
          {guidance(props.instance, readiness, props.observed)}
          {usesCredential && !props.credentialManagementAvailable ? (
            <p className="provider-card__guidance">
              Manage credentials in the Octant host app. Credential replacement, clearing, and
              provider removal are unavailable in this browser.
            </p>
          ) : null}
          {props.instance.driverKind === "codex" ||
          props.instance.driverKind === "kimi-code" ||
          isClaude ||
          isVibe ||
          isGrok ||
          isDevin ||
          isKilo ||
          isPi ||
          isOhMyPi ? (
            <p className="provider-card__authority-note">
              “Remember for this Project” cannot create persistent provider authority, so approvals
              stay one-shot. Select “Current session only” to allow a supported approval for the
              current session.
            </p>
          ) : null}
          <div className="provider-card__actions">
            {isImageProfile ? null : (
              <OctantButton
                disabled={disabled || !props.instance.enabled}
                onClick={() => void props.onProbe(props.instance.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                {props.probing
                  ? "Checking connection…"
                  : `Check connection for ${props.instance.displayName}`}
              </OctantButton>
            )}
            <OctantButton
              aria-controls={`provider-configuration-${props.instance.id}`}
              aria-expanded={configurationOpen}
              aria-label={`Configure ${props.instance.displayName}`}
              onClick={() => setConfigurationOpen((current) => !current)}
              type="button"
              variant="ghost"
            >
              <span>Configure</span>
              <ChevronDown
                aria-hidden="true"
                className="provider-card__disclosure-icon"
                size={14}
              />
            </OctantButton>
            <OctantButton
              disabled={disabled || (usesCredential && !props.credentialManagementAvailable)}
              onClick={() => void props.onRemove(props.instance.id)}
              size="sm"
              type="button"
              variant="destructive"
            >
              Remove {props.instance.displayName}
            </OctantButton>
          </div>
          {configurationOpen ? (
            <div
              className="provider-card__configuration"
              data-expanded="true"
              id={`provider-configuration-${props.instance.id}`}
            >
              <form
                className="provider-card__edit"
                key={`name:${props.instance.version}`}
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void props.onRename(props.instance.id, String(data.get("displayName") ?? ""));
                }}
              >
                <label>
                  <span>Display name</span>
                  <OctantInput
                    aria-label={`Display name for ${props.instance.displayName}`}
                    className="settings-view__text-input"
                    defaultValue={props.instance.displayName}
                    name="displayName"
                    required
                  />
                </label>
                <OctantButton disabled={disabled} type="submit">
                  Save name for {props.instance.displayName}
                </OctantButton>
              </form>
              {isCli ? (
                <form
                  className="provider-card__edit"
                  key={`binary:${props.instance.version}`}
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void props.onChangeBinary(
                      props.instance.id,
                      String(data.get("binaryPath") ?? ""),
                    );
                  }}
                >
                  <label>
                    <span>Binary path</span>
                    <OctantInput
                      aria-label={`Binary path for ${props.instance.displayName}`}
                      className="settings-view__text-input"
                      defaultValue={props.instance.configuration.binaryPath}
                      name="binaryPath"
                      required
                    />
                  </label>
                  <OctantButton disabled={disabled} type="submit">
                    Save binary path for {props.instance.displayName}
                  </OctantButton>
                </form>
              ) : isClaude ? (
                <ClaudeConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`claude:${props.instance.version}`}
                  onChange={props.onChangeClaudeConfiguration}
                />
              ) : isVibe ? (
                <VibeConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`vibe:${props.instance.version}`}
                  onBeginAuthentication={props.onBeginProviderAuthentication}
                  onChange={props.onChangeMistralVibeConfiguration}
                  onCompleteAuthentication={props.onCompleteProviderAuthentication}
                />
              ) : isGrok ? (
                <GrokConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`grok:${props.instance.version}`}
                  onBeginAuthentication={props.onBeginProviderAuthentication}
                  onChange={props.onChangeGrokConfiguration}
                  onCompleteAuthentication={props.onCompleteProviderAuthentication}
                />
              ) : isDevin ? (
                <DevinConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`devin:${props.instance.version}`}
                  onChange={props.onChangeDevinConfiguration}
                />
              ) : isPi ? (
                <PiConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`pi:${props.instance.version}`}
                  onChange={props.onChangePiConfiguration}
                />
              ) : isOhMyPi ? (
                <OhMyPiConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`oh-my-pi:${props.instance.version}`}
                  onChange={props.onChangeOhMyPiConfiguration}
                />
              ) : isKilo ? (
                <KiloConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`kilo:${props.instance.version}`}
                  onChange={props.onChangeKiloConfiguration}
                />
              ) : isOllama ? (
                <OllamaConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`ollama:${props.instance.version}`}
                  onChange={props.onChangeOllamaConfiguration}
                />
              ) : isAnthropicHttp ? (
                <AnthropicConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`anthropic:${props.instance.version}`}
                  onChange={props.onChangeAnthropicCompatibleConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              ) : isFoundry ? (
                <FoundryConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`foundry:${props.instance.version}`}
                  onChange={props.onChangeAzureFoundryConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              ) : isOpenAiImage ? (
                <OpenAiImageConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`openai-image:${props.instance.version}`}
                  onChange={props.onChangeOpenAiImageConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              ) : isGeminiImage ? (
                <GeminiImageConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`gemini-image:${props.instance.version}`}
                  onChange={props.onChangeGeminiImageConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              ) : isHttp ? (
                <HttpConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`http:${props.instance.version}`}
                  onChange={props.onChangeOpenAiCompatibleConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              ) : null}
              {props.observed === undefined ? null : (
                <div className="provider-card__discovery">
                  <section aria-labelledby={`models-${props.instance.id}`}>
                    <h4 id={`models-${props.instance.id}`}>Models</h4>
                    {props.observed.models.length === 0 ? (
                      <p>No models reported.</p>
                    ) : (
                      <ul>
                        {props.observed.models.map((model) => (
                          <li key={model.id}>
                            {!isHttp && !isAnthropicHttp && !isFoundry
                              ? model.displayName
                              : `${model.displayName} · ${titleCase(model.source)} · ${titleCase(model.verification)}`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section aria-labelledby={`capabilities-${props.instance.id}`}>
                    <h4 id={`capabilities-${props.instance.id}`}>Capabilities</h4>
                    <dl>
                      {capabilityLabels.map(([key, label]) => (
                        <div key={key}>
                          <dt>{label}</dt>
                          <dd>{titleCase(props.observed!.capabilities[key])}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * The badge reports fact (reachable right now), never intent (the switch).
 * "checking" and "not checked" stay neutral because no reachability claim
 * has been established either way.
 */
function readinessBadgeClass(readiness: ProviderObservedState["readiness"] | undefined): string {
  if (readiness === "ready") return "badge badge-ok";
  if (readiness === "degraded" || readiness === "unauthenticated") return "badge badge-warn";
  if (readiness === "unavailable" || readiness === "incompatible") return "badge badge-danger";
  return "badge";
}

function isDisabledDiscoveryInstance(
  instance: ProviderInstance,
  snapshot: DiscoverySnapshot | undefined,
): boolean {
  if (instance.enabled || snapshot === undefined) return false;
  if (snapshot.autoRegisteredInstanceIds?.includes(instance.id) === true) return true;
  if (
    instance.driverKind === "ollama" &&
    snapshot.candidates.some((candidate) => candidate.driverKind === "ollama")
  ) {
    return true;
  }
  const binaryPath = providerBinaryPath(instance);
  return (
    binaryPath !== undefined &&
    snapshot.candidates.some(
      (candidate) =>
        candidate.driverKind === instance.driverKind && candidate.binaryPath === binaryPath,
    )
  );
}

function providerBinaryPath(instance: ProviderInstance): string | undefined {
  return "binaryPath" in instance.configuration ? instance.configuration.binaryPath : undefined;
}

function guidance(
  instance: ProviderInstance,
  readiness: ProviderObservedState["readiness"] | undefined,
  observed?: ProviderObservedState,
) {
  const driverKind = instance.driverKind;
  const label = driverLabel(driverKind);
  const message = observed?.message;
  if (readiness === "unauthenticated")
    return (
      <p className="provider-card__guidance">
        {driverKind === "codex"
          ? "Run codex login in your terminal, then check the connection again."
          : driverKind === "opencode"
            ? "Authenticate with OpenCode, then check the connection again."
            : driverKind === "kimi-code"
              ? "Run kimi login for this provider's Octant-managed profile. Do not use your ordinary Kimi profile; then check the connection again."
              : driverKind === "devin"
                ? "Run devin auth login in your terminal, then check the connection again."
                : driverKind === "pi"
                  ? "Authenticate with the official Pi CLI, then check the connection again."
                  : driverKind === "oh-my-pi"
                    ? "Install and authenticate Oh My Pi (`omp`), then check the connection again. Octant treats Oh My Pi as distinct from Pi."
                    : driverKind === "kilo"
                      ? "Run kilo auth login in your terminal, then check the connection again."
                      : driverKind === "claude"
                        ? instance.configuration.authentication === "api-key"
                          ? "Add or replace the Anthropic API key in the Octant host. It remains write-only and is stored in Keychain, then check the connection again."
                          : "Authenticate with the official Claude Code app or CLI, then check the connection again."
                        : driverKind === "mistral-vibe"
                          ? instance.configuration.authentication === "api-key"
                            ? "Add or replace the Mistral API key in the Octant host, then check the connection again."
                            : "Use the Mistral browser sign-in action below, then check the connection again."
                          : driverKind === "grok"
                            ? instance.configuration.authentication === "api-key"
                              ? "Add or replace the xAI API key in the Octant host, then check the connection again."
                              : "Use the xAI browser sign-in action below, then check the connection again."
                            : driverKind === "anthropic-compatible"
                              ? "Add or replace the Anthropic API key in the Octant host. It remains write-only and is stored in Keychain, then check the connection again."
                              : driverKind === "azure-foundry"
                                ? "Add or replace the Azure AI Foundry API key in the Octant host. It is stored in Keychain and sent as the api-key header, then check the connection again."
                                : "Add a bearer API key in the Octant host, then check the connection again."}
      </p>
    );
  if (readiness === "incompatible") {
    const nextAction =
      driverKind === "openai-compatible" ||
      driverKind === "anthropic-compatible" ||
      driverKind === "azure-foundry"
        ? "The endpoint returned an incompatible protocol response. Review its API compatibility."
        : driverKind === "ollama"
          ? "The loopback endpoint returned an incompatible native Ollama response. Update Ollama or verify the native API endpoint."
          : driverKind === "kimi-code"
            ? "The Kimi Code runtime or its Octant-managed safety profile is incompatible. Review the connection detail and supported version before retrying."
            : `Update your ${label} installation to a compatible version, then retry.`;
    return (
      <>
        <p className="provider-card__guidance">{nextAction}</p>
        <div
          aria-label="Incompatibility details"
          className="provider-card__facts provider-card__facts--incompatible"
        >
          {incompatibleReadinessFacts(instance, observed).map((fact) => (
            <span key={fact.label}>
              {fact.label}: {fact.value}
            </span>
          ))}
        </div>
      </>
    );
  }
  if (readiness === "degraded")
    return (
      <p className="provider-card__guidance">
        {driverKind === "openai-compatible" ||
        driverKind === "anthropic-compatible" ||
        driverKind === "azure-foundry"
          ? "The provider remains usable with degraded discovery or streaming. Review capabilities before use."
          : driverKind === "ollama"
            ? "Ollama is reachable but no compatible installed models were reported. Manage models outside Octant, then retry."
            : "Review unavailable capabilities before starting work."}
      </p>
    );
  if (readiness === "unavailable")
    return (
      <p className="provider-card__guidance">
        {driverKind === "openai-compatible" ||
        driverKind === "anthropic-compatible" ||
        driverKind === "azure-foundry"
          ? "Verify the API base URL and endpoint availability, then retry."
          : driverKind === "ollama"
            ? "Start the user-managed Ollama service and verify the loopback API base URL, then retry."
            : `Verify the binary path and that ${label} can start, then retry.`}
      </p>
    );
  return message === undefined ? null : <p className="provider-card__guidance">{message}</p>;
}
