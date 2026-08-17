import type {
  ProviderDriverKind,
  ProviderExecutionPolicy,
  ProviderFailure,
  ProviderInstanceId,
  ProjectId,
  ProviderAuthenticationAttempt,
  ProviderModelId,
  ProviderModelOptionValues,
  ProviderProbeResult,
  ProviderResumeCursor,
  ProviderRuntimeEvent,
  ProviderSessionId,
  WorkThreadId,
  ProviderToolAnswer,
  ProviderTurnInput,
} from "@octant/contracts";
import type { Effect, Scope, Stream } from "effect";
import type { ProviderContextFactsSource } from "./contextFacts";

export type {
  ProviderAttachmentInput,
  ProviderToolAnswer,
  ProviderToolDefinition,
  ProviderTurnInput,
} from "@octant/contracts";

export interface ProviderProbeInput {
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderAcquireInput {
  readonly instanceId: ProviderInstanceId;
  readonly projectRoot: string;
  readonly mode?: "chat" | "work" | "code";
  readonly workspace?: { readonly kind: "rootless" | "project-backed" };
  /** Context used by the server-owned Work request projection subscriber. */
  readonly workRequest?: {
    readonly projectId: ProjectId;
    readonly threadId: WorkThreadId;
    readonly sessionId: ProviderSessionId;
  };
}

export interface ProviderSessionStart {
  readonly sessionId: ProviderSessionId;
  readonly modelId: ProviderModelId;
  readonly executionPolicy: ProviderExecutionPolicy;
  /**
   * User-chosen values for options the model declares (`ProviderModel.options`),
   * keyed by option id. Drivers apply the ids they understand and ignore the
   * rest; absent means provider defaults.
   */
  readonly modelOptionValues?: ProviderModelOptionValues;
}

export interface ProviderSessionHandle {
  readonly sessionId: ProviderSessionId;
  readonly resumeCursor?: ProviderResumeCursor;
}

export interface ProviderSessionResume {
  readonly sessionId: ProviderSessionId;
  readonly resumeCursor: ProviderResumeCursor;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly modelOptionValues?: ProviderModelOptionValues;
}

export interface ProviderApprovalAnswer {
  readonly sessionId: ProviderSessionId;
  readonly requestId: string;
  readonly approved: boolean;
}

export interface ProviderUserInputAnswer {
  readonly sessionId: ProviderSessionId;
  readonly requestId: string;
  readonly answer: string;
}

export interface ProviderDriver {
  readonly kind: ProviderDriverKind;
  readonly contextFacts?: ProviderContextFactsSource;
  readonly probe: (
    input: ProviderProbeInput,
  ) => Effect.Effect<ProviderProbeResult, ProviderFailure, Scope.Scope>;
  /**
   * Optional per-deployment tool-capability verification. Used by drivers
   * whose Connection Check is non-generating (e.g. Azure AI Foundry) so a
   * separate, explicitly-requested generating probe can flip
   * `appManagedTools` from "unsupported" to "supported" after proof.
   */
  readonly verifyToolCapability?: (
    input: ProviderToolVerificationInput,
  ) => Effect.Effect<ProviderToolVerificationResult, ProviderFailure, Scope.Scope>;
  readonly acquire: (
    input: ProviderAcquireInput,
  ) => Effect.Effect<ProviderConnection, ProviderFailure, Scope.Scope>;
  readonly beginAuthentication?: (
    input: ProviderProbeInput,
  ) => Effect.Effect<ProviderAuthenticationAttempt, ProviderFailure, Scope.Scope>;
  readonly completeAuthentication?: (
    input: ProviderProbeInput & { readonly attemptId: string },
  ) => Effect.Effect<void, ProviderFailure, Scope.Scope>;
}

export interface ProviderToolVerificationInput {
  readonly instanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

export interface ProviderToolVerificationResult {
  readonly instanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly appManagedTools: "supported" | "unsupported";
}

export interface ProviderConnection {
  readonly events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>;
  readonly start: (
    input: ProviderSessionStart,
  ) => Effect.Effect<ProviderSessionHandle, ProviderFailure>;
  readonly resume: (
    input: ProviderSessionResume,
  ) => Effect.Effect<ProviderSessionHandle, ProviderFailure>;
  readonly send: (input: ProviderTurnInput) => Effect.Effect<void, ProviderFailure>;
  readonly interrupt: (sessionId: ProviderSessionId) => Effect.Effect<void, ProviderFailure>;
  readonly stop: (sessionId: ProviderSessionId) => Effect.Effect<void, ProviderFailure>;
  readonly answerApproval: (input: ProviderApprovalAnswer) => Effect.Effect<void, ProviderFailure>;
  readonly answerUserInput: (
    input: ProviderUserInputAnswer,
  ) => Effect.Effect<void, ProviderFailure>;
  readonly answerTool: (input: ProviderToolAnswer) => Effect.Effect<void, ProviderFailure>;
}
