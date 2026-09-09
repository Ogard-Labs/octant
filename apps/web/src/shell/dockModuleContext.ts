import type { WorkFileOpenRequest } from "../work/WorkFilesPanel";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import type { NativeHarnessFollowUpCreation } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { PlanClient } from "@octant/client-runtime/plan-client";
import type { ShipClient } from "@octant/client-runtime/ship-client";
import type { WorkFileListingClient } from "@octant/client-runtime/work-file-listing-client";
import type { CodeCheckoutId, CodeRelativePath } from "@octant/contracts/code";
import type { ChatThreadId } from "@octant/contracts/chat";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type { ChatReadCursorStore } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import type { PickerGroup } from "@octant/domain";
import type { ProviderController } from "../providers/useProviderController";
import type { OctantHostBridge } from "./hostBridge";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";
import type { SideChatSidecar } from "@octant/contracts";

export interface ThreadUtilityDockSubject {
  readonly checkoutId?: CodeCheckoutId;
  readonly mode: OctantMode;
  readonly projectId?: ProjectId;
  readonly threadId: string;
}

export interface ThreadUtilityDockContentProps {
  readonly agentRunClient?: AgentRunClient;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
  readonly nativeHarnessClient?: NativeHarnessClient;
  /** A confirmed follow-up's thread exists; open it with the prompt ready to send. */
  readonly onFollowUpCreated?: (input: {
    readonly created: NativeHarnessFollowUpCreation;
    readonly prompt: string;
  }) => void;
  readonly appleProjectPath?: string;
  readonly appleToolchainClient?: AppleToolchainClient;
  readonly browserAutomationClient?: BrowserAutomationClient;
  readonly browserContextId?: string;
  readonly canvasClient?: CanvasClient;
  readonly chatClient: ChatClient;
  readonly chatReadCursorStore: ChatReadCursorStore;
  readonly codeController?: CodeController;
  readonly codeProviderGroups?: ReadonlyArray<PickerGroup>;
  readonly hostBridge?: OctantHostBridge;
  readonly onOpenFile: (relativePath: CodeRelativePath) => void;
  readonly onBrowserContextCreated?: (contextId: string) => void;
  readonly onSidecarOpened: (sidecar: SideChatSidecar) => void;
  readonly planClient?: PlanClient;
  readonly providerController?: ProviderController;
  readonly serverUrl?: string;
  readonly shipClient?: ShipClient;
  readonly workFileListingClient?: WorkFileListingClient;
  /** Opens one listed Work file in the preview surface. */
  readonly onOpenWorkFile?: (request: WorkFileOpenRequest) => void;
  readonly sidecarThreadId?: ChatThreadId;
  readonly subject: ThreadUtilityDockSubject;
  readonly surface: RightUtilityDockSurfaceId;
  readonly utilityTabId?: string;
  readonly windowCapability?: string;
  /** Checkout-relative path of the document the thread most recently wrote. */
  readonly writtenDocumentPath?: string;
  /** The Canvas the thread most recently wrote or handed off. */
  readonly writtenCanvasId?: string;
}
