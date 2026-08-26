import type {
  ExecutionCapsuleAcquireRequest,
  ExecutionCapsuleResourceBudget,
} from "@octant/contracts/execution-capsule";

export interface ExecutionCapsuleHostCapabilities {
  readonly platform: string;
  readonly rootlessPodman: boolean;
  readonly runsc: boolean;
  readonly systrap: boolean;
  readonly cgroupsV2: boolean;
  readonly dedicatedIdentity: boolean;
}

export interface ExecutionCapsuleAvailableCapacity {
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly pidLimit: number;
}

export type ExecutionCapsuleAdmissionPlan =
  | {
      readonly status: "admitted";
      readonly backend: "gvisor-systrap";
      readonly budget: ExecutionCapsuleResourceBudget;
    }
  | { readonly status: "queued"; readonly reason: "capacity-unavailable" }
  | {
      readonly status: "refused";
      readonly reason: "protected-runtime-unavailable" | "unsafe-host-identity";
    };

/**
 * Decides whether a Station can create one protected execution capsule.
 *
 * Ordinary OCI isolation is deliberately not represented as a possible
 * admitted backend. A missing gVisor or rootless prerequisite is a refusal,
 * while temporary resource pressure queues the request without side effects.
 */
export function planExecutionCapsuleAdmission(input: {
  readonly request: ExecutionCapsuleAcquireRequest;
  readonly host: ExecutionCapsuleHostCapabilities;
  readonly available: ExecutionCapsuleAvailableCapacity;
}): ExecutionCapsuleAdmissionPlan {
  if (!input.host.dedicatedIdentity) {
    return { status: "refused", reason: "unsafe-host-identity" };
  }
  if (
    input.host.platform !== "linux" ||
    !input.host.rootlessPodman ||
    !input.host.runsc ||
    !input.host.systrap ||
    !input.host.cgroupsV2
  ) {
    return { status: "refused", reason: "protected-runtime-unavailable" };
  }
  if (!fits(input.request.budget, input.available)) {
    return { status: "queued", reason: "capacity-unavailable" };
  }
  return {
    status: "admitted",
    budget: input.request.budget,
    backend: "gvisor-systrap",
  };
}

function fits(
  requested: ExecutionCapsuleResourceBudget,
  available: ExecutionCapsuleAvailableCapacity,
): boolean {
  return (
    requested.cpuMillicores <= available.cpuMillicores &&
    requested.memoryBytes <= available.memoryBytes &&
    requested.diskBytes <= available.diskBytes &&
    requested.pidLimit <= available.pidLimit
  );
}
