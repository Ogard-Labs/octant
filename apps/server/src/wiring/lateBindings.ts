import type { CodeOperationRuntime } from "../code/codeOperationRuntime";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import { NativeHarnessLeadFallbackService } from "../harness/nativeHarnessLeadFallback";
import { NativeHarnessTurnObserver } from "../harness/nativeHarnessTurnObserver";

/**
 * Values one wiring module assigns after another module has already captured
 * them in a closure. Each is a cell the composition root creates before any
 * wiring runs; the owning module writes `current` when it builds the value
 * and every reader dereferences it per call.
 *
 * Every cell here is a dependency cycle between two areas that has no cheap
 * seam yet. `scripts/check-module-wiring.ts` pins their number, so one can be
 * removed but not added. A value that only needs building earlier, or an area
 * that only reacts to another's change, does not belong here: build it first
 * (`foundations`, `harnessState`, `workRequestState`) or subscribe to it.
 */
export interface LateBindings {
  // Agent runs, providers, and Code read the native harness through hooks the
  // agent-run area owns, while the harness is composed from that area's
  // admission and orchestration and from the provider driver options, which
  // call back into the lead fallback.
  readonly nativeHarnessComposition: { current: NativeHarnessComposition | undefined };
  readonly nativeHarnessObserver: { current: NativeHarnessTurnObserver | undefined };
  readonly nativeHarnessLeadFallback: { current: NativeHarnessLeadFallbackService | undefined };
  // The Code service and the device workbench ask the Code runtime for fork
  // points and approval checks, and the runtime needs the Code service to
  // note the provider turns it launches.
  readonly codeOperationRuntime: { current: CodeOperationRuntime | undefined };
}
