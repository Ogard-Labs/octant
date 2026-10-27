/**
 * The protocol between this host and the executor it starts on an SSH target,
 * over that one SSH session's standard input and output. Canonical:
 * docs/design/remote-ssh-environments.md § Transport.
 *
 * After a fixed preamble, each side writes frames: a four-byte big-endian
 * length, then that many bytes of UTF-8 JSON, decoded against these schemas
 * on both sides. Requests go from host to executor; the executor sends only
 * its introduction, replies, the bytes of streams a running command opened,
 * and answers to the host's `resolve` and `dial`. It cannot start a turn, ask
 * for approval, call a tool, or write to the journal, and nothing it sends
 * admits work: the host decides admission from the facts in a reply, and every
 * egress decision from its own proxy.
 *
 * Every read names the remote root the host bound and a path relative to it.
 * The executor refuses a root that moved and a path that resolves outside it.
 * The native harness's file tools and commands name the root too. A command
 * runs only through the executor's confinement in the posture the host
 * admitted, and its network reaches only this host's egress proxy, through
 * byte streams the session carries (`stream-*` frames), whose names the host
 * asks the target to resolve and whose connections it asks the target to open
 * (`resolve`, `dial`).
 */

import { Schema } from "effect";
import { CodeRelativePath } from "./code";
import {
  MAX_NATIVE_HARNESS_COMMAND_TIMEOUT_MS,
  NativeHarnessEditArguments,
  NativeHarnessGlobArguments,
  NativeHarnessGrepArguments,
  NativeHarnessReadArguments,
  NativeHarnessToolResultBounds,
  NativeHarnessWriteArguments,
} from "./nativeHarness";
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
import {
  MAX_TOOL_EGRESS_HOST_LENGTH,
  TOOL_EGRESS_HOST_NAME_PATTERN,
  ToolEgressPort,
} from "./toolEgressHost";

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

/**
 * One native-harness file tool on the bound root, with the tool's own
 * arguments. `reader` names the host's tool set: an edit needs a read of the
 * same file by the same reader, as a local harness session's file system
 * remembers its own reads and no other thread's.
 */
export const SshExecutorHarnessFileRequest = Schema.Struct({
  kind: Schema.Literal("harness-file"),
  root: SshRemotePath,
  reader: Schema.UUID,
  operation: Schema.Union(
    Schema.Struct({
      tool: Schema.Literal("read"),
      arguments: NativeHarnessReadArguments,
    }).annotations(strict),
    Schema.Struct({
      tool: Schema.Literal("write"),
      arguments: NativeHarnessWriteArguments,
    }).annotations(strict),
    Schema.Struct({
      tool: Schema.Literal("edit"),
      arguments: NativeHarnessEditArguments,
    }).annotations(strict),
    Schema.Struct({
      tool: Schema.Literal("glob"),
      arguments: NativeHarnessGlobArguments,
    }).annotations(strict),
    Schema.Struct({
      tool: Schema.Literal("grep"),
      arguments: NativeHarnessGrepArguments,
    }).annotations(strict),
  ),
}).annotations(strict);
export type SshExecutorHarnessFileRequest = typeof SshExecutorHarnessFileRequest.Type;

/**
 * The postures a command runs in. Plan launches no command, so it has no
 * value here; Full access launches as it does on this host.
 */
export const SshCommandPosture = Schema.Literal(
  "approval-gated",
  "auto-accept-edits",
  "full-access",
);
export type SshCommandPosture = typeof SshCommandPosture.Type;

/**
 * The network a command reaches: none, this host's egress proxy for its
 * launch, or the target's own network (Full access only, as on this host).
 */
export const SshCommandNetwork = Schema.Literal("none", "proxied", "allow");
export type SshCommandNetwork = typeof SshCommandNetwork.Type;

/** The longest command one request carries. */
export const SSH_EXECUTOR_MAX_COMMAND_BYTES = 65_536;
/** The most of each output stream a command reply carries: its last bytes. */
export const SSH_EXECUTOR_MAX_COMMAND_OUTPUT_BYTES = 192 * 1_024;

/** The token this host's egress proxy issued for one launch, as hex. */
export const SshEgressToken = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
export type SshEgressToken = typeof SshEgressToken.Type;

/**
 * Runs one harness command with `/bin/sh` in the bound root, confined with
 * the posture's grants. A proxied command carries its launch's egress token,
 * which its proxy variables present to this host's proxy; no other command
 * carries one, and only Full access reaches the target's own network.
 */
export const SshExecutorRunCommandRequest = Schema.Struct({
  kind: Schema.Literal("run-command"),
  root: SshRemotePath,
  command: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(SSH_EXECUTOR_MAX_COMMAND_BYTES),
    Schema.filter((value) => !value.includes("\u0000")),
  ),
  posture: SshCommandPosture,
  network: SshCommandNetwork,
  egressToken: Schema.optional(SshEgressToken),
  timeoutMs: Schema.Int.pipe(Schema.between(1, MAX_NATIVE_HARNESS_COMMAND_TIMEOUT_MS)),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (request) =>
        (request.network === "proxied") === (request.egressToken !== undefined) &&
        (request.network !== "allow" || request.posture === "full-access"),
    ),
  );
export type SshExecutorRunCommandRequest = typeof SshExecutorRunCommandRequest.Type;

export const SshExecutorRequest = Schema.Union(
  SshExecutorAttestRequest,
  SshExecutorReadRequest,
  SshExecutorHarnessFileRequest,
  SshExecutorRunCommandRequest,
);
export type SshExecutorRequest = typeof SshExecutorRequest.Type;

export const SshExecutorRequestFrame = Schema.Struct({
  type: Schema.Literal("request"),
  id: SshExecutorRequestId,
  request: SshExecutorRequest,
}).annotations(strict);
export type SshExecutorRequestFrame = typeof SshExecutorRequestFrame.Type;

/** Stops the request in flight with this id; a command then ends as `cancelled`. */
export const SshExecutorCancelFrame = Schema.Struct({
  type: Schema.Literal("cancel"),
  id: SshExecutorRequestId,
}).annotations(strict);
export type SshExecutorCancelFrame = typeof SshExecutorCancelFrame.Type;

/**
 * One byte stream of a proxied command. The executor opens odd ids, one per
 * connection the confined command makes to its forwarder; this host opens
 * even ids, one per connection its proxy asks the target to make.
 */
export const SshExecutorStreamId = Schema.Int.pipe(Schema.between(1, 2_147_483_647));
export type SshExecutorStreamId = typeof SshExecutorStreamId.Type;

/** The most bytes one data frame carries, before base64. */
export const SSH_EXECUTOR_MAX_STREAM_CHUNK_BYTES = 65_536;
/** The most bytes either side sends on one stream before the other grants more. */
export const SSH_EXECUTOR_STREAM_WINDOW_BYTES = 262_144;

const Base64 = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/u));

export const SshExecutorStreamDataFrame = Schema.Struct({
  type: Schema.Literal("stream-data"),
  stream: SshExecutorStreamId,
  data: Base64.pipe(
    Schema.minLength(4),
    Schema.maxLength(Math.ceil(SSH_EXECUTOR_MAX_STREAM_CHUNK_BYTES / 3) * 4),
  ),
}).annotations(strict);
export type SshExecutorStreamDataFrame = typeof SshExecutorStreamDataFrame.Type;

/** The sender sends no more on this stream; it still reads. */
export const SshExecutorStreamEndFrame = Schema.Struct({
  type: Schema.Literal("stream-end"),
  stream: SshExecutorStreamId,
}).annotations(strict);
export type SshExecutorStreamEndFrame = typeof SshExecutorStreamEndFrame.Type;

/** The stream is gone in both directions. */
export const SshExecutorStreamCloseFrame = Schema.Struct({
  type: Schema.Literal("stream-close"),
  stream: SshExecutorStreamId,
}).annotations(strict);
export type SshExecutorStreamCloseFrame = typeof SshExecutorStreamCloseFrame.Type;

/** The receiver took `bytes` more off the stream, so the sender may send that much more. */
export const SshExecutorStreamCreditFrame = Schema.Struct({
  type: Schema.Literal("stream-credit"),
  stream: SshExecutorStreamId,
  bytes: Schema.Int.pipe(Schema.between(1, SSH_EXECUTOR_STREAM_WINDOW_BYTES)),
}).annotations(strict);
export type SshExecutorStreamCreditFrame = typeof SshExecutorStreamCreditFrame.Type;

export const SshExecutorStreamFrame = Schema.Union(
  SshExecutorStreamDataFrame,
  SshExecutorStreamEndFrame,
  SshExecutorStreamCloseFrame,
  SshExecutorStreamCreditFrame,
);
export type SshExecutorStreamFrame = typeof SshExecutorStreamFrame.Type;

/** An IP address this host's proxy checked, never a name, so nothing resolves at connect. */
export const SshEgressAddress = Schema.String.pipe(
  Schema.minLength(2),
  Schema.maxLength(45),
  Schema.pattern(/^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)$/u),
);
export type SshEgressAddress = typeof SshEgressAddress.Type;

/**
 * Opens a connection from the target to an address this host's proxy checked
 * and allowed, as stream `stream`. Only while a proxied command runs.
 */
export const SshExecutorDialFrame = Schema.Struct({
  type: Schema.Literal("dial"),
  stream: SshExecutorStreamId.pipe(Schema.filter((stream) => stream % 2 === 0)),
  address: SshEgressAddress,
  port: ToolEgressPort,
}).annotations(strict);
export type SshExecutorDialFrame = typeof SshExecutorDialFrame.Type;

export const SshExecutorQuestionId = Schema.Int.pipe(Schema.between(1, Number.MAX_SAFE_INTEGER));
export type SshExecutorQuestionId = typeof SshExecutorQuestionId.Type;

/** A destination name, in the form egress rules compare it. */
export const SshEgressHostName = Schema.String.pipe(
  Schema.maxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
  Schema.pattern(TOOL_EGRESS_HOST_NAME_PATTERN),
);
export type SshEgressHostName = typeof SshEgressHostName.Type;

/**
 * Resolves a name with the target's resolver, the one its connections use.
 * Only while a proxied command runs; this host checks every answer.
 */
export const SshExecutorResolveFrame = Schema.Struct({
  type: Schema.Literal("resolve"),
  question: SshExecutorQuestionId,
  host: SshEgressHostName,
}).annotations(strict);
export type SshExecutorResolveFrame = typeof SshExecutorResolveFrame.Type;

/** Every frame a host sends. */
export const SshExecutorHostFrame = Schema.Union(
  SshExecutorRequestFrame,
  SshExecutorCancelFrame,
  SshExecutorDialFrame,
  SshExecutorResolveFrame,
  SshExecutorStreamFrame,
);
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

/** Why a harness file tool did nothing, as a local harness file system reports it. */
export const SshHarnessFileRefusalReason = Schema.Literal(
  "path-escapes-root",
  "path-not-found",
  "not-a-file",
  "file-too-large",
  "not-read-first",
  "file-changed-since-read",
  "old-text-not-found",
  "old-text-ambiguous",
  "pattern-invalid",
);
export type SshHarnessFileRefusalReason = typeof SshHarnessFileRefusalReason.Type;

/** A path the harness shows the model: relative to the bound root, never a target path. */
const HarnessDisplayPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter((value) => !value.startsWith("/") && !value.includes("\u0000")),
);
const HarnessCount = Schema.Int.pipe(Schema.nonNegative());

/** What a harness file tool returned on the target, in the shape it returns locally. */
export const SshHarnessFileResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: HarnessDisplayPath,
    startLine: HarnessCount,
    lines: Schema.Array(Schema.String).pipe(Schema.maxItems(2_000)),
    totalLines: HarnessCount,
    nextLine: Schema.optionalWith(HarnessCount, { exact: true }),
    bounds: NativeHarnessToolResultBounds,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("directory"),
    path: HarnessDisplayPath,
    entries: Schema.Array(
      Schema.Struct({
        name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_024)),
        kind: Schema.Literal("file", "directory", "other"),
      }).annotations(strict),
    ).pipe(Schema.maxItems(1_000)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("edited"),
    path: HarnessDisplayPath,
    replacements: HarnessCount,
    fuzzy: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("written"),
    path: HarnessDisplayPath,
    bytes: HarnessCount,
    created: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("matches"),
    matches: Schema.Array(
      Schema.Struct({
        path: HarnessDisplayPath,
        line: HarnessCount,
        text: Schema.String,
      }).annotations(strict),
    ).pipe(Schema.maxItems(500)),
    filesScanned: HarnessCount,
    bounds: NativeHarnessToolResultBounds,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("paths"),
    paths: Schema.Array(HarnessDisplayPath).pipe(Schema.maxItems(1_000)),
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: SshHarnessFileRefusalReason,
  }).annotations(strict),
);
export type SshHarnessFileResult = typeof SshHarnessFileResult.Type;

export const SshExecutorHarnessFileReply = Schema.Struct({
  kind: Schema.Literal("harness-file"),
  result: SshHarnessFileResult,
}).annotations(strict);
export type SshExecutorHarnessFileReply = typeof SshExecutorHarnessFileReply.Type;

const CommandOutput = Base64.pipe(
  Schema.maxLength(Math.ceil(SSH_EXECUTOR_MAX_COMMAND_OUTPUT_BYTES / 3) * 4),
);

/**
 * How a command ended, as a local harness command reports it. Each output is
 * its last bytes, at most {@link SSH_EXECUTOR_MAX_COMMAND_OUTPUT_BYTES}.
 * `unavailable` means it never ran, such as a launch that could not be
 * confined.
 */
export const SshExecutorCommandRanReply = Schema.Struct({
  kind: Schema.Literal("command-ran"),
  termination: Schema.Literal("exited", "timed-out", "cancelled", "unavailable"),
  exitCode: Schema.optional(Schema.Int),
  stdout: CommandOutput,
  stderr: CommandOutput,
}).annotations(strict);
export type SshExecutorCommandRanReply = typeof SshExecutorCommandRanReply.Type;

export const SshExecutorReply = Schema.Union(
  SshExecutorAttestedReply,
  SshExecutorBusyReply,
  SshExecutorReadReply,
  SshExecutorHarnessFileReply,
  SshExecutorCommandRanReply,
);
export type SshExecutorReply = typeof SshExecutorReply.Type;

export const SshExecutorReplyFrame = Schema.Struct({
  type: Schema.Literal("reply"),
  id: SshExecutorRequestId,
  reply: SshExecutorReply,
}).annotations(strict);
export type SshExecutorReplyFrame = typeof SshExecutorReplyFrame.Type;

/**
 * A confined command connected to its forwarder: the executor opens stream
 * `stream` for that connection toward this host's proxy. Only while a proxied
 * command runs.
 */
export const SshExecutorStreamOpenFrame = Schema.Struct({
  type: Schema.Literal("stream-open"),
  stream: SshExecutorStreamId.pipe(Schema.filter((stream) => stream % 2 === 1)),
}).annotations(strict);
export type SshExecutorStreamOpenFrame = typeof SshExecutorStreamOpenFrame.Type;

/** Whether the target reached the address a `dial` named. */
export const SshExecutorDialedFrame = Schema.Struct({
  type: Schema.Literal("dialed"),
  stream: SshExecutorStreamId.pipe(Schema.filter((stream) => stream % 2 === 0)),
  connected: Schema.Boolean,
}).annotations(strict);
export type SshExecutorDialedFrame = typeof SshExecutorDialedFrame.Type;

/** The target's answers for a `resolve`; none when the name did not resolve. */
export const SshExecutorResolvedFrame = Schema.Struct({
  type: Schema.Literal("resolved"),
  question: SshExecutorQuestionId,
  addresses: Schema.Array(SshEgressAddress).pipe(Schema.maxItems(32)),
}).annotations(strict);
export type SshExecutorResolvedFrame = typeof SshExecutorResolvedFrame.Type;

/** Every frame an executor sends. */
export const SshExecutorFrame = Schema.Union(
  SshExecutorHello,
  SshExecutorReplyFrame,
  SshExecutorStreamOpenFrame,
  SshExecutorDialedFrame,
  SshExecutorResolvedFrame,
  SshExecutorStreamFrame,
);
export type SshExecutorFrame = typeof SshExecutorFrame.Type;
