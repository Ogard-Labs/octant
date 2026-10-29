import type { PermissionPersistence, ProviderExecutionPolicy } from "@octant/contracts/providers";
import type {
  SshAdmissionDecision,
  SshAdmissionPlainRefusalReason,
  SshAttestation,
  SshAttestationFacts,
  SshConfinedPosture,
  SshConfinementCanaryProbe,
  SshConnectionId,
  SshTargetPlatform,
} from "@octant/contracts/ssh-target";

/**
 * Admission of work on an SSH target: may this request, in this posture, act
 * on the target now. Canonical: docs/design/remote-ssh-environments.md §
 * Confinement attestation and admission.
 *
 * The executor reports facts and this host decides. Every launch on a target
 * and every file operation on its remote root asks this before any effect, and
 * only a passing attestation made on the current connection, for the posture
 * the request runs in, admits it. Anything the facts do not prove refuses, with
 * the reason whose recovery the person can perform.
 */

/**
 * What this host's connection service knows about the session right now. An
 * executor whose introduction names another build or protocol is never asked
 * to attest, because this host cannot rely on it to read the request.
 */
export type SshTargetConnection =
  | { readonly state: "unreachable" }
  | {
      readonly state: "reconnecting";
      readonly attempt: number;
      readonly maxAttempts: number;
      /** Absent while the attempt runs. */
      readonly nextAttemptAt?: number;
    }
  | { readonly state: "authentication-refused" }
  | { readonly state: "host-key-changed" }
  | { readonly state: "executor-missing" }
  | { readonly state: "executor-version-mismatch" }
  | { readonly state: "connected"; readonly connectionId: SshConnectionId };

/**
 * What the request would run. Octant's own launches (Git, tests, terminals,
 * and the native harness's tools, whose inference stays on this host) and file
 * operations are confined by the executor's port, which the canaries speak
 * for. A provider runtime is admitted only where Octant wraps it in this
 * posture, its driver declares remote placement, and it opens no loopback
 * tool listener on the target that other users there could reach.
 */
export type SshAdmissionSubject =
  | { readonly kind: "file-operation" }
  | { readonly kind: "octant-launch" }
  | {
      readonly kind: "provider-runtime";
      readonly octantWrapsInPosture: boolean;
      readonly remotePlacement: "declared" | "undeclared";
      readonly appToolTransportListensOnLoopback: boolean;
    };

export interface SshAdmissionRequest {
  readonly host: { readonly buildVersion: string; readonly protocolVersion: number };
  readonly target: "registered" | "removed";
  readonly connection: SshTargetConnection;
  /** The attestation this host holds for the target, if any. */
  readonly attestation?: SshAttestation;
  readonly posture: ProviderExecutionPolicy;
  readonly permissionPersistence: PermissionPersistence;
  readonly subject: SshAdmissionSubject;
}

const EVERY_WRAPPED_POSTURE_PROBES = [
  "read-sibling-folder",
  "read-other-session-runtime",
] as const satisfies ReadonlyArray<SshConfinementCanaryProbe>;

const WRITING_POSTURE_PROBES = [
  "write-outside-root",
  "read-ssh-directory",
  "connect-bypassing-forwarder",
  ...EVERY_WRAPPED_POSTURE_PROBES,
] as const satisfies ReadonlyArray<SshConfinementCanaryProbe>;

/**
 * The probes each confined posture must see refused, from the design's canary
 * table. The executor runs them; this host decides which ones count.
 */
export const SSH_CANARY_PROBES_BY_POSTURE: Readonly<
  Record<SshConfinedPosture, ReadonlyArray<SshConfinementCanaryProbe>>
> = {
  plan: [
    "write-inside-root",
    "exec-after-start",
    "fork-after-start",
    "open-network-socket",
    ...EVERY_WRAPPED_POSTURE_PROBES,
  ],
  "approval-gated": WRITING_POSTURE_PROBES,
  "auto-accept-edits": WRITING_POSTURE_PROBES,
};

/**
 * The probes a placed provider runtime's grant shape must see refused in each
 * confined posture, beside the posture's own: its home and account state are
 * grants a command does not have, so the canaries prove them before a runtime
 * is placed. A posture whose runtime probes did not all report a refusal
 * refuses placed runtimes while its commands may still be admitted.
 */
export const SSH_RUNTIME_CANARY_PROBES_BY_POSTURE: Readonly<
  Record<SshConfinedPosture, ReadonlyArray<SshConfinementCanaryProbe>>
> = {
  plan: [
    "runtime-write-inside-root",
    "runtime-write-read-only-account-state",
    "runtime-exec-after-start",
    "runtime-fork-after-start",
    "runtime-read-ssh-directory",
    "runtime-read-other-runtime-home",
    "runtime-connect-bypassing-proxy",
  ],
  "approval-gated": [
    "runtime-write-outside-root-and-home",
    "runtime-write-read-only-account-state",
    "runtime-read-ssh-directory",
    "runtime-read-other-runtime-home",
    "runtime-connect-bypassing-proxy",
  ],
  "auto-accept-edits": [
    "runtime-write-outside-root-and-home",
    "runtime-write-read-only-account-state",
    "runtime-read-ssh-directory",
    "runtime-read-other-runtime-home",
    "runtime-connect-bypassing-proxy",
  ],
};

/** CPUs the Plan process filter is built for, as the local launch requires. */
const PLAN_FILTER_ARCHITECTURES: ReadonlySet<string> = new Set(["x64", "arm64"]);

function refused(reason: SshAdmissionPlainRefusalReason): SshAdmissionDecision {
  return { status: "refused", reason };
}

function supportedPlatform(operatingSystem: string): SshTargetPlatform | undefined {
  if (operatingSystem === "linux") return "linux";
  if (operatingSystem === "darwin") return "macos";
  return undefined;
}

function subjectIsAttestable(
  subject: SshAdmissionSubject,
  posture: ProviderExecutionPolicy,
): boolean {
  if (subject.kind !== "provider-runtime") return true;
  return (
    posture !== "full-access" &&
    subject.octantWrapsInPosture &&
    subject.remotePlacement === "declared" &&
    !subject.appToolTransportListensOnLoopback
  );
}

/** The backend a confined posture launches through, or why it cannot. */
function backendRefusal(
  facts: SshAttestationFacts,
  platform: SshTargetPlatform,
  posture: SshConfinedPosture,
): SshAdmissionPlainRefusalReason | undefined {
  const { backend } = facts;
  if (platform === "macos") {
    return backend.kind === "seatbelt" && backend.sandboxExecExecutable
      ? undefined
      : "confinement-backend-missing";
  }
  if (backend.kind !== "bubblewrap" || !backend.bwrapExecutable) {
    return "confinement-backend-missing";
  }
  if (!backend.unprivilegedUserNamespaces) return "user-namespaces-unavailable";
  if (
    posture === "plan" &&
    (!PLAN_FILTER_ARCHITECTURES.has(facts.platform.architecture) || !backend.binShExecutable)
  ) {
    return "plan-filter-unavailable";
  }
  return undefined;
}

export function decideSshAdmission(request: SshAdmissionRequest): SshAdmissionDecision {
  const { posture } = request;
  if (request.target === "removed") return refused("target-removed");
  if (posture === "full-access" && request.permissionPersistence !== "project-default") {
    return refused("full-access-not-remembered");
  }
  if (!subjectIsAttestable(request.subject, posture)) return refused("runtime-not-attestable");

  const { connection } = request;
  if (connection.state === "unreachable") return refused("target-unreachable");
  if (connection.state === "reconnecting") {
    return {
      status: "refused",
      reason: "target-reconnecting",
      attempt: connection.attempt,
      maxAttempts: connection.maxAttempts,
      ...(connection.nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: connection.nextAttemptAt }),
    };
  }
  if (connection.state === "authentication-refused") return refused("authentication-refused");
  if (connection.state === "host-key-changed") return refused("host-key-changed");
  if (connection.state === "executor-missing") return refused("executor-missing");
  if (connection.state === "executor-version-mismatch") {
    return refused("executor-version-mismatch");
  }

  // Evidence is for one connection: a reconnect starts from nothing.
  const { attestation } = request;
  if (
    attestation === undefined ||
    String(attestation.connectionId) !== String(connection.connectionId)
  ) {
    return { status: "refused", reason: "not-attested", posture };
  }

  const { facts } = attestation;
  if (
    facts.identity.buildVersion !== request.host.buildVersion ||
    facts.identity.protocolVersion !== request.host.protocolVersion ||
    !facts.identity.installVerified
  ) {
    return refused("executor-version-mismatch");
  }
  const platform = supportedPlatform(facts.platform.operatingSystem);
  if (platform === undefined) return refused("unsupported-platform");
  if (facts.platform.uid === 0) return refused("remote-root-user");

  // Every posture launches through the same backend and executor, so an
  // escape in one is not evidence Octant can discount in another.
  for (const entry of facts.canaries) {
    const escaped = entry.results.find((result) => result.outcome === "escaped");
    if (escaped !== undefined) {
      return {
        status: "refused",
        reason: "confinement-canary-escaped",
        posture: entry.posture,
        probe: escaped.probe,
      };
    }
  }

  if (posture === "full-access") return { status: "admitted" };

  const backendReason = backendRefusal(facts, platform, posture);
  if (backendReason !== undefined) return refused(backendReason);

  // A report that names a posture or a probe twice counts only if every copy
  // passed, so a duplicate can never outvote an inconclusive result.
  const entries = facts.canaries.filter((candidate) => candidate.posture === posture);
  if (entries.length === 0) return { status: "refused", reason: "not-attested", posture };
  const results = entries.flatMap((candidate) => candidate.results);
  const required =
    request.subject.kind === "provider-runtime"
      ? [...SSH_CANARY_PROBES_BY_POSTURE[posture], ...SSH_RUNTIME_CANARY_PROBES_BY_POSTURE[posture]]
      : SSH_CANARY_PROBES_BY_POSTURE[posture];
  for (const probe of required) {
    const refusedEveryTime =
      results.some((result) => result.probe === probe) &&
      results.every((result) => result.probe !== probe || result.outcome === "refused");
    if (!refusedEveryTime) return { status: "refused", reason: "not-attested", posture, probe };
  }
  return { status: "admitted" };
}
