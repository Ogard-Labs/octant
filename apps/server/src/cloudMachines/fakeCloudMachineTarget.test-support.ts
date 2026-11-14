import type {
  CloudCredentialHandle,
  CloudMachineActResult,
  CloudMachineTarget,
} from "@octant/plugin-api/cloud-machine-target";

/**
 * A cloud machine target that keeps its machines in memory, for tests only.
 * It records every call and the credential handle each one was given, so a
 * test can prove what reached the provider and what never did.
 */
export function fakeCloudMachineTarget(
  options: { readonly create?: "created" | "refused" | "throws" } = {},
) {
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
      return {
        status: "accepted",
        machine: {
          providerMachineId: input.providerMachineId,
          state: to ?? state,
          endpoint: { host: `${input.providerMachineId}.machines.test`, user: "octant" },
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
          endpoint: { host: `${providerMachineId}.machines.test`, user: "octant" },
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
