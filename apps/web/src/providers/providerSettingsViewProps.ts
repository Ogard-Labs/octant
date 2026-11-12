import type { OctantHostBridge } from "../shell/hostBridge";
import { openExternalUrl } from "../shell/openExternalUrl";
import type { ProviderSettingsViewProps } from "./ProviderSettingsView";
import type { ProviderController } from "./useProviderController";

/**
 * The Providers page's props as one provider controller supplies them, for
 * every surface that mounts the page: Settings in a local window, and a
 * browser the host's own person paired, which has no host bridge.
 */
export function providerSettingsViewProps(
  controller: ProviderController,
  hostBridge: OctantHostBridge | undefined,
): Omit<ProviderSettingsViewProps, "discovery" | "discoverySnapshot"> {
  return {
    busy: controller.busy,
    credentialManagementAvailable: controller.credentialManagementAvailable,
    defaults: controller.defaults,
    instances: controller.instances,
    ...(controller.message === undefined ? {} : { message: controller.message }),
    observedByInstance: controller.observedByInstance,
    presentationObservedByInstance: controller.presentationObservedByInstance,
    onOpenExternalUrl: (url) => openExternalUrl(hostBridge, url),
    ...(hostBridge === undefined ? {} : { hostBridge: hostBridge }),
    onChangeBinary: controller.changeBinary,
    onChangeClaudeConfiguration: controller.changeClaudeConfiguration,
    onChangeCodexConfiguration: controller.changeCodexConfiguration,
    onChangeAcpAgentConfiguration: controller.changeAcpAgentConfiguration,
    onChangePiConfiguration: controller.changePiConfiguration,
    onChangeOhMyPiConfiguration: controller.changeOhMyPiConfiguration,
    onChangeOllamaConfiguration: controller.changeOllamaConfiguration,
    onChangeOutsideHarnessEndpointConfiguration:
      controller.changeOutsideHarnessEndpointConfiguration,
    onChangeOpenAiCompatibleConfiguration: controller.changeOpenAiCompatibleConfiguration,
    onChangeOpenAiImageConfiguration: controller.changeOpenAiImageConfiguration,
    onChangeGeminiImageConfiguration: controller.changeGeminiImageConfiguration,
    onChangeBflImageConfiguration: controller.changeBflImageConfiguration,
    onChangeIdeogramImageConfiguration: controller.changeIdeogramImageConfiguration,
    onChangeAnthropicCompatibleConfiguration: controller.changeAnthropicCompatibleConfiguration,
    onChangeAzureFoundryConfiguration: controller.changeAzureFoundryConfiguration,
    onChangeAmazonBedrockConfiguration: controller.changeAmazonBedrockConfiguration,
    onClearProviderCredential: controller.clearProviderCredential,
    ...(controller.providerOAuth === undefined
      ? {}
      : { onProviderOAuth: controller.providerOAuth }),
    onBeginProviderAuthentication: controller.beginProviderAuthentication,
    onCompleteProviderAuthentication: controller.completeProviderAuthentication,
    onUpdateProviderCli: controller.updateProviderCli,
    onCreate: controller.create,
    onCreateClaude: controller.createClaude,
    onCreateAcpAgent: controller.createAcpAgent,
    onCreateOllama: controller.createOllama,
    onCreateOpenAiCompatible: controller.createOpenAiCompatible,
    onCreateAnthropicCompatible: controller.createAnthropicCompatible,
    onCreateAzureFoundry: controller.createAzureFoundry,
    onCreateAmazonBedrock: controller.createAmazonBedrock,
    onCreateOpenAiImage: controller.createOpenAiImage,
    onCreateGeminiImage: controller.createGeminiImage,
    onCreateBflImage: controller.createBflImage,
    onCreateIdeogramImage: controller.createIdeogramImage,
    onPermissionPersistenceChange: controller.updatePermissionPersistence,
    onProbe: controller.probe,
    onProviderOrderChange: controller.updateProviderOrder,
    onAgentEligibleModelsChange: controller.updateAgentEligibleModels,
    onHiddenModelsChange: controller.updateHiddenModels,
    onVerifyModelTools: controller.verifyModelTools,
    onProviderCredentialStatus: controller.providerCredentialStatus,
    onRemove: controller.remove,
    onRename: controller.rename,
    onRetry: controller.retry,
    onSetEnabled: controller.setEnabled,
    onSetClaudeArtifactDelivery: controller.setClaudeArtifactDelivery,
    onSetProviderNativeSetup: controller.setProviderNativeSetup,
    onDataTagsChange: controller.setDataTags,
    onModelDataTagsChange: controller.setModelDataTags,
    onModelContextWindowChange: controller.setModelContextWindow,
    probingIds: controller.probingIds,
    updatingIds: controller.updatingIds,
    latestVersions: controller.latestVersions,
    onCheckLatestVersions: controller.checkLatestVersions,
    status: controller.status,
  };
}
