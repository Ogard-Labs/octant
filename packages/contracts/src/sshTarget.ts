/**
 * SSH targets: a remote machine this host reaches with the system SSH client,
 * the facts its executor reports when it attests, and the admission decision
 * this host makes from them. Canonical: docs/design/remote-ssh-environments.md.
 *
 * An SSH target is never an authority. Every value here that comes from the
 * target is a report this host checks, and nothing in an attestation admits
 * work by itself: the host decides admission from these facts for one
 * connection, and a later connection starts from nothing.
 */

import { Schema } from "effect";
import { ProviderExecutionPolicy, ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

/** True when the text holds no C0 control character and no DEL. */
export function holdsNoControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export const SshTargetId = brandedUuid("SshTargetId");
export type SshTargetId = typeof SshTargetId.Type;

/**
 * One SSH session to one target. An attestation names the connection it was
 * made on, so a reconnect can never admit work on the last session's evidence.
 */
export const SshConnectionId = brandedUuid("SshConnectionId");
export type SshConnectionId = typeof SshConnectionId.Type;

/**
 * The destination as the person would type it after `ssh`: an alias from
 * their SSH configuration, `user@host`, or an `ssh://` URI. It becomes one
 * argument of the SSH client, so it may not begin with `-`, where the client
 * would read it as an option such as `-oProxyCommand=…`. Its user and host may
 * not begin with `-` either, and it holds no whitespace, control character, or
 * shell metacharacter: the client substitutes the host into a configured
 * `ProxyCommand` through `%h`, where `user@-oX` or `host;id` would reach a
 * shell or another program's options. OpenSSH 9.6 refuses the same names
 * itself; older clients pass them on.
 */
export const SshDestination = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(512),
  Schema.pattern(/^[^\s'"`$\\;&<>|(){}]+$/u),
  Schema.filter((destination) => !/(?:^|[@/[])-/u.test(destination)),
  Schema.filter(holdsNoControlCharacter),
);
export type SshDestination = typeof SshDestination.Type;

/** The key type OpenSSH names, such as `ssh-ed25519` or `ecdsa-sha2-nistp256`. */
export const SshHostKeyAlgorithm = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9@.-]{0,63}$/),
);
export type SshHostKeyAlgorithm = typeof SshHostKeyAlgorithm.Type;

/**
 * The host key the person confirmed at registration, as a known-hosts line
 * carries it. Octant connects with this key alone; a different key refuses.
 */
export const SshPinnedHostKey = Schema.Struct({
  algorithm: SshHostKeyAlgorithm,
  publicKey: Schema.String.pipe(
    Schema.minLength(16),
    Schema.maxLength(16_384),
    Schema.pattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
}).annotations(strict);
export type SshPinnedHostKey = typeof SshPinnedHostKey.Type;

/** The remote account the session logged in as, as the target reported it. */
export const SshRemoteUser = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.pattern(/^[^\s/-][^\s/]*$/u),
  Schema.filter(holdsNoControlCharacter),
);
export type SshRemoteUser = typeof SshRemoteUser.Type;

/** An absolute path on the target. It travels as frame data, never shell text. */
export const SshRemotePath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter((path) => path.startsWith("/") && holdsNoControlCharacter(path)),
);
export type SshRemotePath = typeof SshRemotePath.Type;

/**
 * The path of the headless `octant` command on the target. It is the one
 * piece of the remote command the target's login shell parses, so it is
 * limited to characters no shell treats specially.
 */
export const SshExecutorPath = SshRemotePath.pipe(Schema.pattern(/^(?:\/[A-Za-z0-9._+-]+)+$/u));
export type SshExecutorPath = typeof SshExecutorPath.Type;

/** The two platforms the confinement port supports; every other is refused. */
export const SshTargetPlatform = Schema.Literal("linux", "macos");
export type SshTargetPlatform = typeof SshTargetPlatform.Type;

/**
 * A registered target: where to connect, the key it must present, and the
 * executor to start. The remote user and platform are not part of it: they are
 * attested facts of each connection, never remembered from an earlier one.
 */
export const SshTarget = Schema.Struct({
  id: SshTargetId,
  destination: SshDestination,
  hostKey: SshPinnedHostKey,
  executorPath: SshExecutorPath,
}).annotations(strict);
export type SshTarget = typeof SshTarget.Type;

/** A host key's SHA-256 fingerprint as OpenSSH prints it. */
export const SshHostKeyFingerprint = Schema.String.pipe(
  Schema.pattern(/^SHA256:[A-Za-z0-9+/]{43}$/u),
);
export type SshHostKeyFingerprint = typeof SshHostKeyFingerprint.Type;

/** One host key this host saw a destination present, held until the person confirms it. */
export const SshHostKeyProbeId = brandedUuid("SshHostKeyProbeId");
export type SshHostKeyProbeId = typeof SshHostKeyProbeId.Type;

const ReportedName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.filter(holdsNoControlCharacter),
);

/** Fact 1: which executor answered, and whether it verified its own install. */
export const SshExecutorIdentityFacts = Schema.Struct({
  buildVersion: ReportedName,
  protocolVersion: Schema.Int.pipe(Schema.positive()),
  installVerified: Schema.Boolean,
}).annotations(strict);
export type SshExecutorIdentityFacts = typeof SshExecutorIdentityFacts.Type;

/**
 * Fact 2: the target's platform and user. The operating system and CPU
 * architecture are reported as the executor's runtime names them (`linux`,
 * `darwin`; `x64`, `arm64`) and stay open strings, so a platform Octant does
 * not support arrives as data the host can refuse rather than a decode error.
 */
export const SshTargetPlatformFacts = Schema.Struct({
  operatingSystem: ReportedName,
  architecture: ReportedName,
  uid: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type SshTargetPlatformFacts = typeof SshTargetPlatformFacts.Type;

/**
 * Fact 3: the confinement backend the executor found. `binShExecutable`
 * belongs to the Plan seccomp filter, which also needs an x64 or arm64 CPU.
 */
export const SshConfinementBackendFacts = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("seatbelt"),
    sandboxExecExecutable: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("bubblewrap"),
    bwrapExecutable: Schema.Boolean,
    unprivilegedUserNamespaces: Schema.Boolean,
    binShExecutable: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("none") }).annotations(strict),
);
export type SshConfinementBackendFacts = typeof SshConfinementBackendFacts.Type;

/**
 * The postures Octant wraps, and so the postures a canary can speak for. Full
 * access has no wrapper to attest.
 */
export const SshConfinedPosture = Schema.Literal("plan", "approval-gated", "auto-accept-edits");
export type SshConfinedPosture = typeof SshConfinedPosture.Type;

/**
 * One action a canary probe tries and a confined posture forbids. Which probes
 * each posture needs is the admission policy's table, not the executor's. The
 * `runtime-` probes run with the grant shape of a placed provider runtime (its
 * own home and account state) rather than a command's.
 */
export const SshConfinementCanaryProbe = Schema.Literal(
  "write-inside-root",
  "exec-after-start",
  "fork-after-start",
  "open-network-socket",
  "write-outside-root",
  "read-ssh-directory",
  "connect-bypassing-forwarder",
  "read-sibling-folder",
  "read-other-session-runtime",
  "runtime-write-inside-root",
  "runtime-write-read-only-account-state",
  "runtime-exec-after-start",
  "runtime-fork-after-start",
  "runtime-write-outside-root-and-home",
  "runtime-read-ssh-directory",
  "runtime-read-other-runtime-home",
  "runtime-connect-bypassing-proxy",
);
export type SshConfinementCanaryProbe = typeof SshConfinementCanaryProbe.Type;

/**
 * `refused` is the only passing outcome. `escaped` means the forbidden action
 * succeeded; `inconclusive` means the probe could not show either, such as a
 * probe that failed to start, and proves nothing.
 */
export const SshConfinementCanaryOutcome = Schema.Literal("refused", "escaped", "inconclusive");
export type SshConfinementCanaryOutcome = typeof SshConfinementCanaryOutcome.Type;

export const SshConfinementCanaryResult = Schema.Struct({
  probe: SshConfinementCanaryProbe,
  outcome: SshConfinementCanaryOutcome,
}).annotations(strict);
export type SshConfinementCanaryResult = typeof SshConfinementCanaryResult.Type;

/** Fact 4, for one posture: each probe launched with that posture's grants. */
export const SshPostureCanaries = Schema.Struct({
  posture: SshConfinedPosture,
  results: Schema.Array(SshConfinementCanaryResult).pipe(Schema.maxItems(32)),
}).annotations(strict);
export type SshPostureCanaries = typeof SshPostureCanaries.Type;

export const SshAttestationFacts = Schema.Struct({
  identity: SshExecutorIdentityFacts,
  platform: SshTargetPlatformFacts,
  backend: SshConfinementBackendFacts,
  canaries: Schema.Array(SshPostureCanaries).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type SshAttestationFacts = typeof SshAttestationFacts.Type;

/** The facts one connection's executor reported. Never carried to the next. */
export const SshAttestation = Schema.Struct({
  connectionId: SshConnectionId,
  facts: SshAttestationFacts,
}).annotations(strict);
export type SshAttestation = typeof SshAttestation.Type;

/**
 * Why a request on an SSH target was refused before any effect. The design's
 * refusal table names the recovery the person sees for each.
 */
export const SshAdmissionPlainRefusalReason = Schema.Literal(
  "target-removed",
  "target-unreachable",
  "host-key-changed",
  "executor-missing",
  "executor-version-mismatch",
  "unsupported-platform",
  "remote-root-user",
  "confinement-backend-missing",
  "user-namespaces-unavailable",
  "plan-filter-unavailable",
  "runtime-not-attestable",
  "full-access-not-remembered",
);
export type SshAdmissionPlainRefusalReason = typeof SshAdmissionPlainRefusalReason.Type;

export const SshAdmissionDecision = Schema.Union(
  Schema.Struct({ status: Schema.Literal("admitted") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: SshAdmissionPlainRefusalReason,
  }).annotations(strict),
  /** Names the posture and the forbidden action that succeeded. */
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("confinement-canary-escaped"),
    posture: SshConfinedPosture,
    probe: SshConfinementCanaryProbe,
  }).annotations(strict),
  /**
   * No passing attestation for this connection and posture. `probe` names the
   * one that did not report a refusal; it is absent when this connection holds
   * no attestation for the posture at all, or none whatever.
   */
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("not-attested"),
    posture: ProviderExecutionPolicy,
    probe: Schema.optional(SshConfinementCanaryProbe),
  }).annotations(strict),
);
export type SshAdmissionDecision = typeof SshAdmissionDecision.Type;
export type SshAdmissionRefusalReason = Extract<
  SshAdmissionDecision,
  { readonly status: "refused" }
>["reason"];

/**
 * Local administration of SSH targets. Only a local window or the local CLI
 * reaches these; a paired device can neither register a target nor accept a
 * host key.
 */

/** Connect once to read the host key `destination` presents, without trusting it. */
export const SshHostKeyProbeRequest = Schema.Struct({
  destination: SshDestination,
}).annotations(strict);
export type SshHostKeyProbeRequest = typeof SshHostKeyProbeRequest.Type;

/** The key a destination presented, for the person to compare before pinning it. */
export const SshHostKeyProbe = Schema.Struct({
  probeId: SshHostKeyProbeId,
  destination: SshDestination,
  hostKey: SshPinnedHostKey,
  fingerprint: SshHostKeyFingerprint,
}).annotations(strict);
export type SshHostKeyProbe = typeof SshHostKeyProbe.Type;

/**
 * Pins the probed key and registers the target. `fingerprint` is the one the
 * person confirmed; a probe whose key has another fingerprint is refused.
 */
export const SshTargetRegisterRequest = Schema.Struct({
  probeId: SshHostKeyProbeId,
  fingerprint: SshHostKeyFingerprint,
  executorPath: SshExecutorPath,
}).annotations(strict);
export type SshTargetRegisterRequest = typeof SshTargetRegisterRequest.Type;

/** Replaces a target's pin with a newly probed key of the same destination. */
export const SshTargetRepinRequest = Schema.Struct({
  targetId: SshTargetId,
  probeId: SshHostKeyProbeId,
  fingerprint: SshHostKeyFingerprint,
}).annotations(strict);
export type SshTargetRepinRequest = typeof SshTargetRepinRequest.Type;

export const SshTargetRequest = Schema.Struct({ targetId: SshTargetId }).annotations(strict);
export type SshTargetRequest = typeof SshTargetRequest.Type;

/**
 * Where one provider instance's runtime is on a target, as the person set it
 * from this machine. A runtime placed on the target launches this path and
 * no other: never one from the model, the remote root, or the target's own
 * report. The executor still checks the file before every launch.
 */
export const SshRuntimeBinary = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  path: SshRemotePath,
}).annotations(strict);
export type SshRuntimeBinary = typeof SshRuntimeBinary.Type;

/** The most runtime paths one target holds, one per provider instance. */
export const SSH_TARGET_MAX_RUNTIME_BINARIES = 64;

/** Sets, or replaces, the runtime path of one provider instance on a target. */
export const SshRuntimeBinarySetRequest = Schema.Struct({
  targetId: SshTargetId,
  providerInstanceId: ProviderInstanceId,
  path: SshRemotePath,
}).annotations(strict);
export type SshRuntimeBinarySetRequest = typeof SshRuntimeBinarySetRequest.Type;

/**
 * The connection as this host sees it now. It lives in memory only and is
 * never journaled: a restart begins every target at `not-connected`.
 */
export const SshTargetConnectionState = Schema.Literal(
  "not-connected",
  "unreachable",
  "host-key-changed",
  "executor-missing",
  "executor-version-mismatch",
  "connected",
);
export type SshTargetConnectionState = typeof SshTargetConnectionState.Type;

export const SshTargetPostureAdmission = Schema.Struct({
  posture: SshConfinedPosture,
  decision: SshAdmissionDecision,
}).annotations(strict);
export type SshTargetPostureAdmission = typeof SshTargetPostureAdmission.Type;

/** The most placeable runtimes one target's status lists. */
export const SSH_TARGET_MAX_PLACEABLE_RUNTIMES = 64;

/**
 * A provider instance whose agent a remote-bound Project's turn could place on
 * the target: its driver passes the check a turn makes before it binds (an ACP
 * agent that declares placement). It carries the runtime's own admission now
 * in each confined posture and whether the person set where it is there. A
 * window offers the agent only where both allow; the host still decides
 * every turn itself.
 */
export const SshPlaceableRuntime = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  runtimePath: Schema.Literal("set", "missing"),
  admission: Schema.Array(SshTargetPostureAdmission).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type SshPlaceableRuntime = typeof SshPlaceableRuntime.Type;

/**
 * A target and what this host would admit on it now, for Octant's own launches
 * in each confined posture. The remote user and platform appear only while the
 * current connection's attestation reports them.
 */
export const SshTargetStatus = Schema.Struct({
  target: SshTarget,
  fingerprint: SshHostKeyFingerprint,
  connection: SshTargetConnectionState,
  remoteUser: Schema.optional(SshRemoteUser),
  platform: Schema.optional(SshTargetPlatform),
  admission: Schema.Array(SshTargetPostureAdmission).pipe(Schema.maxItems(8)),
  runtimeBinaries: Schema.Array(SshRuntimeBinary).pipe(
    Schema.maxItems(SSH_TARGET_MAX_RUNTIME_BINARIES),
  ),
  placeableRuntimes: Schema.Array(SshPlaceableRuntime).pipe(
    Schema.maxItems(SSH_TARGET_MAX_PLACEABLE_RUNTIMES),
  ),
}).annotations(strict);
export type SshTargetStatus = typeof SshTargetStatus.Type;

export const SshTargetList = Schema.Struct({
  targets: Schema.Array(SshTargetStatus),
}).annotations(strict);
export type SshTargetList = typeof SshTargetList.Type;

/** Why an administration request changed nothing. */
export const SshTargetAdministrationRefusalReason = Schema.Literal(
  /** The probe expired, was already used, or never existed. */
  "unknown-probe",
  /** The confirmed fingerprint is not the probed key's. */
  "fingerprint-not-confirmed",
  /** The destination could not be reached, or presented no key this host can read. */
  "host-key-unavailable",
  "unknown-target",
  /** A re-pin probe was made for another destination than the target's. */
  "destination-mismatch",
  /** The target already holds the most runtime paths it may. */
  "too-many-runtime-binaries",
  /** A thread on one of the target's Projects is running a turn there. */
  "target-in-use",
);
export type SshTargetAdministrationRefusalReason = typeof SshTargetAdministrationRefusalReason.Type;

export const SshTargetAdministrationRefusal = Schema.Struct({
  status: Schema.Literal("refused"),
  reason: SshTargetAdministrationRefusalReason,
  message: Schema.String,
}).annotations(strict);
export type SshTargetAdministrationRefusal = typeof SshTargetAdministrationRefusal.Type;
