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
 *
 * Every read names the remote root the host bound and a path relative to it.
 * The executor refuses a root that moved and a path that resolves outside it,
 * and no request writes.
 */

import { Schema } from "effect";
import { CodeRelativePath } from "./code";
import {
  SshRemoteDirectoryListing,
  SshRemoteFileContent,
  SshRemoteGitDiff,
  SshRemoteGitStatus,
  SshRemoteReadRefusalReason,
} from "./sshRemoteProject";
import {
  SshAttestationFacts,
  SshConfinedPosture,
  SshConfinementCanaryProbe,
  SshExecutorIdentityFacts,
  SshRemotePath,
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

/**
 * Resolve the folder a Project would bind to its canonical path, refused when
 * it is not a directory or not a folder Octant confines reads to.
 */
export const SshExecutorResolveRootRequest = Schema.Struct({
  kind: Schema.Literal("resolve-root"),
  root: SshRemotePath,
}).annotations(strict);
export type SshExecutorResolveRootRequest = typeof SshExecutorResolveRootRequest.Type;

/** One directory of the bound root, one level deep. */
export const SshExecutorListDirectoryRequest = Schema.Struct({
  kind: Schema.Literal("list-directory"),
  root: SshRemotePath,
  directory: Schema.optional(CodeRelativePath),
}).annotations(strict);
export type SshExecutorListDirectoryRequest = typeof SshExecutorListDirectoryRequest.Type;

export const SshExecutorReadFileRequest = Schema.Struct({
  kind: Schema.Literal("read-file"),
  root: SshRemotePath,
  path: CodeRelativePath,
}).annotations(strict);
export type SshExecutorReadFileRequest = typeof SshExecutorReadFileRequest.Type;

export const SshExecutorGitStatusRequest = Schema.Struct({
  kind: Schema.Literal("git-status"),
  root: SshRemotePath,
}).annotations(strict);
export type SshExecutorGitStatusRequest = typeof SshExecutorGitStatusRequest.Type;

export const SshExecutorGitDiffRequest = Schema.Struct({
  kind: Schema.Literal("git-diff"),
  root: SshRemotePath,
  path: Schema.optional(CodeRelativePath),
}).annotations(strict);
export type SshExecutorGitDiffRequest = typeof SshExecutorGitDiffRequest.Type;

/** The read requests. Each names the bound root, and none writes. */
export const SshExecutorReadRequest = Schema.Union(
  SshExecutorResolveRootRequest,
  SshExecutorListDirectoryRequest,
  SshExecutorReadFileRequest,
  SshExecutorGitStatusRequest,
  SshExecutorGitDiffRequest,
);
export type SshExecutorReadRequest = typeof SshExecutorReadRequest.Type;

export const SshExecutorRequest = Schema.Union(SshExecutorAttestRequest, SshExecutorReadRequest);
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

export const SshExecutorRootResolvedReply = Schema.Struct({
  kind: Schema.Literal("root-resolved"),
  root: SshRemotePath,
}).annotations(strict);
export type SshExecutorRootResolvedReply = typeof SshExecutorRootResolvedReply.Type;

export const SshExecutorDirectoryListedReply = Schema.Struct({
  kind: Schema.Literal("directory-listed"),
  listing: SshRemoteDirectoryListing,
}).annotations(strict);
export type SshExecutorDirectoryListedReply = typeof SshExecutorDirectoryListedReply.Type;

export const SshExecutorFileReadReply = Schema.Struct({
  kind: Schema.Literal("file-read"),
  file: SshRemoteFileContent,
}).annotations(strict);
export type SshExecutorFileReadReply = typeof SshExecutorFileReadReply.Type;

export const SshExecutorGitStatusReply = Schema.Struct({
  kind: Schema.Literal("git-status"),
  status: SshRemoteGitStatus,
}).annotations(strict);
export type SshExecutorGitStatusReply = typeof SshExecutorGitStatusReply.Type;

export const SshExecutorGitDiffReply = Schema.Struct({
  kind: Schema.Literal("git-diff"),
  diff: SshRemoteGitDiff,
}).annotations(strict);
export type SshExecutorGitDiffReply = typeof SshExecutorGitDiffReply.Type;

/** A read the executor answered without its result, and why. */
export const SshExecutorRefusedReply = Schema.Struct({
  kind: Schema.Literal("refused"),
  reason: SshRemoteReadRefusalReason,
}).annotations(strict);
export type SshExecutorRefusedReply = typeof SshExecutorRefusedReply.Type;

export const SshExecutorReadReply = Schema.Union(
  SshExecutorRootResolvedReply,
  SshExecutorDirectoryListedReply,
  SshExecutorFileReadReply,
  SshExecutorGitStatusReply,
  SshExecutorGitDiffReply,
  SshExecutorRefusedReply,
);
export type SshExecutorReadReply = typeof SshExecutorReadReply.Type;

export const SshExecutorReply = Schema.Union(
  SshExecutorAttestedReply,
  SshExecutorBusyReply,
  SshExecutorReadReply,
);
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
