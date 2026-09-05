import {
  createAgentProfileClient,
  createAutomationClient,
  createUsageDashboardClient,
  createRequestCoordinator,
  type AgentProfileClient,
  type AutomationClient,
} from "@octant/client-runtime";
import { createAgentRunClient, type AgentRunClient } from "@octant/client-runtime/agent-run-client";
import {
  createAgentRunSettingsClient,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import {
  createAppleToolchainClient,
  type AppleToolchainClient,
} from "@octant/client-runtime/apple-toolchain-client";
import { createAutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import {
  createBrowserAutomationClient,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import { createCanvasClient, type CanvasClient } from "@octant/client-runtime/canvas-client";
import { createChatClient, type ChatClient } from "@octant/client-runtime/chat-client";
import { createCodeClient, type CodeClient } from "@octant/client-runtime/code-client";
import {
  createComputerUseClient,
  type ComputerUseClient,
} from "@octant/client-runtime/computer-use-client";
import { createContextClient, type ContextClient } from "@octant/client-runtime/context-client";
import { createDiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import {
  createExtensionClient,
  type ExtensionClient,
} from "@octant/client-runtime/extension-client";
import { createFolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import { createGithubClient } from "@octant/client-runtime/github-client";
import { createGithubCloneClient } from "@octant/client-runtime/github-clone-client";
import { createGoalClient } from "@octant/client-runtime/goal-client";
import { createGoalLoopClient } from "@octant/client-runtime/goal-loop-client";
import { createHostClient, type HostClient } from "@octant/client-runtime/host-client";
import { createHostControlClient } from "@octant/client-runtime/host-control-client";
import { createImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { createSpeechClient } from "@octant/client-runtime/speech-client";
import { createIntegrationClient } from "@octant/client-runtime/integration-client";
import { createMachineChangeClient } from "@octant/client-runtime/machine-change-client";
import {
  createNavigatorAssistantClient,
  type NavigatorAssistantClient,
} from "@octant/client-runtime/navigator-assistant-client";
import { createPlanClient, type PlanClient } from "@octant/client-runtime/plan-client";
import { createPreviewClient } from "@octant/client-runtime/preview-client";
import { createProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { createShipClient, type ShipClient } from "@octant/client-runtime/ship-client";
import { createUsageClient } from "@octant/client-runtime/usage-client";
import { createWorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import { createWorkOverviewClient } from "@octant/client-runtime/work-overview-client";
import { createWorkRequestClient } from "@octant/client-runtime/work-request-client";
import { createWorkResearchClient } from "@octant/client-runtime/work-research-client";
import {
  createWorkThreadClient,
  type WorkThreadClient,
} from "@octant/client-runtime/work-thread-client";
import { createWorkTurnClient, type WorkTurnClient } from "@octant/client-runtime/work-turn-client";

export interface CreateLaunchedShellClientsOptions {
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly onUnauthorized?: () => Promise<void>;
  readonly agentProfileClient: AgentProfileClient | undefined;
  readonly agentRunClient: AgentRunClient | undefined;
  readonly agentRunSettingsClient: AgentRunSettingsClient | undefined;
  readonly appleToolchainClient: AppleToolchainClient | undefined;
  readonly automationClient: AutomationClient | undefined;
  readonly browserAutomationClient: BrowserAutomationClient | undefined;
  readonly canvasClient: CanvasClient | undefined;
  readonly chatClient: ChatClient | undefined;
  readonly codeClient: CodeClient | undefined;
  readonly computerUseClient: ComputerUseClient | undefined;
  readonly contextClient: ContextClient | undefined;
  readonly extensionClient: ExtensionClient | undefined;
  readonly hostClient: HostClient | undefined;
  readonly navigatorAssistantClient: NavigatorAssistantClient | undefined;
  readonly planClient: PlanClient | undefined;
  readonly shipClient: ShipClient | undefined;
  readonly workThreadClient: WorkThreadClient | undefined;
  readonly workTurnClient: WorkTurnClient | undefined;
}

export interface LaunchedShellClients {
  readonly agentProfileClient: AgentProfileClient;
  readonly agentRunClient: AgentRunClient;
  readonly agentRunSettingsClient: AgentRunSettingsClient;
  readonly appleToolchainClient: AppleToolchainClient;
  readonly automationClient: AutomationClient;
  readonly automationNotificationClient: ReturnType<typeof createAutomationNotificationClient>;
  readonly browserAutomationClient: BrowserAutomationClient;
  readonly canvasClient: CanvasClient;
  readonly chatClient: ChatClient;
  readonly codeClient: CodeClient;
  readonly computerUseClient: ComputerUseClient;
  readonly contextClient: ContextClient;
  readonly diagnosticsExportClient: ReturnType<typeof createDiagnosticsExportClient>;
  readonly extensionClient: ExtensionClient;
  readonly folderBrowseClient: ReturnType<typeof createFolderBrowseClient>;
  readonly githubCloneClient: ReturnType<typeof createGithubCloneClient>;
  readonly githubTransport: ReturnType<typeof createGithubClient>;
  readonly goalClient: ReturnType<typeof createGoalClient>;
  readonly goalLoopClient: ReturnType<typeof createGoalLoopClient>;
  readonly hostClient: HostClient;
  readonly hostControlClient: ReturnType<typeof createHostControlClient>;
  readonly imageGenerationClient: ReturnType<typeof createImageGenerationClient>;
  readonly speechClient: ReturnType<typeof createSpeechClient>;
  readonly linearTransport: ReturnType<typeof createIntegrationClient>;
  readonly machineChangeClient: ReturnType<typeof createMachineChangeClient>;
  readonly navigatorAssistantClient: NavigatorAssistantClient | undefined;
  readonly planClient: PlanClient;
  readonly previewClient: ReturnType<typeof createPreviewClient>;
  readonly providerUsageLimitsClient:
    | ReturnType<typeof createProviderUsageLimitsClient>
    | undefined;
  readonly shipClient: ShipClient;
  readonly usageClient: ReturnType<typeof createUsageClient>;
  readonly usageDashboardClient: ReturnType<typeof createUsageDashboardClient>;
  readonly workMutationClient: ReturnType<typeof createWorkMutationClient>;
  readonly workOverviewClient: ReturnType<typeof createWorkOverviewClient>;
  readonly workRequestClient: ReturnType<typeof createWorkRequestClient>;
  readonly workResearchClient: ReturnType<typeof createWorkResearchClient>;
  readonly workThreadClient: WorkThreadClient;
  readonly workTurnClient: WorkTurnClient;
}

export function createLaunchedShellClients(
  options: CreateLaunchedShellClientsOptions,
): LaunchedShellClients {
  const fetch = createRequestCoordinator({
    fetch: options.fetch ?? globalThis.fetch,
    ...(options.onUnauthorized === undefined ? {} : { onUnauthorized: options.onUnauthorized }),
  });
  const port = {
    baseUrl: options.serverUrl,
    fetch,
    windowCapability: options.windowCapability,
  };

  // Navigator is host-owned and loopback-only. A base URL the client refuses
  // leaves the surface without one, which the panel reports as "not available
  // on this host" rather than pretending to a conversation it cannot reach.
  let navigatorAssistantClient: NavigatorAssistantClient | undefined =
    options.navigatorAssistantClient;
  if (navigatorAssistantClient === undefined) {
    try {
      navigatorAssistantClient = createNavigatorAssistantClient(port);
    } catch {
      navigatorAssistantClient = undefined;
    }
  }

  let providerUsageLimitsClient: ReturnType<typeof createProviderUsageLimitsClient> | undefined;
  try {
    providerUsageLimitsClient = createProviderUsageLimitsClient(port);
  } catch {
    // Provider limit facts are a local-host capability. Remote clients keep
    // the rest of Settings usable and omit this optional panel.
    providerUsageLimitsClient = undefined;
  }

  return {
    agentProfileClient: options.agentProfileClient ?? createAgentProfileClient(port),
    agentRunClient: options.agentRunClient ?? createAgentRunClient(port),
    agentRunSettingsClient: options.agentRunSettingsClient ?? createAgentRunSettingsClient(port),
    appleToolchainClient: options.appleToolchainClient ?? createAppleToolchainClient(port),
    automationClient: options.automationClient ?? createAutomationClient(port),
    automationNotificationClient: createAutomationNotificationClient(port),
    browserAutomationClient: options.browserAutomationClient ?? createBrowserAutomationClient(port),
    canvasClient: options.canvasClient ?? createCanvasClient(port),
    chatClient: options.chatClient ?? createChatClient(port),
    codeClient: options.codeClient ?? createCodeClient(port),
    computerUseClient: options.computerUseClient ?? createComputerUseClient(port),
    contextClient: options.contextClient ?? createContextClient(port),
    diagnosticsExportClient: createDiagnosticsExportClient(port),
    extensionClient: options.extensionClient ?? createExtensionClient(port),
    folderBrowseClient: createFolderBrowseClient(port),
    githubCloneClient: createGithubCloneClient(port),
    githubTransport: createGithubClient(port),
    goalClient: createGoalClient(port),
    goalLoopClient: createGoalLoopClient(port),
    hostClient: options.hostClient ?? createHostClient({ baseUrl: options.serverUrl, fetch }),
    hostControlClient: createHostControlClient(port),
    imageGenerationClient: createImageGenerationClient(port),
    speechClient: createSpeechClient(port),
    linearTransport: createIntegrationClient({ ...port, slug: "linear" }),
    machineChangeClient: createMachineChangeClient(port),
    navigatorAssistantClient,
    planClient: options.planClient ?? createPlanClient(port),
    previewClient: createPreviewClient(port),
    providerUsageLimitsClient,
    shipClient: options.shipClient ?? createShipClient(port),
    usageClient: createUsageClient(port),
    usageDashboardClient: createUsageDashboardClient(port),
    workMutationClient: createWorkMutationClient(port),
    workOverviewClient: createWorkOverviewClient(port),
    workRequestClient: createWorkRequestClient(port),
    workResearchClient: createWorkResearchClient(port),
    workThreadClient: options.workThreadClient ?? createWorkThreadClient(port),
    workTurnClient: options.workTurnClient ?? createWorkTurnClient(port),
  };
}
