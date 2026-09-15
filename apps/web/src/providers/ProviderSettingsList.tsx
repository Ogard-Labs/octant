import type {
  AgentEligibleModelRef,
  DiscoverySnapshot,
  HiddenProviderModelRef,
  ProviderInstance,
  ProviderInstanceId,
  ProviderDataTag,
  ProviderDataTags,
  ProviderModelId,
  ProviderObservedState,
} from "@octant/contracts";
import { isImageProfileDriverKind, supportsProviderCliUpdate } from "@octant/domain";
import { CheckCircle2, ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { ProviderGlyph } from "./ProviderGlyph";
import {
  AnthropicConfigurationForm,
  BflImageConfigurationForm,
  ClaudeConfigurationForm,
  DevinConfigurationForm,
  FoundryConfigurationForm,
  GeminiImageConfigurationForm,
  GrokConfigurationForm,
  GlmConfigurationForm,
  GeminiConfigurationForm,
  CopilotConfigurationForm,
  ClineConfigurationForm,
  QwenConfigurationForm,
  GooseConfigurationForm,
  HttpConfigurationForm,
  IdeogramImageConfigurationForm,
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
  providerDetectionBlockedReason,
  providerProcessDiagnosticFacts,
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
  | "updatingIds"
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
  | "onChangeGooseConfiguration"
  | "onChangeGlmConfiguration"
  | "onChangeGeminiConfiguration"
  | "onChangeCopilotConfiguration"
  | "onChangeClineConfiguration"
  | "onChangeQwenConfiguration"
  | "onChangeOpenAiCompatibleConfiguration"
  | "onChangeAnthropicCompatibleConfiguration"
  | "onChangeAzureFoundryConfiguration"
  | "onChangeOpenAiImageConfiguration"
  | "onChangeGeminiImageConfiguration"
  | "onChangeBflImageConfiguration"
  | "onChangeIdeogramImageConfiguration"
  | "onProviderCredentialStatus"
  | "onClearProviderCredential"
  | "onBeginProviderAuthentication"
  | "onOpenExternalUrl"
  | "onCompleteProviderAuthentication"
  | "onUpdateProviderCli"
  | "onSetEnabled"
  | "onDataTagsChange"
  | "onModelDataTagsChange"
  | "onRemove"
  | "onProbe"
  | "onVerifyFoundryTools"
  | "onProviderOrderChange"
  | "onAgentEligibleModelsChange"
  | "onHiddenModelsChange"
> & {
  readonly discoverySnapshot: DiscoverySnapshot | undefined;
  readonly presentationObservedByInstance?: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly createForm?: ReactNode;
  readonly heading?: string;
  readonly note?: string;
  readonly showAgentEligibleModels?: boolean;
  /** The Providers page separates detected rows from supported rows. */
  readonly showDetectionGroups?: boolean;
  readonly showReorder?: boolean;
};

export function ProviderSettingsList(props: ProviderSettingsListProps) {
  const [reordering, setReordering] = useState(false);
  // The registry projection is authoritative and can be intentionally empty
  // during a probe. Settings may use the last observed facts for geometry
  // while the probe is pending; eligibility controls below still use the
  // authoritative map and therefore fail closed.
  const presentationObserved = props.presentationObservedByInstance ?? props.observedByInstance;
  // Row order is the order the model picker offers providers in. Detection
  // groups present that order within each group; reorder mode shows the single
  // list so the grips still edit the real order directly.
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
      } else if (
        !props.updatingIds?.has(instance.id) &&
        presentationObserved.get(instance.id)?.readiness === "ready"
      ) {
        ready += 1;
      } else {
        needsSetup += 1;
      }
    }
    return { ready, needsSetup, off };
  }, [ordered, presentationObserved, props.updatingIds]);

  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= ordered.length) return;
    const reordered = [...ordered];
    const [moved] = reordered.splice(index, 1);
    if (moved !== undefined) reordered.splice(next, 0, moved);
    void props.onProviderOrderChange(reordered.map((instance) => instance.id));
  }

  // Only the current scan is evidence that a runtime is installed; the group a
  // row lands in follows that. A binary the scan never searched for is not
  // claimed absent, and a manual endpoint has no local binary to detect at all.
  const groups = useMemo(() => {
    const detected: Array<{ readonly instance: ProviderInstance; readonly index: number }> = [];
    const notFound: Array<{ readonly instance: ProviderInstance; readonly index: number }> = [];
    const other: Array<{ readonly instance: ProviderInstance; readonly index: number }> = [];
    ordered.forEach((instance, index) => {
      const row = { instance, index };
      const binaryPath = providerBinaryPath(instance);
      if (isDetectedLocally(instance, props.discoverySnapshot)) {
        detected.push(row);
      } else if (
        binaryPath === undefined ||
        !isAbsenceProven(binaryPath, instance.driverKind, props.discoverySnapshot)
      ) {
        // The scan never visited this binary's directory, or never finished:
        // its silence is not evidence of absence.
        other.push(row);
      } else {
        notFound.push(row);
      }
    });
    return { detected, notFound, other };
  }, [ordered, props.discoverySnapshot]);

  const busy = props.busy || props.status !== "ready";
  const showDetectionGroups = props.showDetectionGroups === true && !reordering;

  function renderProviderRow(instance: ProviderInstance, index: number) {
    return (
      <ProviderRow
        busy={busy}
        count={ordered.length}
        credentialManagementAvailable={props.credentialManagementAvailable}
        index={index}
        instance={instance}
        key={instance.id}
        {...(props.discoverySnapshot === undefined
          ? {}
          : { discoverySnapshot: props.discoverySnapshot })}
        {...(presentationObserved.get(instance.id) === undefined
          ? {}
          : { observed: presentationObserved.get(instance.id)! })}
        onChangeBinary={props.onChangeBinary}
        onChangeClaudeConfiguration={props.onChangeClaudeConfiguration}
        onChangeMistralVibeConfiguration={props.onChangeMistralVibeConfiguration}
        onChangeGrokConfiguration={props.onChangeGrokConfiguration}
        onChangeGooseConfiguration={props.onChangeGooseConfiguration}
        onChangeGlmConfiguration={props.onChangeGlmConfiguration}
        onChangeGeminiConfiguration={props.onChangeGeminiConfiguration}
        onChangeCopilotConfiguration={props.onChangeCopilotConfiguration}
        onChangeClineConfiguration={props.onChangeClineConfiguration}
        onChangeQwenConfiguration={props.onChangeQwenConfiguration}
        onChangeDevinConfiguration={props.onChangeDevinConfiguration}
        onChangeKiloConfiguration={props.onChangeKiloConfiguration}
        onChangePiConfiguration={props.onChangePiConfiguration}
        onChangeOhMyPiConfiguration={props.onChangeOhMyPiConfiguration}
        onChangeOllamaConfiguration={props.onChangeOllamaConfiguration}
        onChangeOpenAiCompatibleConfiguration={props.onChangeOpenAiCompatibleConfiguration}
        onChangeAnthropicCompatibleConfiguration={props.onChangeAnthropicCompatibleConfiguration}
        onChangeAzureFoundryConfiguration={props.onChangeAzureFoundryConfiguration}
        onChangeOpenAiImageConfiguration={props.onChangeOpenAiImageConfiguration}
        onChangeGeminiImageConfiguration={props.onChangeGeminiImageConfiguration}
        onChangeBflImageConfiguration={props.onChangeBflImageConfiguration}
        onChangeIdeogramImageConfiguration={props.onChangeIdeogramImageConfiguration}
        onClearProviderCredential={props.onClearProviderCredential}
        onBeginProviderAuthentication={props.onBeginProviderAuthentication}
        onOpenExternalUrl={props.onOpenExternalUrl}
        onCompleteProviderAuthentication={props.onCompleteProviderAuthentication}
        {...(props.onUpdateProviderCli === undefined
          ? {}
          : { onUpdateProviderCli: props.onUpdateProviderCli })}
        onMove={move}
        onProbe={props.onProbe}
        onVerifyFoundryTools={props.onVerifyFoundryTools}
        hiddenModels={props.defaults.hiddenModels ?? []}
        onHiddenModelsChange={props.onHiddenModelsChange}
        onProviderCredentialStatus={props.onProviderCredentialStatus}
        onRemove={props.onRemove}
        onRename={props.onRename}
        onSetEnabled={props.onSetEnabled}
        onDataTagsChange={props.onDataTagsChange}
        onModelDataTagsChange={props.onModelDataTagsChange}
        probing={props.probingIds.has(instance.id)}
        updating={props.updatingIds?.has(instance.id) === true}
        reordering={reordering}
      />
    );
  }

  return props.status !== "ready" && ordered.length === 0 ? null : (
    <>
      <section
        aria-label="Providers"
        className="settings-card-section settings-card-section--open provider-list"
      >
        {/* The pane is already titled "Providers"; this label names the list
            against the detection section above it. */}
        <div className="settings-section-head">
          <h2>{props.heading ?? "Configured providers"}</h2>
          {props.showReorder === false || ordered.length < 2 ? null : (
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
        <p className="settings-section-note">
          {reordering
            ? "Use the arrow controls to change the model-picker order."
            : (props.note ?? "The first ready provider is the default for new threads.")}
        </p>
        {ordered.length === 0 ? null : (
          <p
            aria-label="Provider readiness summary"
            className="oct-meta provider-settings__summary"
            role="status"
          >
            {readinessSummary.ready} ready · {readinessSummary.needsSetup} needs setup ·{" "}
            {readinessSummary.off} off
          </p>
        )}
        {ordered.length === 0 ? (
          <p className="settings-section-line">No providers configured.</p>
        ) : !showDetectionGroups ? (
          // Surfaces with no detection story keep one list; reorder mode must
          // show the real stored order the grips edit. Rows still keep
          // binary-backed providers fail-closed.
          <div className="provlist">
            {ordered.map((instance, index) => renderProviderRow(instance, index))}
          </div>
        ) : (
          <>
            {groups.detected.length === 0 ? null : (
              <>
                <h3 className="oct-section-label">Detected on this host</h3>
                <div className="provlist">
                  {groups.detected.map(({ instance, index }) => renderProviderRow(instance, index))}
                </div>
              </>
            )}
            {groups.notFound.length === 0 ? null : (
              <>
                <h3 className="oct-section-label">Supported, not detected</h3>
                <div className="provlist">
                  {groups.notFound.map(({ instance, index }) => renderProviderRow(instance, index))}
                </div>
              </>
            )}
            {groups.other.length === 0 ? null : (
              <>
                <h3 className="oct-section-label">Other providers</h3>
                <div className="provlist">
                  {groups.other.map(({ instance, index }) => renderProviderRow(instance, index))}
                </div>
              </>
            )}
          </>
        )}
        {props.createForm === undefined ? null : (
          <div className="provider-settings__foot">{props.createForm}</div>
        )}
      </section>
      {ordered.length === 0 || props.showAgentEligibleModels === false ? null : (
        <AgentEligibleModelsControls
          agentEligibleModels={props.defaults.agentEligibleModels}
          busy={busy}
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
  readonly updating: boolean;
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
  readonly onChangeGooseConfiguration: ProviderSettingsViewProps["onChangeGooseConfiguration"];
  readonly onChangeGlmConfiguration: ProviderSettingsViewProps["onChangeGlmConfiguration"];
  readonly onChangeGeminiConfiguration: ProviderSettingsViewProps["onChangeGeminiConfiguration"];
  readonly onChangeCopilotConfiguration: ProviderSettingsViewProps["onChangeCopilotConfiguration"];
  readonly onChangeClineConfiguration: ProviderSettingsViewProps["onChangeClineConfiguration"];
  readonly onChangeQwenConfiguration: ProviderSettingsViewProps["onChangeQwenConfiguration"];
  readonly onChangeOpenAiCompatibleConfiguration: ProviderSettingsViewProps["onChangeOpenAiCompatibleConfiguration"];
  readonly onChangeAnthropicCompatibleConfiguration: ProviderSettingsViewProps["onChangeAnthropicCompatibleConfiguration"];
  readonly onChangeAzureFoundryConfiguration: ProviderSettingsViewProps["onChangeAzureFoundryConfiguration"];
  readonly onChangeOpenAiImageConfiguration: ProviderSettingsViewProps["onChangeOpenAiImageConfiguration"];
  readonly onChangeGeminiImageConfiguration: ProviderSettingsViewProps["onChangeGeminiImageConfiguration"];
  readonly onChangeBflImageConfiguration: ProviderSettingsViewProps["onChangeBflImageConfiguration"];
  readonly onChangeIdeogramImageConfiguration: ProviderSettingsViewProps["onChangeIdeogramImageConfiguration"];
  readonly onProviderCredentialStatus: ProviderSettingsViewProps["onProviderCredentialStatus"];
  readonly onClearProviderCredential: ProviderSettingsViewProps["onClearProviderCredential"];
  readonly onBeginProviderAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onOpenExternalUrl?: ProviderSettingsViewProps["onOpenExternalUrl"];
  readonly onCompleteProviderAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
  readonly onUpdateProviderCli?: ProviderSettingsViewProps["onUpdateProviderCli"];
  readonly onSetEnabled: ProviderSettingsViewProps["onSetEnabled"];
  readonly onDataTagsChange: ProviderSettingsViewProps["onDataTagsChange"];
  readonly onModelDataTagsChange: ProviderSettingsViewProps["onModelDataTagsChange"];
  readonly onRemove: ProviderSettingsViewProps["onRemove"];
  readonly onProbe: ProviderSettingsViewProps["onProbe"];
  readonly onVerifyFoundryTools: ProviderSettingsViewProps["onVerifyFoundryTools"];
  readonly hiddenModels: ReadonlyArray<HiddenProviderModelRef>;
  readonly onHiddenModelsChange: ProviderSettingsViewProps["onHiddenModelsChange"];
}

function ProviderRow(props: ProviderRowProps) {
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(
    () => !props.probing && props.observed?.readiness === "unauthenticated",
  );
  const [modelQuery, setModelQuery] = useState("");
  const hiddenModelIds = useMemo(
    () =>
      new Set(
        props.hiddenModels
          .filter((ref) => ref.providerInstanceId === props.instance.id)
          .map((ref) => ref.modelId),
      ),
    [props.hiddenModels, props.instance.id],
  );
  const shownModelCount =
    props.observed?.models.filter((model) => !hiddenModelIds.has(model.id)).length ?? 0;
  const modelSearch = modelQuery.trim().toLowerCase();
  const visibleModelRows =
    props.observed?.models.filter((model) =>
      `${model.displayName} ${model.id}`.toLowerCase().includes(modelSearch),
    ) ?? [];
  const disabled = props.busy || props.probing || props.updating;
  const readiness = props.updating || props.probing ? "checking" : props.observed?.readiness;
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(() => readiness !== "ready");
  useEffect(() => {
    if (readiness === "unauthenticated") setDetailsOpen(true);
  }, [readiness]);
  const detectedLocally = isDetectedLocally(props.instance, props.discoverySnapshot);
  const canEnable = canEnableProvider(props.instance, props.discoverySnapshot, detectedLocally);
  const detectedButDisabled = !props.instance.enabled && detectedLocally;
  const enableBlocked = !props.instance.enabled && !canEnable;
  // A disabled binary-backed provider the finished scan never searched for:
  // the switch stays usable and the row says why the scan is silent.
  const absenceUnproven =
    !props.instance.enabled &&
    canEnable &&
    !detectedLocally &&
    providerBinaryPath(props.instance) !== undefined;
  const isCli =
    props.instance.driverKind === "codex" ||
    props.instance.driverKind === "opencode" ||
    props.instance.driverKind === "kimi-code";
  const isClaude = props.instance.driverKind === "claude";
  const isVibe = props.instance.driverKind === "mistral-vibe";
  const isGrok = props.instance.driverKind === "grok";
  const isGoose = props.instance.driverKind === "goose";
  const isGlm = props.instance.driverKind === "glm";
  const isGemini = props.instance.driverKind === "gemini";
  const isCopilot = props.instance.driverKind === "copilot";
  const isCline = props.instance.driverKind === "cline";
  const isQwen = props.instance.driverKind === "qwen";
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
  const isBflImage = props.instance.driverKind === "bfl-image";
  const isIdeogramImage = props.instance.driverKind === "ideogram-image";
  const isImageProfile = isOpenAiImage || isGeminiImage || isBflImage || isIdeogramImage;
  const usesCredential =
    isHttp ||
    isAnthropicHttp ||
    isFoundry ||
    isImageProfile ||
    ((isClaude || isVibe || isGrok || isGlm || isGemini || isCline || isQwen) &&
      props.instance.configuration.authentication === "api-key");
  const credential = useCredentialStatus(props, !usesCredential);
  const setupGuidance = guidance(props.instance, readiness, props.observed);
  const hasSetupGuidance =
    detectedButDisabled ||
    usesCredential ||
    (setupGuidance !== null && setupGuidance !== undefined);
  const label = driverLabel(props.instance.driverKind);
  const providerTags = props.instance.dataTags ?? [];
  const runtimeLabel = isClaude
    ? "Agent SDK"
    : isVibe ||
        isGrok ||
        isGoose ||
        isGlm ||
        isGemini ||
        isCopilot ||
        isCline ||
        isQwen ||
        isDevin ||
        isKilo
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
    if (updated && nextEnabled && detectedButDisabled) {
      // Enabling a detected provider is a successful settings mutation even
      // when its first connection check reports missing setup. Keep that
      // row-level readiness fact visible without making the page banner say
      // that activation itself failed.
      await props.onProbe(props.instance.id, { quiet: true });
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
        <span className="prov-name oct-row-label">
          {name}
          {detectedLocally ? (
            <span
              aria-label="Detected locally"
              className="provider-settings__local-mark"
              title="Detected locally on this host"
            >
              <CheckCircle2 aria-hidden="true" size={14} strokeWidth={2} />
            </span>
          ) : null}
        </span>
        <span className="prov-meta oct-meta">
          {label} {runtimeLabel}
        </span>
        {absenceUnproven ? (
          <span className="prov-meta provider-settings__scan-note">
            Not found by the latest scan in the locations it searched — you can still enable it; the
            host checks the binary first.
          </span>
        ) : null}
      </span>
      <span className="prov-observation">
        <span className="prov-models oct-meta">
          {props.observed === undefined ||
          (props.observed.models.length === 0 && props.observed.readiness !== "ready")
            ? null
            : `${props.observed.models.length} ${props.observed.models.length === 1 ? "model" : "models"}`}
        </span>
        <span className="prov-status">
          <span
            className="prov-state"
            data-tone={readinessTone(props.instance.enabled ? readiness : undefined)}
          >
            {!props.instance.enabled
              ? "Off"
              : props.updating
                ? "Updating"
                : readiness === undefined
                  ? "Not checked"
                  : providerRowReadinessLabel(readiness, props.observed?.models.length ?? 0)}
          </span>
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
          disabled={disabled || enableBlocked}
          {...(enableBlocked
            ? { disabledReason: providerDetectionBlockedReason(props.discoverySnapshot) }
            : {})}
          label={`Enable ${name}`}
          onCheckedChange={() => void toggleEnabled()}
        />
      </span>
      {detailsOpen ? (
        <div className="prov-details" id={`provider-details-${props.instance.id}`}>
          {hasSetupGuidance ? (
            <section
              aria-label={`Setup for ${name}`}
              className="provider-details__section provider-details__section--connection"
            >
              {detectedButDisabled ? (
                <p className="provider-card__guidance">Detected on this host — enable to use</p>
              ) : null}
              {setupGuidance}
              {usesCredential && !props.credentialManagementAvailable ? (
                <p className="provider-card__guidance">
                  Manage credentials in the Octant host app. Credential replacement, clearing, and
                  provider removal are unavailable in this browser.
                </p>
              ) : null}
              {usesCredential ? (
                <p className="provider-card__credential-status">
                  Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
                </p>
              ) : null}
            </section>
          ) : null}
          <section
            aria-label={`Data handling labels for ${name}`}
            className="provider-details__section provider-data-tags"
          >
            <div>
              <h4 className="oct-section-label">Data handling</h4>
              <p className="oct-row-detail">Use these labels for project residency policies.</p>
            </div>
            <div className="provider-data-tags__controls">
              {(["eu", "zdr"] as const).map((tag) => (
                <DataTagButton
                  disabled={disabled}
                  key={tag}
                  selected={providerTags.includes(tag)}
                  tag={tag}
                  onClick={() =>
                    void props.onDataTagsChange(props.instance.id, toggleDataTag(providerTags, tag))
                  }
                />
              ))}
            </div>
          </section>
          <div className="provider-card__actions">
            {isImageProfile ? null : (
              <OctantButton
                aria-label={`Check connection for ${props.instance.displayName}`}
                disabled={disabled || !props.instance.enabled}
                onClick={() => void props.onProbe(props.instance.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                {props.probing ? "Checking…" : "Check connection"}
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
            {props.onUpdateProviderCli !== undefined &&
            supportsProviderCliUpdate(props.instance.driverKind) ? (
              <OctantButton
                aria-label={`Update ${props.instance.displayName} CLI`}
                disabled={disabled || !props.instance.enabled}
                onClick={() => void props.onUpdateProviderCli?.(props.instance.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                {props.updating ? "Updating…" : "Update CLI"}
              </OctantButton>
            ) : null}
            <OctantButton
              aria-label={`Remove ${props.instance.displayName}`}
              disabled={disabled || (usesCredential && !props.credentialManagementAvailable)}
              onClick={() => void props.onRemove(props.instance.id)}
              size="sm"
              type="button"
              variant="destructive"
            >
              Remove
            </OctantButton>
          </div>
          {configurationOpen ? (
            <section
              aria-labelledby={`configuration-${props.instance.id}`}
              className="provider-card__configuration provider-details__section provider-details__section--configuration"
              data-expanded="true"
              id={`provider-configuration-${props.instance.id}`}
            >
              <h3 id={`configuration-${props.instance.id}`}>Configuration</h3>
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
                <OctantButton
                  disabled={disabled}
                  type="submit"
                  variant="outline"
                  size="sm"
                  aria-label={`Save name for ${props.instance.displayName}`}
                >
                  Save
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
                  <OctantButton
                    disabled={disabled}
                    type="submit"
                    variant="outline"
                    size="sm"
                    aria-label={`Save binary path for ${props.instance.displayName}`}
                  >
                    Save
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
                  onChange={props.onChangeMistralVibeConfiguration}
                />
              ) : isGrok ? (
                <GrokConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`grok:${props.instance.version}`}
                  onChange={props.onChangeGrokConfiguration}
                />
              ) : isGoose ? (
                <GooseConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`goose:${props.instance.version}`}
                  onChange={props.onChangeGooseConfiguration}
                />
              ) : isGlm ? (
                <GlmConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`glm:${props.instance.version}`}
                  onChange={props.onChangeGlmConfiguration}
                />
              ) : isGemini ? (
                <GeminiConfigurationForm
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`gemini:${props.instance.version}`}
                  onChange={props.onChangeGeminiConfiguration}
                />
              ) : isCopilot ? (
                <CopilotConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`copilot:${props.instance.version}`}
                  onChange={props.onChangeCopilotConfiguration}
                />
              ) : isCline ? (
                <ClineConfigurationForm
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`cline:${props.instance.version}`}
                  onChange={props.onChangeClineConfiguration}
                />
              ) : isQwen ? (
                <QwenConfigurationForm
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`qwen:${props.instance.version}`}
                  onChange={props.onChangeQwenConfiguration}
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
              ) : isBflImage ? (
                <BflImageConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`bfl-image:${props.instance.version}`}
                  onChange={props.onChangeBflImageConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              ) : isIdeogramImage ? (
                <IdeogramImageConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`ideogram-image:${props.instance.version}`}
                  onChange={props.onChangeIdeogramImageConfiguration}
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
            </section>
          ) : null}
          {props.observed === undefined ? null : (
            <div className="provider-card__discovery provider-details__section provider-details__section--catalog">
              <section
                className="provider-model-visibility"
                aria-labelledby={`models-${props.instance.id}`}
              >
                <div className="provider-model-visibility__head">
                  <div>
                    <h4 className="oct-section-label" id={`models-${props.instance.id}`}>
                      Models
                    </h4>
                    <p className="oct-row-detail">Choose which models appear in new selections.</p>
                  </div>
                  <span className="provider-model-visibility__count" aria-live="polite">
                    {props.observed.models.length === 0
                      ? "No models"
                      : modelSearch === ""
                        ? `${props.observed.models.length} model${props.observed.models.length === 1 ? "" : "s"} · ${shownModelCount} shown`
                        : `${visibleModelRows.length} match${visibleModelRows.length === 1 ? "" : "es"} · ${shownModelCount} shown`}
                  </span>
                </div>
                {props.observed.models.length === 0 ? null : (
                  <div className="provider-model-visibility__search">
                    <OctantInput
                      aria-label={`Search models for ${props.instance.displayName}`}
                      onChange={(event) => setModelQuery(event.currentTarget.value)}
                      placeholder="Search models"
                      value={modelQuery}
                    />
                  </div>
                )}
                {props.observed.models.length === 0 ? (
                  <p>No models reported.</p>
                ) : (
                  <ul
                    aria-label={`${props.instance.displayName} models`}
                    className="provider-model-visibility__list"
                    id={`model-list-${props.instance.id}`}
                  >
                    {visibleModelRows.map((model) => {
                      const hidden = hiddenModelIds.has(model.id);
                      const modelLabel =
                        !isHttp && !isAnthropicHttp && !isFoundry
                          ? model.displayName
                          : `${model.displayName} · ${titleCase(model.source)} · ${titleCase(model.verification)}`;
                      return (
                        <li key={model.id}>
                          <span className="provider-model-visibility__name" title={modelLabel}>
                            {modelLabel}
                            <span
                              aria-label={`Data handling labels for ${model.displayName}`}
                              className="provider-data-tags__inline"
                            >
                              {(["eu", "zdr"] as const).map((tag) => (
                                <DataTagButton
                                  disabled={disabled}
                                  key={tag}
                                  selected={(model.dataTags ?? []).includes(tag)}
                                  tag={tag}
                                  onClick={() =>
                                    void props.onModelDataTagsChange(
                                      props.instance.id,
                                      model.id,
                                      toggleDataTag(model.dataTags ?? [], tag),
                                    )
                                  }
                                />
                              ))}
                            </span>
                          </span>
                          <OctantSwitch
                            checked={!hidden}
                            disabled={disabled}
                            label={`${hidden ? "Show" : "Hide"} ${model.displayName} in model pickers`}
                            onCheckedChange={(checked) => {
                              const next = props.hiddenModels.filter(
                                (ref) =>
                                  !(
                                    ref.providerInstanceId === props.instance.id &&
                                    ref.modelId === model.id
                                  ),
                              );
                              if (!checked) {
                                next.push({
                                  providerInstanceId: props.instance.id,
                                  modelId: model.id,
                                });
                              }
                              void props.onHiddenModelsChange(next);
                            }}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
                {props.observed.models.length > 0 && visibleModelRows.length === 0 ? (
                  <p className="oct-row-detail">No models match this filter.</p>
                ) : null}
              </section>
            </div>
          )}
          <div className="provider-details__connection-disclosure">
            <OctantButton
              aria-controls={`connection-body-${props.instance.id}`}
              aria-expanded={connectionDetailsOpen}
              className="provider-details__connection-trigger"
              onClick={() => {
                setConnectionDetailsOpen((current) => !current);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Connection details
              <ChevronRight aria-hidden="true" size={14} />
            </OctantButton>
            {connectionDetailsOpen ? (
              <div
                className="provider-details__connection-body"
                id={`connection-body-${props.instance.id}`}
              >
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
                {providerBinaryPath(props.instance) === undefined ? null : (
                  <div className="provider-card__facts provider-card__facts--cli-update">
                    <span>
                      CLI updates:{" "}
                      {supportsProviderCliUpdate(props.instance.driverKind)
                        ? "Provider-owned update available on this host"
                        : "Manual installation required on this host"}
                    </span>
                  </div>
                )}
                {props.observed?.readiness === "incompatible" ? null : (
                  <div className="provider-card__facts provider-card__facts--diagnostic">
                    {providerProcessDiagnosticFacts(props.observed).map((fact) => (
                      <span key={fact.label}>
                        {fact.label}: {fact.value}
                      </span>
                    ))}
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
                    <span>
                      Authentication: {titleCase(props.instance.configuration.authentication)}
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
                    <span>
                      Authentication: {titleCase(props.instance.configuration.authentication)}
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
                            onClick={() =>
                              void props.onVerifyFoundryTools(props.instance.id, modelId)
                            }
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
                  </div>
                )}
                {!isGoose ? null : (
                  <div className="provider-card__facts provider-card__facts--goose">
                    <span>Authentication: provider-owned Goose credentials</span>
                  </div>
                )}
                {!isGlm ? null : (
                  <div className="provider-card__facts provider-card__facts--glm">
                    <span>Authentication: Z.AI API key</span>
                  </div>
                )}
                {!isGemini ? null : (
                  <div className="provider-card__facts provider-card__facts--gemini">
                    <span>Authentication: Gemini API key</span>
                  </div>
                )}
                {!isCopilot ? null : (
                  <div className="provider-card__facts provider-card__facts--copilot">
                    <span>Authentication: provider-owned GitHub Copilot credentials</span>
                  </div>
                )}
                {!isCline ? null : (
                  <div className="provider-card__facts provider-card__facts--cline">
                    <span>Authentication: Cline API key</span>
                  </div>
                )}
                {!isQwen ? null : (
                  <div className="provider-card__facts provider-card__facts--qwen">
                    <span>Authentication: OpenAI-compatible API key</span>
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
                  </div>
                )}
                {!isBflImage ? null : (
                  <div className="provider-card__facts provider-card__facts--image">
                    <span>Default model: {props.instance.configuration.defaultModel}</span>
                    <span>Allowlist: {props.instance.configuration.modelAllowlist.join(", ")}</span>
                  </div>
                )}
                {!isIdeogramImage ? null : (
                  <div className="provider-card__facts provider-card__facts--image">
                    <span>Default model: {props.instance.configuration.defaultModel}</span>
                    <span>Allowlist: {props.instance.configuration.modelAllowlist.join(", ")}</span>
                  </div>
                )}
                {props.instance.driverKind === "codex" ||
                props.instance.driverKind === "kimi-code" ||
                isClaude ||
                isVibe ||
                isGrok ||
                isGoose ||
                isGlm ||
                isGemini ||
                isCopilot ||
                isCline ||
                isQwen ||
                isDevin ||
                isKilo ||
                isPi ||
                isOhMyPi ? (
                  <p className="provider-card__authority-note">
                    Provider approvals stay one-shot. Use “Current session only”; “Remember for this
                    Project” does not extend provider authority.
                  </p>
                ) : null}
                {props.observed === undefined ? null : (
                  <section
                    aria-labelledby={`capabilities-${props.instance.id}`}
                    className="provider-details__section provider-details__section--capabilities"
                  >
                    <h4 className="oct-section-label" id={`capabilities-${props.instance.id}`}>
                      Capabilities
                    </h4>
                    <p className="oct-row-detail">Reported by the last connection check.</p>
                    <dl>
                      {capabilityLabels.map(([key, label]) => (
                        <div key={key}>
                          <dt>{label}</dt>
                          <dd>{titleCase(props.observed!.capabilities[key])}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * The state text reports fact (reachable right now), never intent (the
 * switch). "checking" and "not checked" stay neutral because no reachability
 * claim has been established either way.
 */
function readinessTone(
  readiness: ProviderObservedState["readiness"] | undefined,
): "ok" | "warn" | "danger" | "neutral" {
  if (readiness === "ready") return "ok";
  if (readiness === "degraded" || readiness === "unauthenticated") return "warn";
  if (readiness === "unavailable" || readiness === "incompatible") return "danger";
  return "neutral";
}

/**
 * Presence evidence comes only from the current scan. `autoRegisteredInstanceIds`
 * records what an earlier scan created, so it is history, not current presence.
 * A scan that has not run, failed, or was cancelled proves nothing either way.
 *
 * The scan probes the executable's canonical path, while an instance stores the
 * path the user configured (Homebrew's `/opt/homebrew/bin/codex` symlink is the
 * usual spelling). Either the canonical `binaryPath` or the `discoveredPath`
 * the scan actually examined identifies the instance.
 */
function isDetectedLocally(
  instance: ProviderInstance,
  snapshot: DiscoverySnapshot | undefined,
): boolean {
  if (snapshot === undefined || snapshot.status === "failed" || snapshot.status === "cancelled") {
    return false;
  }
  if (instance.driverKind === "ollama") {
    return snapshot.candidates.some((candidate) => candidate.driverKind === "ollama");
  }
  const binaryPath = providerBinaryPath(instance);
  return (
    binaryPath !== undefined &&
    snapshot.candidates.some(
      (candidate) =>
        candidate.driverKind === instance.driverKind &&
        (candidate.binaryPath === binaryPath || candidate.discoveredPath === binaryPath),
    )
  );
}

/**
 * A binary-backed provider stays fail-closed while presence is unknown: an
 * unrun, failed, or cancelled scan is not proof that the binary exists. A
 * finished scan proves absence only for a directory it actually searched, so a
 * binary outside those locations stays enable-able even when the scan did not
 * find it; the server refuses to enable a missing binary.
 */
function canEnableProvider(
  instance: ProviderInstance,
  snapshot: DiscoverySnapshot | undefined,
  detectedLocally: boolean,
): boolean {
  const binaryPath = providerBinaryPath(instance);
  if (binaryPath === undefined || detectedLocally) return true;
  if (snapshot === undefined || snapshot.status === "failed" || snapshot.status === "cancelled") {
    return false;
  }
  return !isAbsenceProven(binaryPath, instance.driverKind, snapshot);
}

/**
 * Whether the current scan searched the directory holding this path and found
 * nothing for this provider. Silence about a directory the scan never visited,
 * or a driverKind the scan never finished, proves nothing, so a missing or
 * pre-`searchedDirectories` snapshot never proves absence.
 */
function isAbsenceProven(
  binaryPath: string,
  driverKind: ProviderInstance["driverKind"],
  snapshot: DiscoverySnapshot | undefined,
): boolean {
  if (snapshot === undefined || snapshot.status === "failed" || snapshot.status === "cancelled") {
    return false;
  }
  const coverage = snapshot.searchedDirectories;
  if (coverage === undefined || coverage.length === 0) return false;
  const directory = directoryOf(binaryPath);
  const driverCoverage = coverage.find((entry) => entry.driverKind === driverKind);
  if (driverCoverage === undefined) return false;
  return driverCoverage.directories.some((candidate) => candidate === directory);
}

/** The parent directory of an absolute path, without node's path module. */
function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function providerBinaryPath(instance: ProviderInstance): string | undefined {
  return "binaryPath" in instance.configuration ? instance.configuration.binaryPath : undefined;
}

function authenticationGuidance(instance: ProviderInstance): string {
  switch (instance.driverKind) {
    case "codex":
      return "Run codex login in your terminal, then check the connection again.";
    case "opencode":
      return "Authenticate with OpenCode, then check the connection again.";
    case "kimi-code":
      return "Run kimi login in your terminal, then check the connection again.";
    case "devin":
      return "Run devin auth login in your terminal, then check the connection again.";
    case "pi":
      return "Authenticate with the official Pi CLI, then check the connection again.";
    case "oh-my-pi":
      return "Install and authenticate Oh My Pi (`omp`), then check the connection again. Octant treats Oh My Pi as distinct from Pi.";
    case "kilo":
      return "Run kilo auth login in your terminal, then check the connection again.";
    case "claude":
      return instance.configuration.authentication === "api-key"
        ? "Add or replace the Anthropic API key in the Octant host. It remains write-only and is stored in Keychain, then check the connection again."
        : "Authenticate with the official Claude Code app or CLI, then check the connection again.";
    case "mistral-vibe":
      return instance.configuration.authentication === "api-key"
        ? "Add or replace the Mistral API key in the Octant host, then check the connection again."
        : "Run the provider-owned Vibe CLI login in your terminal, then check the connection again.";
    case "grok":
      return instance.configuration.authentication === "api-key"
        ? "Add or replace the xAI API key in the Octant host, then check the connection again."
        : "Run grok login in your terminal (or grok login --device-auth on a headless host), then check the connection again.";
    case "goose":
      return "Run `goose configure` in your terminal, then check the connection again.";
    case "glm":
      return instance.configuration.authentication === "api-key"
        ? "Add or replace the Z.AI API key in the Octant host, then check the connection again."
        : "Run the provider-owned GLM Agent CLI login in your terminal, then check the connection again.";
    case "gemini":
      return instance.configuration.authentication === "api-key"
        ? "Add or replace the Gemini API key in the Octant host, then check the connection again."
        : "Run Gemini CLI in your terminal and complete its provider-owned login, then check the connection again.";
    case "copilot":
      return "Run `copilot login` in your terminal, then check the connection again.";
    case "cline":
      return instance.configuration.authentication === "api-key"
        ? "Add or replace the Cline API key in the Octant host, then check the connection again."
        : "Run `cline auth` in your terminal, then check the connection again.";
    case "qwen":
      return instance.configuration.authentication === "api-key"
        ? "Add or replace the OpenAI-compatible API key in the Octant host, then check the connection again."
        : "Run the provider-owned Qwen CLI login in your terminal, then check the connection again.";
    case "anthropic-compatible":
      return "Add or replace the Anthropic API key in the Octant host. It remains write-only and is stored in Keychain, then check the connection again.";
    case "azure-foundry":
      return "Add or replace the Azure AI Foundry API key in the Octant host. It is stored in Keychain and sent as the api-key header, then check the connection again.";
    default:
      return "Add a bearer API key in the Octant host, then check the connection again.";
  }
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
    return <p className="provider-card__guidance">{authenticationGuidance(instance)}</p>;
  if (readiness === "incompatible") {
    const nextAction =
      driverKind === "openai-compatible" ||
      driverKind === "anthropic-compatible" ||
      driverKind === "azure-foundry"
        ? "The endpoint returned an incompatible protocol response. Review its API compatibility."
        : driverKind === "ollama"
          ? "The loopback endpoint returned an incompatible native Ollama response. Update Ollama or verify the native API endpoint."
          : driverKind === "kimi-code"
            ? "The Kimi Code runtime or its provider-owned profile is incompatible. Review the connection detail and supported version before retrying."
            : observed?.diagnostic?.kind === "version-mismatch"
              ? `The installed ${label} version is incompatible. Review the installed and supported versions before retrying.`
              : `The ${label} runtime is incompatible. Review the connection details before retrying.`;
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
  // Oh My Pi's probe reports `unavailable` after a successful discovery because
  // turn execution refuses; the generic "verify the binary path" advice would
  // send the user chasing a problem that does not exist.
  if (readiness === "unavailable" && driverKind === "oh-my-pi" && message !== undefined)
    return <p className="provider-card__guidance">{message}</p>;
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

function toggleDataTag(
  tags: ReadonlyArray<ProviderDataTag>,
  tag: ProviderDataTag,
): ProviderDataTags {
  return tags.includes(tag) ? tags.filter((candidate) => candidate !== tag) : [...tags, tag];
}

function DataTagButton(props: {
  readonly tag: ProviderDataTag;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <OctantButton
      aria-pressed={props.selected}
      className="provider-data-tags__button"
      disabled={props.disabled}
      onClick={props.onClick}
      size="sm"
      type="button"
      variant={props.selected ? "secondary" : "ghost"}
    >
      {props.tag.toUpperCase()}
    </OctantButton>
  );
}
