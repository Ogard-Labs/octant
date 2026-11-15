/**
 * The cloud machine target contribution.
 *
 * A target creates, describes, suspends, resumes and destroys a machine in the
 * person's own cloud account, and reports the SSH endpoint the host's existing
 * server Project connection uses, with the machine's SSH host keys as the
 * provider reports them, which the host pins for that server. It may report
 * the provider's own hourly cost; it never estimates one. Canonical:
 * docs/design/server-projects.md § Machines in the person's cloud account.
 *
 * A target never receives a secret. The host resolves the person's credential
 * reference through its credential broker at each act and hands the target a
 * purpose-scoped handle; the target names that handle to the broker and never
 * sees the value. Whether a target is offered at all, and whether an act may
 * run, are host decisions: the target is only the port that talks to one
 * provider.
 */
import type {
  CloudMachineDescription,
  CloudMachineRecipe,
  CloudMachineSshEndpoint,
} from "@octant/contracts/cloud-machines";

export {
  CloudCredentialReference,
  CloudMachineDescription,
  CloudMachineHourlyCost,
  CloudMachineRecipe,
  CloudMachineSshEndpoint,
  CloudMachineTargetId,
  decodeCloudMachineRecipe,
  SshHostPublicKey,
} from "@octant/contracts/cloud-machines";
export { CloudMachineState } from "@octant/contracts/server-projects";

export const CLOUD_MACHINE_TARGET_CONTRIBUTION_KIND = "cloud-machine-target" as const;
export type CloudMachineTargetContributionKind = typeof CLOUD_MACHINE_TARGET_CONTRIBUTION_KIND;

/** A handle the credential broker issued for one act on one target; opaque to the target. */
export interface CloudCredentialHandle {
  readonly handleId: string;
}

/**
 * Why the provider declined. A refusal asserts nothing was created or
 * changed; a target that cannot tell must throw instead, and the host records
 * the act as uncertain.
 */
export type CloudMachineTargetRefusal =
  | "credential-refused"
  | "recipe-refused"
  | "quota-exceeded"
  | "wrong-state";

export type CloudMachineCreateResult =
  | {
      readonly status: "created";
      /**
       * Resolved once the machine answers on its endpoint. The endpoint's
       * `hostKeys` should be the keys the provider read from the machine
       * itself (its console or metadata), never keys gathered by connecting
       * to it, which would pin whatever answered.
       */
      readonly machine: CloudMachineDescription & { readonly endpoint: CloudMachineSshEndpoint };
    }
  | {
      readonly status: "refused";
      readonly reason: CloudMachineTargetRefusal;
      readonly detail: string;
    };

export type CloudMachineActResult =
  | { readonly status: "accepted"; readonly machine: CloudMachineDescription }
  | { readonly status: "missing" }
  | {
      readonly status: "refused";
      readonly reason: CloudMachineTargetRefusal;
      readonly detail: string;
    };

export interface CloudMachineActInput {
  readonly providerMachineId: string;
  readonly credential: CloudCredentialHandle;
}

export interface CloudMachineTarget {
  readonly kind: CloudMachineTargetContributionKind;
  readonly create: (input: {
    readonly name: string;
    readonly recipe: CloudMachineRecipe;
    readonly credential: CloudCredentialHandle;
  }) => Promise<CloudMachineCreateResult>;
  readonly describe: (input: CloudMachineActInput) => Promise<CloudMachineActResult>;
  readonly suspend: (input: CloudMachineActInput) => Promise<CloudMachineActResult>;
  readonly resume: (input: CloudMachineActInput) => Promise<CloudMachineActResult>;
  /** Irreversible, and ends what the person's account pays for. */
  readonly destroy: (input: CloudMachineActInput) => Promise<CloudMachineActResult>;
}
