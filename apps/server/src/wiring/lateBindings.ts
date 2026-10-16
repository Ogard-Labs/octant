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
  readonly browserToolApprovalService: { current: BrowserToolApprovalService | undefined };
  readonly terminalBrowserGrants: { current: TerminalBrowserGrantService | undefined };
  readonly activeCodeService: { current: CodeRouteService | undefined };
  readonly browserAutomationService: { current: BrowserAutomationService | undefined };
  readonly projectBrowserService: { current: ProjectBrowserService | undefined };
  readonly activeComputerUseRuntime: { current: ComputerUseRuntime | undefined };
  readonly activeComputerUseTools: { current: ComputerUseToolService | undefined };
  readonly workRequestRuntime: { current: WorkRequestRuntime | undefined };
  readonly revokeShellWindow: { current: ((windowId: WindowId) => void) | undefined };
  readonly revokeQueuedMessages: { current: ((windowId: WindowId) => Promise<void>) | undefined };
  // The native harness is composed once the research router and plan
  // service exist; every consumer here reads these per turn or per request,
  // long after boot, never at construction.
  readonly nativeHarnessComposition: { current: NativeHarnessComposition | undefined };
  readonly nativeHarnessSessions: { current: NativeHarnessSessionStore | undefined };
  readonly nativeHarnessObserver: { current: NativeHarnessTurnObserver | undefined };
  readonly nativeHarnessLeadFallback: { current: NativeHarnessLeadFallbackService | undefined };
  readonly nativeHarnessQuestions: { current: NativeHarnessQuestionStore | undefined };
  readonly agentRunInteractions: {
    current: ReturnType<typeof createAgentRunInteractions> | undefined;
  };
  readonly snapshotCanvasImpl: {
    current: NonNullable<AgentRunRouteDependencies["snapshotCanvas"]>;
  };
  readonly revokeProjectPullRequests: { current: (() => void) | undefined };
  readonly refreshStandaloneSkills: { current: () => Promise<void> };
  readonly managedWorktreeSourcePreview: { current: CodeWorktreeSourcePreviewPort["preview"] };
  readonly managedWorktreeRefsList: { current: CodeWorktreeRefsPort["list"] };
  readonly managedCodeThreadCreation: { current: ManagedCodeThreadCreationPort };
  readonly probeProviderForThreads: {
    current: (providerInstanceId: ProviderInstance["id"]) => Promise<ProviderProbeResult>;
  };
  // Late-bound because the follow-up service that consumes refreshed
  // snapshots is constructed further down, alongside the other Code thread
  // services (same pattern as recordExtensionRuntimeEvidence).
  readonly observeRefreshedPullRequestRows: {
    current: ((rows: ReadonlyArray<CodeProjectPullRequestRow>) => void) | undefined;
  };
  readonly codeOperationRuntime: { current: CodeOperationRuntime | undefined };
  readonly terminalProcessPort: { current: TerminalProcessPort | undefined };
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
  readonly remoteListener: { current: PrivateListener | undefined };
  // The private listener lifecycle is owned by a server-side controller so
  // the packaged host controls (over the loopback bridge) drive the real
  // dual-listener gateway, not a stub. `currentRemoteGateway` tracks the most
  // recent gateway generation the controller constructed so the local device
  // administration routes and the returned server shape can observe it. The
  // controller only ever binds the private gateway; the loopback listener is
  // never touched by an enable/disable/restart failure.
  readonly currentRemoteGateway: { current: RemoteGateway | undefined };
}
