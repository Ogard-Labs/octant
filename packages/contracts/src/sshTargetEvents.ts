/**
 * Journal events for SSH targets and the Code Projects bound to their
 * folders. Canonical: docs/design/remote-ssh-environments.md § Data placement
 * and lifecycle.
 *
 * The journal is the record of every registration, pinned key, attestation
 * result, and binding. The pin file the SSH client reads is written from it;
 * connection state is never journaled. An attestation is journaled as a digest
 * of the facts the executor reported and what this host decided from them, so
 * a refusal can be explained later without keeping the facts themselves.
 */

import { Schema } from "effect";
import { SshRemoteProject } from "./sshRemoteProject";
import {
  SshConnectionId,
  SshPinnedHostKey,
  SshTarget,
  SshTargetId,
  SshTargetPostureAdmission,
} from "./sshTarget";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SSH_TARGET_AGGREGATE = "ssh-target";
export const SSH_TARGET_EVENT_NAMES = {
  registered: "ssh-target.registered@1",
  repinned: "ssh-target.repinned@1",
  attested: "ssh-target.attested@1",
  removed: "ssh-target.removed@1",
} as const;

export const SSH_REMOTE_PROJECT_AGGREGATE = "ssh-remote-project";
export const SSH_REMOTE_PROJECT_EVENT_NAMES = {
  bound: "ssh-remote-project.bound@1",
} as const;

export const SshTargetRegistered = Schema.Struct({ target: SshTarget }).annotations(strict);
export type SshTargetRegistered = typeof SshTargetRegistered.Type;

export const SshTargetRepinned = Schema.Struct({
  targetId: SshTargetId,
  hostKey: SshPinnedHostKey,
}).annotations(strict);
export type SshTargetRepinned = typeof SshTargetRepinned.Type;

/** SHA-256 of the attestation facts as their schema encodes them, as lowercase hex. */
export const SshAttestationFactsDigest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
export type SshAttestationFactsDigest = typeof SshAttestationFactsDigest.Type;

/**
 * One connection's attestation: which connection, the digest of what its
 * executor reported, and the decision for each confined posture it covered.
 */
export const SshTargetAttested = Schema.Struct({
  targetId: SshTargetId,
  connectionId: SshConnectionId,
  factsDigest: SshAttestationFactsDigest,
  admission: Schema.Array(SshTargetPostureAdmission).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type SshTargetAttested = typeof SshTargetAttested.Type;

export const SshTargetRemoved = Schema.Struct({ targetId: SshTargetId }).annotations(strict);
export type SshTargetRemoved = typeof SshTargetRemoved.Type;

export const SshRemoteProjectBound = Schema.Struct({
  project: SshRemoteProject,
}).annotations(strict);
export type SshRemoteProjectBound = typeof SshRemoteProjectBound.Type;

export const decodeSshTargetRegistered = Schema.decodeUnknownSync(SshTargetRegistered);
export const decodeSshTargetRepinned = Schema.decodeUnknownSync(SshTargetRepinned);
export const decodeSshTargetAttested = Schema.decodeUnknownSync(SshTargetAttested);
export const decodeSshTargetRemoved = Schema.decodeUnknownSync(SshTargetRemoved);
export const decodeSshRemoteProjectBound = Schema.decodeUnknownSync(SshRemoteProjectBound);
