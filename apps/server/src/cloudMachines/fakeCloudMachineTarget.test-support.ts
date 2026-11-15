import type {
  CloudCredentialHandle,
  CloudMachineActResult,
  CloudMachineTarget,
} from "@octant/plugin-api/cloud-machine-target";

const IN_BETWEEN = {
  running: "resuming",
  suspended: "suspending",
  destroyed: "destroying",
} as const;

/**
 * A cloud machine target that keeps its machines in memory, for tests only.
 * It records every call and the credential handle each one was given, so a
 * test can prove what reached the provider and what never did.
 */
export function fakeCloudMachineTarget(
  options: {
    readonly create?: "created" | "refused" | "throws";
    /**
     * Answer suspend, resume and destroy with the provider's in-between state
     * (`suspending`, `resuming`, `destroying`) while the machine settles at
     * once, as a provider that finishes an act after it accepted it does.
     */
    readonly transitional?: boolean;
    /** The host keys the provider reports with the endpoint; a later answer may report others. */
    readonly hostKeys?: ReadonlyArray<string>;
    readonly hostKeysAfterCreate?: ReadonlyArray<string>;
    readonly costPerHour?: {
      readonly amount: string;
      readonly currency: string;
      readonly source: string;
    };
  } = {},
) {
  const endpointOf = (providerMachineId: string, hostKeys: ReadonlyArray<string> | undefined) => ({
    host: `${providerMachineId}.machines.test`,
    user: "octant",
    ...(hostKeys === undefined ? {} : { hostKeys }),
  });
  const cost = options.costPerHour === undefined ? {} : { costPerHour: options.costPerHour };
  const machines = new Map<string, "running" | "suspended" | "destroyed">();
  const calls: Array<{ readonly act: string; readonly credential: CloudCredentialHandle }> = [];
  let next = 0;

  const act =
    (
      name: "describe" | "suspend" | "resume" | "destroy",
      to?: "running" | "suspended" | "destroyed",
    ) =>
    async (input: {
      readonly providerMachineId: string;
      readonly credential: CloudCredentialHandle;
    }): Promise<CloudMachineActResult> => {
      calls.push({ act: name, credential: input.credential });
      const state = machines.get(input.providerMachineId);
      if (state === undefined || state === "destroyed") return { status: "missing" };
      if (to !== undefined) machines.set(input.providerMachineId, to);
      const answered =
        to === undefined ? state : options.transitional === true ? IN_BETWEEN[to] : to;
      return {
        status: "accepted",
        machine: {
          providerMachineId: input.providerMachineId,
          state: answered,
          endpoint: endpointOf(
            input.providerMachineId,
            options.hostKeysAfterCreate ?? options.hostKeys,
          ),
          ...cost,
        },
      };
    };

  const target: CloudMachineTarget = {
    kind: "cloud-machine-target",
    create: async (input) => {
      calls.push({ act: "create", credential: input.credential });
      if (options.create === "throws") throw new Error("the provider never answered");
      if (options.create === "refused") {
        return { status: "refused", reason: "quota-exceeded", detail: "No capacity in region." };
      }
      next += 1;
      const providerMachineId = `m-${next}`;
      machines.set(providerMachineId, "running");
      return {
        status: "created",
        machine: {
          providerMachineId,
          state: "running",
          endpoint: endpointOf(providerMachineId, options.hostKeys),
          ...cost,
        },
      };
    },
    describe: act("describe"),
    suspend: act("suspend", "suspended"),
    resume: act("resume", "running"),
    destroy: act("destroy", "destroyed"),
  };
  return { target, calls, machines };
}
