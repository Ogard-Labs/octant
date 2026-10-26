/**
 * The protocol between this host and the executor it starts on an SSH target,
 * over that one SSH session's standard input and output. Canonical:
 * docs/design/remote-ssh-environments.md § Transport.
 *
 * After a fixed preamble, each side writes frames: a four-byte big-endian
 * length, then that many bytes of UTF-8 JSON, decoded against these schemas
 * on both sides. Requests go from host to executor; the executor sends only
 * its introduction and replies. It cannot start a turn, ask for approval, call
 * a tool, or write to the journal, and nothing it sends admits work: the host
 * decides admission from the facts in a reply.
 */

import { Schema } from "effect";
import {
  SshAttestationFacts,
  SshConfinedPosture,
  SshConfinementCanaryProbe,
  SshExecutorIdentityFacts,
  SshRemoteUser,
} from "./sshTarget";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The protocol this build speaks. A different version on the other side refuses. */
export const SSH_EXECUTOR_PROTOCOL_VERSION = 1;

/**
 * Written by the executor before its first frame. The target's login shell can
 * print text of its own before the executor starts; the host discards at most
 * {@link SSH_EXECUTOR_PREAMBLE_SEARCH_BYTES} of it, unread, and decodes frames
 * only after this line.
 */
export const SSH_EXECUTOR_PREAMBLE = "\u0000octant-executor\n";
export const SSH_EXECUTOR_PREAMBLE_SEARCH_BYTES = 65_536;

/** The largest frame either side accepts; a longer one ends the session. */
export const SSH_EXECUTOR_MAX_FRAME_BYTES = 1_048_576;

/**
 * The executor's first frame. Its shape never changes between protocol
 * versions, so a host can always read who answered before deciding whether to
 * say anything else.
 */
export const SshExecutorHello = Schema.Struct({
  type: Schema.Literal("hello"),
  identity: SshExecutorIdentityFacts,
}).annotations(strict);
export type SshExecutorHello = typeof SshExecutorHello.Type;

export const SshExecutorRequestId = Schema.Int.pipe(Schema.between(1, Number.MAX_SAFE_INTEGER));
export type SshExecutorRequestId = typeof SshExecutorRequestId.Type;

/**
 * Report the attestation facts, launching each listed canary probe in its
 * posture. Which probes a posture needs is the host's admission table, so the
 * host names them.
 */
export const SshExecutorAttestRequest = Schema.Struct({
  kind: Schema.Literal("attest"),
  postures: Schema.Array(
    Schema.Struct({
      posture: SshConfinedPosture,
      probes: Schema.Array(SshConfinementCanaryProbe).pipe(Schema.maxItems(16)),
    }).annotations(strict),
  ).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type SshExecutorAttestRequest = typeof SshExecutorAttestRequest.Type;

export const SshExecutorRequest = SshExecutorAttestRequest;
export type SshExecutorRequest = typeof SshExecutorRequest.Type;

/** The only frame a host sends. */
export const SshExecutorHostFrame = Schema.Struct({
  type: Schema.Literal("request"),
  id: SshExecutorRequestId,
  request: SshExecutorRequest,
}).annotations(strict);
export type SshExecutorHostFrame = typeof SshExecutorHostFrame.Type;

/**
 * The facts this connection's executor found. `remoteUser` is the account it
 * runs as, omitted when that name is not one Octant can show safely.
 */
export const SshExecutorAttestedReply = Schema.Struct({
  kind: Schema.Literal("attested"),
  remoteUser: Schema.optional(SshRemoteUser),
  facts: SshAttestationFacts,
}).annotations(strict);
export type SshExecutorAttestedReply = typeof SshExecutorAttestedReply.Type;

/** The executor is already answering a request; one runs at a time. */
export const SshExecutorBusyReply = Schema.Struct({
  kind: Schema.Literal("busy"),
}).annotations(strict);
export type SshExecutorBusyReply = typeof SshExecutorBusyReply.Type;

export const SshExecutorReply = Schema.Union(SshExecutorAttestedReply, SshExecutorBusyReply);
export type SshExecutorReply = typeof SshExecutorReply.Type;

export const SshExecutorReplyFrame = Schema.Struct({
  type: Schema.Literal("reply"),
  id: SshExecutorRequestId,
  reply: SshExecutorReply,
}).annotations(strict);
export type SshExecutorReplyFrame = typeof SshExecutorReplyFrame.Type;

/** Every frame an executor sends. */
export const SshExecutorFrame = Schema.Union(SshExecutorHello, SshExecutorReplyFrame);
export type SshExecutorFrame = typeof SshExecutorFrame.Type;
