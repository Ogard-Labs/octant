import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import {
  decodeSandboxPolicySelection,
  type SandboxPolicySelection,
} from "@octant/contracts/sandbox-policy";
import { admitSandboxPolicy, type SandboxPolicyCapabilities } from "@octant/domain/sandbox-policy";
import type { ProcessConfinementPrepareInput } from "./seatbeltProfile";

const runtimeEpoch = randomUUID();

/** These are launch capabilities only. Direct tools and provider admission remain separate. */
const POSIX_LAUNCH_CAPABILITIES: SandboxPolicyCapabilities = {
  allowedFolders: true,
  protectedPaths: false,
  networkDeny: true,
  unrestrictedNetwork: true,
  isolatedCredentials: false,
  blockedHostServices: false,
};
export interface SandboxLaunchPolicyReceipt {
  readonly policyDigest: string;
  /** Every cached process must match this key before it may serve this selection. */
  readonly reuseKey: string;
  readonly backend: "seatbelt-v1" | "bubblewrap-v1";
}

export interface SandboxLaunchPolicyRefusal {
  readonly status: "refused";
  readonly code:
    | "sandbox-policy-malformed"
    | "sandbox-policy-unsupported"
    | "sandbox-policy-conflict"
    | "sandbox-policy-unavailable";
  readonly rules: ReadonlyArray<string>;
}

type LaunchInput = Omit<ProcessConfinementPrepareInput, "sandboxPolicy"> & {
  readonly sandboxPolicy?: unknown;
};

type Compilation =
  | { readonly status: "legacy"; readonly input: ProcessConfinementPrepareInput }
  | SandboxLaunchPolicyRefusal
  | {
      readonly status: "admitted";
      readonly input: ProcessConfinementPrepareInput;
      readonly receipt: SandboxLaunchPolicyReceipt;
    };

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Materializes a trusted selection without modifying it or the legacy input.
 * No filesystem enumeration is used to pretend to enforce protected names.
 * A settings layer must admit all execution routes before offering a policy;
 * this function only proves that its child launch can carry these rules.
 */
export function compileSandboxLaunchPolicy(
  input: LaunchInput,
  platform: NodeJS.Platform,
): Compilation {
  const { sandboxPolicy: rawSelection, ...launch } = input;
  if (input.policyReadOnlyRoots !== undefined || input.policyFolderRoots !== undefined) {
    return {
      status: "refused",
      code: "sandbox-policy-malformed",
      rules: ["filesystem.compiledRoots"],
    };
  }
  if (rawSelection === undefined) return { status: "legacy", input: launch };
  let selection: SandboxPolicySelection;
  try {
    selection = decodeSandboxPolicySelection(rawSelection);
  } catch {
    return { status: "refused", code: "sandbox-policy-malformed", rules: ["schema"] };
  }
  if (platform !== "darwin" && platform !== "linux") {
    return { status: "refused", code: "sandbox-policy-unsupported", rules: ["platform"] };
  }
  const admission = admitSandboxPolicy(selection.policy, POSIX_LAUNCH_CAPABILITIES);
  if (admission.status === "refused") return admission;

  try {
    const directory = (path: string) => {
      const canonical = realpathSync(path);
      const stat = statSync(canonical);
      if (!stat.isDirectory() || canonical === "/") throw new Error("Not a grantable directory");
      return { path: canonical, device: stat.dev, inode: stat.ino };
    };
    const readOnly = selection.policy.filesystem.readOnlyRoots.map(directory);
    const readWrite = selection.policy.filesystem.readWriteRoots.map(directory);
    const boundRoots = [launch.boundRoot, ...(launch.extraBoundRoots ?? [])].map(directory);
    const writable = [
      ...(launch.writeBoundRoot === false ? [] : boundRoots),
      directory(launch.temporaryDirectory),
      ...(launch.additionalWriteRoots ?? []).map(directory),
    ];
    const readRoots = (launch.readRoots ?? []).map((path) => {
      const canonical = realpathSync(path);
      const stat = statSync(canonical);
      return { path: canonical, device: stat.dev, inode: stat.ino };
    });
    if (
      readOnly.some((root) =>
        [...writable, ...readWrite].some((write) => overlaps(root.path, write.path)),
      )
    ) {
      // Mount order or a final Seatbelt denial cannot preserve a read-only
      // folder beneath a writable ancestor. Refuse the overlap.
      return {
        status: "refused",
        code: "sandbox-policy-conflict",
        rules: ["filesystem.readOnlyRoots"],
      };
    }
    if (launch.allowFileReadStar === true || (launch.extraRules?.length ?? 0) > 0) {
      // Caller-authored Seatbelt rules may reopen a policy denial or grant an
      // alias; this initial compiler deliberately admits only explicit roots.
      return {
        status: "refused",
        code: "sandbox-policy-conflict",
        rules: ["filesystem.explicitRoots"],
      };
    }
    const networkEgress =
      selection.policy.network === "deny"
        ? "none"
        : selection.policy.network === "unrestricted"
          ? "allow"
          : launch.networkEgress;
    if (
      selection.policy.network !== "existing-policy" &&
      (launch.inboundRelay !== undefined ||
        (launch.loopbackRelayPorts?.length ?? 0) > 0 ||
        (launch.serverRelays?.length ?? 0) > 0)
    ) {
      return { status: "refused", code: "sandbox-policy-conflict", rules: ["network.relays"] };
    }
    const effective: ProcessConfinementPrepareInput = {
      ...launch,
      readRoots: [...(launch.readRoots ?? []), ...readOnly.map((root) => root.path)],
      additionalWriteRoots: [
        ...(launch.additionalWriteRoots ?? []),
        ...readWrite.map((root) => root.path),
      ],
      policyReadOnlyRoots: readOnly.map((root) => root.path),
      policyFolderRoots: [...readOnly, ...readWrite].map((root) => root.path),
      networkEgress,
    };
    const backend = platform === "darwin" ? "seatbelt-v1" : "bubblewrap-v1";
    const policyDigest = digest({
      policy: selection.policy,
      context: selection.context,
      readOnly,
      readWrite,
    });
    return {
      status: "admitted",
      input: effective,
      receipt: Object.freeze({
        policyDigest,
        backend,
        reuseKey: digest({
          runtimeEpoch,
          policyDigest,
          backend,
          launch: effective,
          boundRoots,
          readRoots,
          writable,
        }),
      }),
    };
  } catch {
    return {
      status: "refused",
      code: "sandbox-policy-unavailable",
      rules: ["filesystem.allowedFolders"],
    };
  }
}
