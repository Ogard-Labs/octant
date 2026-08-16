// Internal finalization sequence controller for the remote gateway.
//
// This module is an internal implementation detail of the gateway's
// shutdown path. The production gateway entry module
// (`remoteGateway.ts`) imports `executeFinalizationSequence` and calls it
// with finalizers assembled from real collaborators. Tests import this
// module directly to verify the finalization sequence logic (order,
// fail-stop) with injected finalizer functions — without exposing any
// bypass-capable factory on the production gateway entry module.

export interface FinalizerFunctions {
  readonly stopAdmission: () => void;
  readonly invalidateSessions: () => { readonly cancelHookFailures: number };
  readonly cancelWork: () => { readonly canceled: number; readonly cancelHookFailures: number };
}

export type FinalizationFailureKind = "invalidation-failed" | "cancellation-failed";

export interface FinalizationOutcome {
  readonly failure?: {
    readonly kind: FinalizationFailureKind;
    readonly cancelHookFailures: number;
  };
}

/**
 * Execute the deterministic finalization sequence:
 * admission → sessions → work.
 *
 * Each step is fail-stop: if a step reports unresolved hook failures,
 * subsequent steps are NOT called and the failure is returned. The caller
 * (gateway `stop()`) is responsible for unbinding the listener only when
 * this returns `{ failure: undefined }`.
 */
export function executeFinalizationSequence(finalizers: FinalizerFunctions): FinalizationOutcome {
  finalizers.stopAdmission();
  const invalidation = finalizers.invalidateSessions();
  if (invalidation.cancelHookFailures > 0) {
    return {
      failure: {
        kind: "invalidation-failed",
        cancelHookFailures: invalidation.cancelHookFailures,
      },
    };
  }
  const cancellation = finalizers.cancelWork();
  if (cancellation.cancelHookFailures > 0) {
    return {
      failure: {
        kind: "cancellation-failed",
        cancelHookFailures: cancellation.cancelHookFailures,
      },
    };
  }
  return {};
}
