import {
  ACP_AGENT_KINDS,
  type AcpAgentConfiguration,
  type AgentEligibleModelRef,
  type HiddenProviderModelRef,
  type AnthropicCompatibleProviderConfiguration,
  type AmazonBedrockProviderConfiguration,
  type AzureFoundryProviderConfiguration,
  type BflImageProviderConfiguration,
  type ClaudeProviderConfiguration,
  type CodexProviderConfiguration,
  type DiscoverySnapshot,
  type IdeogramImageProviderConfiguration,
  type GeminiImageProviderConfiguration,
  type OpenAiCompatibleProviderConfiguration,
  type OpenAiImageProviderConfiguration,
  type OllamaProviderConfiguration,
  type OhMyPiProviderConfiguration,
  type PiProviderConfiguration,
  type PermissionPersistence,
  type ProviderCredentialStatus,
  type ProviderAuthenticationAttempt,
  type ProviderDefaults,
  type ProviderDataTags,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderObservedState,
} from "@octant/contracts";
import {
  implicitClaudeAccountOwnerId,
  implicitCodexAccountOwnerId,
  isImageProfileDriverKind,
} from "@octant/domain";
import { useState, type ReactNode } from "react";
import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { SettingsSection } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OpenCodeManagedUpdate } from "./OpenCodeManagedUpdate";
import type { OctantHostBridge } from "../shell/hostBridge";
import {
  ProviderCreateForm,
  type ProviderCreateProviderType,
} from "./ProviderSettingsConfiguration";
import { ProviderSettingsList } from "./ProviderSettingsList";
import { isModelEndpointDriverKind } from "./providerSettingsPresentation";
import type { ModelToolVerification, TransientProviderCredential } from "./useProviderController";
import type { LocateBinaryOutcome } from "./useDiscoveryController";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface ProviderSettingsViewProps {
  readonly status: "loading" | "ready" | "disconnected";
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly usageLimitsClient?: ProviderUsageLimitsClient;
  readonly discoverySnapshot?: DiscoverySnapshot;
  readonly discovery?: ReactNode;
  readonly defaults: ProviderDefaults;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  /**
   * A presentation-only projection used while a probe replaces an observation.
   * It may retain the last known model geometry, but never feeds authority or
   * model eligibility decisions.
   */
  readonly presentationObservedByInstance?: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly probingIds: ReadonlySet<ProviderInstanceId>;
  readonly updatingIds?: ReadonlySet<ProviderInstanceId>;
  readonly busy: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly message?: string;
  readonly hostBridge?: OctantHostBridge;
  /** Open provider-owned sign-in pages through the desktop host bridge. */
  readonly onOpenExternalUrl?: (url: string) => void;
  readonly onCreate: (
    driverKind: "opencode" | "codex" | "pi" | "oh-my-pi",
    displayName: string,
    binaryPath: string,
    accent?: string,
  ) => Promise<boolean>;
  /** Creates any ACP agent; an API-key posture carries the key to store. */
  readonly onCreateAcpAgent: (
    displayName: string,
    configuration: AcpAgentConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateOpenAiCompatible: (
    displayName: string,
    configuration: OpenAiCompatibleProviderConfiguration,
    credential: TransientProviderCredential,
    preassignedInstanceId?: ProviderInstanceId,
  ) => Promise<boolean>;
  readonly onCreateAnthropicCompatible: (
    displayName: string,
    configuration: AnthropicCompatibleProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateAzureFoundry: (
    displayName: string,
    configuration: AzureFoundryProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  /** Amazon Bedrock takes no key: it signs in from the host's terminal once added. */
  readonly onCreateAmazonBedrock: (
    displayName: string,
    configuration: AmazonBedrockProviderConfiguration,
  ) => Promise<boolean>;
  readonly onCreateOpenAiImage: (
    displayName: string,
    configuration: OpenAiImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateGeminiImage: (
    displayName: string,
    configuration: GeminiImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateBflImage: (
    displayName: string,
    configuration: BflImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateIdeogramImage: (
    displayName: string,
    configuration: IdeogramImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateClaude: (
    displayName: string,
    configuration: ClaudeProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateOllama: (
    displayName: string,
    configuration: OllamaProviderConfiguration,
  ) => Promise<boolean>;
  readonly onRename: (instanceId: ProviderInstanceId, displayName: string) => Promise<boolean>;
  readonly onChangeBinary: (instanceId: ProviderInstanceId, binaryPath: string) => Promise<boolean>;
  /**
   * "Locate binary" on a runtime card: the host's native file picker chooses
   * the executable and the host checks it. Absent where there is no picker.
   */
  readonly onLocateBinary?: (instanceId: ProviderInstanceId) => Promise<LocateBinaryOutcome>;
  /**
   * A runtime card's offer to use a binary the host's latest scan found, when
   * the card's own binary is missing or incompatible. The host accepts only a
   * path from that scan and checks it first.
   */
  readonly onUseScannedBinary?: (
    instanceId: ProviderInstanceId,
    binaryPath: string,
  ) => Promise<LocateBinaryOutcome>;
  readonly onChangeOpenAiCompatibleConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: OpenAiCompatibleProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeAnthropicCompatibleConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: AnthropicCompatibleProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeAzureFoundryConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: AzureFoundryProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeAmazonBedrockConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: AmazonBedrockProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangeOpenAiImageConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: OpenAiImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeGeminiImageConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: GeminiImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeBflImageConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: BflImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeIdeogramImageConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: IdeogramImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeCodexConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: CodexProviderConfiguration,
    options?: { readonly reassignAccountDirectory?: boolean },
  ) => Promise<boolean>;
  readonly onChangeClaudeConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: ClaudeProviderConfiguration,
    credential: TransientProviderCredential,
    options?: { readonly reassignAccountDirectory?: boolean },
  ) => Promise<boolean>;
  /** Reconfigures any ACP agent; an API-key posture may carry a new key. */
  readonly onChangeAcpAgentConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: AcpAgentConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangePiConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: PiProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangeOhMyPiConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: OhMyPiProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangeOllamaConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: OllamaProviderConfiguration,
  ) => Promise<boolean>;
  readonly onBeginProviderAuthentication: (
    instanceId: ProviderInstanceId,
  ) => Promise<ProviderAuthenticationAttempt | undefined>;
  readonly onCompleteProviderAuthentication: (
    instanceId: ProviderInstanceId,
    attemptId: ProviderAuthenticationAttempt["attemptId"],
  ) => Promise<boolean>;
  readonly onUpdateProviderCli?: (instanceId: ProviderInstanceId) => Promise<boolean>;
  readonly onProviderCredentialStatus: (
    instanceId: ProviderInstanceId,
  ) => Promise<ProviderCredentialStatus>;
  readonly onClearProviderCredential: (instanceId: ProviderInstanceId) => Promise<boolean>;
  readonly onProviderOAuth?: (
    command: import("./ProviderOAuthSignIn").ProviderOAuthCommand,
  ) => Promise<import("./ProviderOAuthSignIn").ProviderOAuthCommandResult | undefined>;
  readonly onSetEnabled: (instanceId: ProviderInstanceId, enabled: boolean) => Promise<boolean>;
  /** Turns delivering documents as Claude artifacts on or off for one Claude account. */
  readonly onSetClaudeArtifactDelivery?: (
    instanceId: ProviderInstanceId,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly onDataTagsChange: (
    instanceId: ProviderInstanceId,
    dataTags: ProviderDataTags,
  ) => Promise<boolean>;
  readonly onModelDataTagsChange: (
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    dataTags: ProviderDataTags,
  ) => Promise<boolean>;
  /** Sets or, with `undefined`, clears a model's context window override. */
  readonly onModelContextWindowChange?: (
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    contextWindow: number | undefined,
  ) => Promise<boolean>;
  readonly onRemove: (instanceId: ProviderInstanceId) => Promise<boolean>;
  readonly onProbe: (
    instanceId: ProviderInstanceId,
    options?: { readonly quiet?: boolean },
  ) => Promise<boolean>;
  readonly onVerifyModelTools: (
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => Promise<ModelToolVerification>;
  readonly onPermissionPersistenceChange: (value: PermissionPersistence) => Promise<boolean>;
  readonly onProviderOrderChange: (
    providerOrder: ReadonlyArray<ProviderInstanceId>,
  ) => Promise<boolean>;
  readonly onAgentEligibleModelsChange: (
    agentEligibleModels: ReadonlyArray<AgentEligibleModelRef>,
  ) => Promise<boolean>;
  readonly onHiddenModelsChange: (
    hiddenModels: ReadonlyArray<HiddenProviderModelRef>,
  ) => Promise<boolean>;
  readonly onRetry: () => Promise<boolean>;
}

function keepUnlistedProviderOrder(
  visibleOrder: ReadonlyArray<ProviderInstanceId>,
  stored: ReadonlyArray<ProviderInstanceId> | undefined,
): ReadonlyArray<ProviderInstanceId> {
  const visible = new Set(visibleOrder);
  const retained = (stored ?? []).filter((id) => !visible.has(id));
  return retained.length === 0 ? visibleOrder : [...visibleOrder, ...retained];
}

/**
 * Agent runtimes Octant drives: ACP agents, CLIs, the Agent SDK, and RPC
 * runtimes. Model endpoints Octant calls over HTTP itself are added under
 * Octant Harness › Model endpoints, and image profiles under Image generation.
 */
const GENERAL_PROVIDER_TYPES: ReadonlyArray<ProviderCreateProviderType> = [
  "opencode",
  "codex",
  "claude",
  "pi",
  "oh-my-pi",
  ...ACP_AGENT_KINDS,
];

interface AddAccountRequest {
  readonly sequence: number;
  readonly providerType: "claude" | "codex";
  readonly displayName: string;
  readonly binaryPath: string;
}

/**
 * The next free "<name> (n)" for another account of a card's driver, so the
 * model picker can tell the accounts apart before the person renames it.
 */
function suggestedAccountName(
  instances: ReadonlyArray<ProviderInstance>,
  source: ProviderInstance,
): string {
  // A trailing "(n)" is an account sequence only when an account of the same
  // driver carries the name without it; otherwise the number is the person's
  // own, as in "Claude Research (2024)", and stays part of the name.
  const unnumbered = source.displayName.replace(/\s*\(\d+\)$/, "").trim();
  const base =
    unnumbered !== source.displayName &&
    instances.some(
      (instance) =>
        instance.driverKind === source.driverKind &&
        instance.displayName.toLowerCase() === unnumbered.toLowerCase(),
    )
      ? unnumbered
      : source.displayName;
  const taken = new Set(instances.map((instance) => instance.displayName.toLowerCase()));
  let number = 2;
  while (taken.has(`${base} (${number})`.toLowerCase())) number += 1;
  return `${base} (${number})`;
}

export function ProviderSettingsView(props: ProviderSettingsViewProps) {
  const [addAccount, setAddAccount] = useState<AddAccountRequest | undefined>(undefined);
  // A card's "Add account" opens the same manual form for its driver. A created
  // account closes it again, so the suggested name is not offered twice.
  const created = async (operation: Promise<boolean>) => {
    const ok = await operation;
    if (ok) setAddAccount(undefined);
    return ok;
  };
  // The settings shell already renders the pane's `.oct-title` and
  // `.oct-subtitle`; repeating an identity heading here read as three titles
  // in a row, so the pane goes straight to the person's providers and their
  // Defaults. Finding more providers and Octant's own OpenCode copy follow:
  // the OpenCode box used to open the page, above the providers it serves.
  return (
    <div className="provider-settings">
      <div aria-live="polite" className="provider-settings__message-slot">
        {props.status === "loading" ? <p role="status">Loading providers…</p> : null}
        {props.status === "disconnected" ? (
          <OctantButton
            className="settings-view__action"
            onClick={() => void props.onRetry()}
            type="button"
          >
            Retry provider connection
          </OctantButton>
        ) : null}
        {props.message === undefined ? null : (
          <OctantAlert className="provider-settings__alert" tone="warning">
            {props.message}
          </OctantAlert>
        )}
      </div>
      <ProviderSettingsList
        busy={props.busy}
        onAddAccount={(source) => {
          if (source.driverKind !== "claude" && source.driverKind !== "codex") return;
          setAddAccount((current) => ({
            sequence: (current?.sequence ?? 0) + 1,
            providerType: source.driverKind,
            displayName: suggestedAccountName(props.instances, source),
            binaryPath: source.configuration.binaryPath,
          }));
        }}
        createForm={
          <ProviderCreateForm
            key={addAccount?.sequence ?? "manual"}
            allowedProviderTypes={GENERAL_PROVIDER_TYPES}
            {...(addAccount === undefined
              ? {}
              : {
                  initialProviderType: addAccount.providerType,
                  initialDisplayName: addAccount.displayName,
                  initialBinaryPath: addAccount.binaryPath,
                  openWithNameFocused: true,
                })}
            busy={props.busy}
            claudeHostProfileTaken={implicitClaudeAccountOwnerId(props.instances) !== undefined}
            codexHostProfileTaken={implicitCodexAccountOwnerId(props.instances) !== undefined}
            heading="Agent runtime"
            hint="Installed runtimes are detected automatically. Use this for an unusual executable location or a runtime the scan missed. Model endpoints such as OpenAI-compatible APIs are added under Octant Harness › Model endpoints."
            credentialManagementAvailable={props.credentialManagementAvailable}
            onCreate={(...args) => created(props.onCreate(...args))}
            onCreateAnthropicCompatible={props.onCreateAnthropicCompatible}
            onCreateAzureFoundry={props.onCreateAzureFoundry}
            onCreateClaude={(...args) => created(props.onCreateClaude(...args))}
            onCreateAcpAgent={props.onCreateAcpAgent}
            onCreateOllama={props.onCreateOllama}
            onCreateOpenAiCompatible={props.onCreateOpenAiCompatible}
            onCreateOpenAiImage={props.onCreateOpenAiImage}
            onCreateGeminiImage={props.onCreateGeminiImage}
            onCreateBflImage={props.onCreateBflImage}
            onCreateIdeogramImage={props.onCreateIdeogramImage}
          />
        }
        credentialManagementAvailable={props.credentialManagementAvailable}
        defaults={props.defaults}
        discoverySnapshot={props.discoverySnapshot}
        showDetectionGroups
        instances={props.instances.filter(
          (instance) =>
            !isImageProfileDriverKind(instance.driverKind) &&
            !isModelEndpointDriverKind(instance.driverKind),
        )}
        agentEligibleInstances={props.instances.filter(
          (instance) => !isImageProfileDriverKind(instance.driverKind),
        )}
        observedByInstance={props.observedByInstance}
        {...(props.presentationObservedByInstance === undefined
          ? {}
          : { presentationObservedByInstance: props.presentationObservedByInstance })}
        probingIds={props.probingIds}
        {...(props.updatingIds === undefined ? {} : { updatingIds: props.updatingIds })}
        status={props.status}
        onAgentEligibleModelsChange={props.onAgentEligibleModelsChange}
        onHiddenModelsChange={props.onHiddenModelsChange}
        onBeginProviderAuthentication={props.onBeginProviderAuthentication}
        {...(props.onOpenExternalUrl === undefined
          ? {}
          : { onOpenExternalUrl: props.onOpenExternalUrl })}
        onChangeAnthropicCompatibleConfiguration={props.onChangeAnthropicCompatibleConfiguration}
        onChangeAzureFoundryConfiguration={props.onChangeAzureFoundryConfiguration}
        onChangeBinary={props.onChangeBinary}
        {...(props.onLocateBinary === undefined ? {} : { onLocateBinary: props.onLocateBinary })}
        {...(props.onUseScannedBinary === undefined
          ? {}
          : { onUseScannedBinary: props.onUseScannedBinary })}
        {...(props.usageLimitsClient === undefined
          ? {}
          : { usageLimitsClient: props.usageLimitsClient })}
        onChangeClaudeConfiguration={props.onChangeClaudeConfiguration}
        onChangeCodexConfiguration={props.onChangeCodexConfiguration}
        onChangeAcpAgentConfiguration={props.onChangeAcpAgentConfiguration}
        onChangeOhMyPiConfiguration={props.onChangeOhMyPiConfiguration}
        onChangeOllamaConfiguration={props.onChangeOllamaConfiguration}
        onChangeOpenAiCompatibleConfiguration={props.onChangeOpenAiCompatibleConfiguration}
        onChangeOpenAiImageConfiguration={props.onChangeOpenAiImageConfiguration}
        onChangeGeminiImageConfiguration={props.onChangeGeminiImageConfiguration}
        onChangeBflImageConfiguration={props.onChangeBflImageConfiguration}
        onChangeIdeogramImageConfiguration={props.onChangeIdeogramImageConfiguration}
        onChangePiConfiguration={props.onChangePiConfiguration}
        onClearProviderCredential={props.onClearProviderCredential}
        {...(props.onProviderOAuth === undefined ? {} : { onProviderOAuth: props.onProviderOAuth })}
        onCompleteProviderAuthentication={props.onCompleteProviderAuthentication}
        {...(props.onUpdateProviderCli === undefined
          ? {}
          : { onUpdateProviderCli: props.onUpdateProviderCli })}
        onProbe={props.onProbe}
        onProviderCredentialStatus={props.onProviderCredentialStatus}
        onProviderOrderChange={(visibleOrder) =>
          props.onProviderOrderChange(
            keepUnlistedProviderOrder(visibleOrder, props.defaults.providerOrder),
          )
        }
        onRemove={props.onRemove}
        onRename={props.onRename}
        onSetEnabled={props.onSetEnabled}
        {...(props.onSetClaudeArtifactDelivery === undefined
          ? {}
          : { onSetClaudeArtifactDelivery: props.onSetClaudeArtifactDelivery })}
        onDataTagsChange={props.onDataTagsChange}
        onModelDataTagsChange={props.onModelDataTagsChange}
        {...(props.onModelContextWindowChange === undefined
          ? {}
          : { onModelContextWindowChange: props.onModelContextWindowChange })}
        onVerifyModelTools={props.onVerifyModelTools}
      />
      <SettingsSection title="Defaults">
        <div className="setgroup">
          <div className="setrow">
            <span className="setrow-label">Permission persistence</span>
            <p className="setrow-hint">
              <span>How long a granted provider approval lasts.</span>
            </p>
            <div className="setrow-control">
              <OctantSelectField
                aria-label="Permission persistence"
                className="settings-view__select window-no-drag"
                disabled={props.busy}
                onValueChange={(value) =>
                  void props.onPermissionPersistenceChange(value as PermissionPersistence)
                }
                options={[
                  { id: "current-session", label: "Current session only" },
                  { id: "project-default", label: "Remember for this Project" },
                ]}
                value={props.defaults.permissionPersistence}
              />
            </div>
          </div>
        </div>
      </SettingsSection>
      {props.discovery}
      <OpenCodeManagedUpdate
        instances={props.instances
          .filter((instance) => instance.driverKind === "opencode")
          .map((instance) => ({
            id: instance.id,
            displayName: instance.displayName,
            binaryPath:
              "binaryPath" in instance.configuration ? instance.configuration.binaryPath : "",
          }))}
        {...(props.hostBridge === undefined ? {} : { bridge: props.hostBridge })}
        onChangeBinary={props.onChangeBinary}
      />
    </div>
  );
}
