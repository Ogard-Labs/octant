import type { ComputerUseToolService } from "../computerUse/computerUseToolService";
import type {
  ChatThreadId,
  CodeProjectPullRequestRow,
  ProviderInstance,
  ProviderProbeResult,
  WindowId,
  WorkAccess,
  WorkThreadId,
} from "@octant/contracts";
import type { WorkBoardRuntimeActivity } from "../work/workThreadBoardService";
import { WorkRequestRuntime } from "../work/workRequestRuntime";
import { WorkRequestService } from "../work/workRequestService";
import type {
  CodeWorktreeRefsPort,
  CodeWorktreeSourcePreviewPort,
  ManagedCodeThreadCreationPort,
} from "../code/codeService";
import type { CodeOperationRuntime } from "../code/codeOperationRuntime";
import { TerminalProcessPort } from "../code/terminalProcessPort";
import type { CodeRouteService } from "../codeRoutes";
import type { ComputerUseRuntime } from "../computerUse/computerUseRuntime";
import type { AgentRunRouteDependencies } from "../agentRun/agentRunRoutes";
import { TerminalBrowserGrantService } from "../code/terminalBrowserGrantService";
import { ProjectBrowserService } from "../browser/projectBrowserService";
import { BrowserAutomationService } from "../browser/browserAutomationService";
import { BrowserToolApprovalService } from "../browser/browserToolApprovalService";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import { NativeHarnessLeadFallbackService } from "../harness/nativeHarnessLeadFallback";
import { NativeHarnessSessionStore } from "../harness/nativeHarnessSessionStore";
import { NativeHarnessQuestionStore } from "../harness/nativeHarnessQuestions";
import { NativeHarnessApprovalStore } from "../harness/nativeHarnessApprovals";
import { createAgentRunInteractions } from "../agentRun/agentRunInteractions";
import { NativeHarnessTurnObserver } from "../harness/nativeHarnessTurnObserver";
import { ZenAssistantTools } from "../zen/zenAssistantTools";
import type { CanvasAgentToolPort } from "../canvas/canvasAgentTools";
import type { PrivateListener } from "../privateListener";
import type { RemoteGateway } from "../remote/remoteGateway";

/**
 * Values one wiring module assigns after another module has already captured
 * them in a closure. Each is a cell the composition root creates before any
 * wiring runs; the code that used to assign the `let` writes `current` at the
 * same point, during startup or later at runtime, and every reader
 * dereferences it per call, as the captured `let` was read before.
 */
export interface LateBindings {
  readonly workRequestRuntime: { current: WorkRequestRuntime | undefined };
  // The native harness is composed once the research router and plan
  // service exist; every consumer here reads these per turn or per request,
  // long after boot, never at construction.
  readonly nativeHarnessComposition: { current: NativeHarnessComposition | undefined };
  readonly nativeHarnessSessions: { current: NativeHarnessSessionStore | undefined };
  readonly nativeHarnessObserver: { current: NativeHarnessTurnObserver | undefined };
  readonly nativeHarnessLeadFallback: { current: NativeHarnessLeadFallbackService | undefined };
  readonly nativeHarnessQuestions: { current: NativeHarnessQuestionStore | undefined };
  readonly nativeHarnessApprovalStore: { current: NativeHarnessApprovalStore | undefined };
  readonly agentRunInteractions: {
    current: ReturnType<typeof createAgentRunInteractions> | undefined;
  };
  readonly snapshotCanvasImpl: {
    current: NonNullable<AgentRunRouteDependencies["snapshotCanvas"]>;
  };
  readonly refreshStandaloneSkills: { current: () => Promise<void> };
  readonly managedWorktreeSourcePreview: { current: CodeWorktreeSourcePreviewPort["preview"] };
  readonly managedWorktreeRefsList: { current: CodeWorktreeRefsPort["list"] };
  readonly managedCodeThreadCreation: { current: ManagedCodeThreadCreationPort };
  readonly probeProviderForThreads: {
    current: (providerInstanceId: ProviderInstance["id"]) => Promise<ProviderProbeResult>;
  };
  readonly codeOperationRuntime: { current: CodeOperationRuntime | undefined };
  // The Chat, Work, and Code services a follow-up creates through are
  // composed after these routes; the creator is bound once they exist.
  // The Work turn service is built further down; the harness asks it for a
  // running turn's access only once turns run.
  readonly runningWorkTurnAccess: {
    current: ((threadId: string) => WorkAccess | undefined) | undefined;
  };
  readonly zenAssistantTools: { current: ZenAssistantTools | undefined };
  // Composed after the Canvas service exists, the same way Zen's tools are.
  readonly canvasAgentToolPort: { current: CanvasAgentToolPort | undefined };
  readonly purgeQueuedChatMessages: {
    current: ((threadId: ChatThreadId) => Promise<void>) | undefined;
  };
  // Bound after Work request and agent-run ports exist; until then bootstrap
  // reports no executing threads rather than inventing a second run source.
  readonly observeWorkThreadRuntime: {
    current: ((threadId: WorkThreadId) => WorkBoardRuntimeActivity) | undefined;
  };
  readonly workRequestService: { current: WorkRequestService | undefined };
}
