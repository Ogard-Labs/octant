import type { ChatThreadId, WorkAccess } from "@octant/contracts";
import type { CodeOperationRuntime } from "../code/codeOperationRuntime";
import type { AgentRunRouteDependencies } from "../agentRun/agentRunRoutes";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import { NativeHarnessLeadFallbackService } from "../harness/nativeHarnessLeadFallback";
import { NativeHarnessTurnObserver } from "../harness/nativeHarnessTurnObserver";
import { ZenAssistantTools } from "../zen/zenAssistantTools";
import type { CanvasAgentToolPort } from "../canvas/canvasAgentTools";

/**
 * Values one wiring module assigns after another module has already captured
 * them in a closure. Each is a cell the composition root creates before any
 * wiring runs; the code that used to assign the `let` writes `current` at the
 * same point, during startup or later at runtime, and every reader
 * dereferences it per call, as the captured `let` was read before.
 */
export interface LateBindings {
  // The native harness is composed once the research router and plan
  // service exist; every consumer here reads these per turn or per request,
  // long after boot, never at construction.
  readonly nativeHarnessComposition: { current: NativeHarnessComposition | undefined };
  readonly nativeHarnessObserver: { current: NativeHarnessTurnObserver | undefined };
  readonly nativeHarnessLeadFallback: { current: NativeHarnessLeadFallbackService | undefined };
  readonly snapshotCanvasImpl: {
    current: NonNullable<AgentRunRouteDependencies["snapshotCanvas"]>;
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
}
