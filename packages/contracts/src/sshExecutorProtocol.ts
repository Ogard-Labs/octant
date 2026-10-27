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
 *
 * A person's terminal opens with a request and then lives beside the
 * requests: what is typed and printed travels in `terminal-*` frames, the
 * output within a window this host grants. A managed worktree is created or
 * removed by naming the Project and a one-folder name; the executor derives
 * the folder from the bound root.
 *
 * A provider runtime placed on the target starts with a request that answers
 * at once (`start-process`), then lives beside the requests on a stream this
 * host opened: its standard input and output are that stream, and its end is
 * a `process-ended` frame. Each proxied launch, command or placed process, has
 * a forwarder of its own, and every connection it forwards names that launch.
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
  SshRemoteWorktreeBranch,
  SshRemoteWorktreeName,
} from "./sshRemoteProject";
import {
  SshAttestationFacts,
  SshConfinedPosture,
  SshConfinementCanaryProbe,
  SshExecutorIdentityFacts,
  SshRemotePath,
  SshRemoteUser,
  holdsNoControlCharacter,
} from "./sshTarget";
import {
  MAX_TOOL_EGRESS_HOST_LENGTH,
  TOOL_EGRESS_HOST_NAME_PATTERN,
  ToolEgressPort,
} from "./toolEgressHost";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The protocol this build speaks. A different version on the other side
 * refuses. Version 2 added placed processes beside the request slot and named
 * each forwarded connection's launch, after builds with version 1 shipped.
 */
export const SSH_EXECUTOR_PROTOCOL_VERSION = 2;

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

/** The most terminals one session holds open at once. */
export const SSH_EXECUTOR_MAX_TERMINALS = 8;
/** The most terminal output the executor sends that this host has not yet taken off. */
export const SSH_EXECUTOR_TERMINAL_WINDOW_BYTES = 262_144;
/** The most bytes one terminal output or input frame carries, before base64. */
export const SSH_EXECUTOR_MAX_TERMINAL_CHUNK_BYTES = 65_536;

/**
 * One terminal of the session. This host names it when it opens it, each new
 * one with a higher id than the last, so a late frame of a closed terminal
 * can never be read as a new one's.
 */
export const SshExecutorTerminalId = Schema.Int.pipe(Schema.between(1, 2_147_483_647));
export type SshExecutorTerminalId = typeof SshExecutorTerminalId.Type;

const TerminalColumns = Schema.Int.pipe(Schema.between(1, 500));
const TerminalRows = Schema.Int.pipe(Schema.between(1, 500));

/**
 * Opens a person's interactive shell in the bound root on a pseudo-terminal
 * of the target, confined with the posture's attested grants. Plan opens no
 * terminal, so it has no value here. A terminal has no egress proxy of its
 * own: it runs offline, or on the target's own network in Full access only,
 * as a command does.
 */
export const SshExecutorOpenTerminalRequest = Schema.Struct({
  kind: Schema.Literal("open-terminal"),
  root: SshRemotePath,
  terminal: SshExecutorTerminalId,
  posture: SshCommandPosture,
  network: Schema.Literal("none", "allow"),
  columns: TerminalColumns,
  rows: TerminalRows,
})
  .annotations(strict)
  .pipe(
    Schema.filter((request) => request.network !== "allow" || request.posture === "full-access"),
  );
export type SshExecutorOpenTerminalRequest = typeof SshExecutorOpenTerminalRequest.Type;

/**
 * Creates a managed worktree of the bound root at
 * `<parent of root>/.octant-worktrees/<project>/<name>` on a new branch
 * `octant/<name>` from the root's checked-out commit. The executor derives the
 * folder itself, so this host never names a path to write.
 */
export const SshExecutorCreateWorktreeRequest = Schema.Struct({
  kind: Schema.Literal("create-worktree"),
  root: SshRemotePath,
  project: Schema.UUID,
  name: SshRemoteWorktreeName,
}).annotations(strict);
export type SshExecutorCreateWorktreeRequest = typeof SshExecutorCreateWorktreeRequest.Type;

/** Removes that managed worktree when Git finds no change in it; its branch stays. */
export const SshExecutorRemoveWorktreeRequest = Schema.Struct({
  kind: Schema.Literal("remove-worktree"),
  root: SshRemotePath,
  project: Schema.UUID,
  name: SshRemoteWorktreeName,
}).annotations(strict);
export type SshExecutorRemoveWorktreeRequest = typeof SshExecutorRemoveWorktreeRequest.Type;

/**
 * One byte stream beside the requests: a proxied launch's connection, or a
 * placed process's standard input and output. The executor opens odd ids,
 * one per connection a confined launch makes to its forwarder; this host
 * opens even ids, one per connection its proxy asks the target to make and
 * one per process it places.
 */
export const SshExecutorStreamId = Schema.Int.pipe(Schema.between(1, 2_147_483_647));
export type SshExecutorStreamId = typeof SshExecutorStreamId.Type;

const HostOpenedStreamId = SshExecutorStreamId.pipe(Schema.filter((stream) => stream % 2 === 0));

/** The most placed processes one session runs at once; another is refused `busy`. */
export const SSH_EXECUTOR_MAX_PLACED_PROCESSES = 4;
/** The most of a placed process's standard error its end carries: its last bytes. */
export const SSH_EXECUTOR_MAX_PROCESS_STDERR_BYTES = 65_536;
/** The most account-state paths one placed process is granted. */
export const SSH_EXECUTOR_MAX_ACCOUNT_STATE_PATHS = 4;

/** The most fixed variables, and the most denied root entries, one placed process carries. */
export const SSH_EXECUTOR_MAX_PLACED_VARIABLES = 32;
export const SSH_EXECUTOR_MAX_DENIED_ROOT_ENTRIES = 32;

/** A relative path that is never absolute and never climbs out of where it starts. */
const RelativePath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(1_024),
  Schema.filter(
    (path) =>
      !path.startsWith("/") &&
      holdsNoControlCharacter(path) &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  ),
);

/**
 * A path relative to the remote user's home, never absolute and never
 * climbing out of it, so it names a folder on the target and none of this
 * host's.
 */
export const SshHomeRelativePath = RelativePath;
export type SshHomeRelativePath = typeof SshHomeRelativePath.Type;

/**
 * The variable that points a runtime at one account-state path. It may not
 * name Octant's own variables, the SSH client's, the loader's, the proxy's,
 * or the ones the executor sets itself.
 */
export const SshAccountStateVariable = Schema.String.pipe(
  Schema.pattern(/^[A-Z_][A-Z0-9_]{0,63}$/u),
  Schema.filter(
    (name) =>
      !/^(?:OCTANT_|SSH_|LD_|DYLD_)/u.test(name) &&
      !/PROXY/u.test(name) &&
      !["PATH", "HOME", "TMPDIR", "SHELL", "USER", "LOGNAME"].includes(name),
  ),
);
export type SshAccountStateVariable = typeof SshAccountStateVariable.Type;

/**
 * One path the runtime's driver declares for its sign-in, at the same place
 * under the target user's home as under this host's. Read-only unless the
 * runtime's own local launch writes it.
 */
export const SshPlacedAccountState = Schema.Struct({
  path: SshHomeRelativePath,
  access: Schema.Literal("read-only", "read-write"),
  variable: Schema.optional(SshAccountStateVariable),
}).annotations(strict);
export type SshPlacedAccountState = typeof SshPlacedAccountState.Type;

/**
 * A variable the runtime's own local launch sets to a constant of its
 * driver's, such as a switch that turns off auto-update or a Project's own
 * configuration. Its name follows the account-state variable's rules, and its
 * value holds no `/`, so it names no folder of this host or the target.
 */
export const SshPlacedVariable = Schema.Struct({
  name: SshAccountStateVariable,
  value: Schema.String.pipe(
    Schema.maxLength(1_024),
    Schema.filter((value) => holdsNoControlCharacter(value) && !value.includes("/")),
  ),
}).annotations(strict);
export type SshPlacedVariable = typeof SshPlacedVariable.Type;

export const SshPlacedVariables = Schema.Array(SshPlacedVariable).pipe(
  Schema.maxItems(SSH_EXECUTOR_MAX_PLACED_VARIABLES),
  Schema.filter(
    (variables) => new Set(variables.map((variable) => variable.name)).size === variables.length,
  ),
);

/**
 * Entries of the bound root the runtime may neither read nor write: files and
 * folders a runtime loads by itself that would start tools without Octant's
 * approval. Each is relative to the root and never climbs out of it.
 */
export const SshDeniedRootEntries = Schema.Array(RelativePath).pipe(
  Schema.maxItems(SSH_EXECUTOR_MAX_DENIED_ROOT_ENTRIES),
);

const PlacedArgument = Schema.String.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => !value.includes("\u0000")),
);

/**
 * Starts a provider runtime in the bound root, confined with the posture's
 * attested runtime grants, its standard input and output the even stream this
 * host names. In every posture, Plan included, it runs on this host's proxy
 * for the launch, never the target's own network. Its home is one owner-only
 * folder per Project and provider instance on the target; the executor
 * derives the folder, so this host never names a path to write. Its fixed
 * variables are set beside the ones the executor sets, which always win over
 * one of the same name, and its denied root entries are covered in its
 * capsule.
 */
export const SshExecutorStartProcessRequest = Schema.Struct({
  kind: Schema.Literal("start-process"),
  root: SshRemotePath,
  posture: SshConfinedPosture,
  network: Schema.Literal("proxied"),
  egressToken: SshEgressToken,
  executable: SshRemotePath,
  args: Schema.Array(PlacedArgument).pipe(Schema.maxItems(64)),
  accountState: Schema.Array(SshPlacedAccountState).pipe(
    Schema.maxItems(SSH_EXECUTOR_MAX_ACCOUNT_STATE_PATHS),
  ),
  fixedVariables: Schema.optional(SshPlacedVariables),
  deniedRootEntries: Schema.optional(SshDeniedRootEntries),
  home: Schema.Struct({ project: Schema.UUID, instance: Schema.UUID }).annotations(strict),
  stream: HostOpenedStreamId,
}).annotations(strict);
export type SshExecutorStartProcessRequest = typeof SshExecutorStartProcessRequest.Type;

export const SshExecutorRequest = Schema.Union(
  SshExecutorAttestRequest,
  SshExecutorReadRequest,
  SshExecutorHarnessFileRequest,
  SshExecutorRunCommandRequest,
  SshExecutorOpenTerminalRequest,
  SshExecutorCreateWorktreeRequest,
  SshExecutorRemoveWorktreeRequest,
  SshExecutorStartProcessRequest,
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
 * Stops a placed process: its process group gets a terminate, then a kill
 * five seconds later. The executor answers with `process-ended`.
 */
export const SshExecutorStopProcessFrame = Schema.Struct({
  type: Schema.Literal("stop-process"),
  stream: HostOpenedStreamId,
}).annotations(strict);
export type SshExecutorStopProcessFrame = typeof SshExecutorStopProcessFrame.Type;

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

const TerminalChunk = Base64.pipe(
  Schema.minLength(4),
  Schema.maxLength(Math.ceil(SSH_EXECUTOR_MAX_TERMINAL_CHUNK_BYTES / 3) * 4),
);

/** What the person typed into an open terminal. */
export const SshExecutorTerminalInputFrame = Schema.Struct({
  type: Schema.Literal("terminal-input"),
  terminal: SshExecutorTerminalId,
  data: TerminalChunk,
}).annotations(strict);
export type SshExecutorTerminalInputFrame = typeof SshExecutorTerminalInputFrame.Type;

export const SshExecutorTerminalResizeFrame = Schema.Struct({
  type: Schema.Literal("terminal-resize"),
  terminal: SshExecutorTerminalId,
  columns: TerminalColumns,
  rows: TerminalRows,
}).annotations(strict);
export type SshExecutorTerminalResizeFrame = typeof SshExecutorTerminalResizeFrame.Type;

/** Ends the terminal's shell and every process it started; the executor answers `terminal-exited`. */
export const SshExecutorTerminalCloseFrame = Schema.Struct({
  type: Schema.Literal("terminal-close"),
  terminal: SshExecutorTerminalId,
}).annotations(strict);
export type SshExecutorTerminalCloseFrame = typeof SshExecutorTerminalCloseFrame.Type;

/** This host took `bytes` more of the terminal's output off, so the executor may send that much more. */
export const SshExecutorTerminalCreditFrame = Schema.Struct({
  type: Schema.Literal("terminal-credit"),
  terminal: SshExecutorTerminalId,
  bytes: Schema.Int.pipe(Schema.between(1, SSH_EXECUTOR_TERMINAL_WINDOW_BYTES)),
}).annotations(strict);
export type SshExecutorTerminalCreditFrame = typeof SshExecutorTerminalCreditFrame.Type;

export const SshExecutorTerminalHostFrame = Schema.Union(
  SshExecutorTerminalInputFrame,
  SshExecutorTerminalResizeFrame,
  SshExecutorTerminalCloseFrame,
  SshExecutorTerminalCreditFrame,
);
export type SshExecutorTerminalHostFrame = typeof SshExecutorTerminalHostFrame.Type;

/** Every frame a host sends. */
export const SshExecutorHostFrame = Schema.Union(
  SshExecutorRequestFrame,
  SshExecutorCancelFrame,
  SshExecutorDialFrame,
  SshExecutorResolveFrame,
  SshExecutorStreamFrame,
  SshExecutorTerminalHostFrame,
  SshExecutorStopProcessFrame,
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

/** The terminal is open; its output follows as `terminal-output` frames. */
export const SshExecutorTerminalOpenedReply = Schema.Struct({
  kind: Schema.Literal("terminal-opened"),
}).annotations(strict);
export type SshExecutorTerminalOpenedReply = typeof SshExecutorTerminalOpenedReply.Type;

/**
 * No terminal opened: the session holds its most, the id was not new, the
 * target has no pseudo-terminal support, or the shell could not be confined.
 */
export const SshExecutorTerminalUnavailableReply = Schema.Struct({
  kind: Schema.Literal("terminal-unavailable"),
}).annotations(strict);
export type SshExecutorTerminalUnavailableReply = typeof SshExecutorTerminalUnavailableReply.Type;

export const SshExecutorWorktreeCreatedReply = Schema.Struct({
  kind: Schema.Literal("worktree-created"),
  /** The worktree's canonical folder, which later requests name as its root. */
  path: SshRemotePath,
  branch: SshRemoteWorktreeBranch,
}).annotations(strict);
export type SshExecutorWorktreeCreatedReply = typeof SshExecutorWorktreeCreatedReply.Type;

export const SshExecutorWorktreeRemovedReply = Schema.Struct({
  kind: Schema.Literal("worktree-removed"),
}).annotations(strict);
export type SshExecutorWorktreeRemovedReply = typeof SshExecutorWorktreeRemovedReply.Type;

/** The process runs; its output follows on its stream, and nothing of it came before this reply. */
export const SshExecutorProcessStartedReply = Schema.Struct({
  kind: Schema.Literal("process-started"),
  stream: HostOpenedStreamId,
}).annotations(strict);
export type SshExecutorProcessStartedReply = typeof SshExecutorProcessStartedReply.Type;

/**
 * Why no process started: the session runs its most (`busy`); the binary is
 * not a regular executable outside the bound root and the remote user's
 * keys, in folders only the remote user or root can write; the runtime home
 * is not the remote user's own owner-only real folder; an account-state path
 * is missing, is or holds a folder no grant may reach, or is another user's;
 * or the launch could not be confined (`unavailable`).
 */
export const SshPlacedProcessRefusalReason = Schema.Literal(
  "busy",
  "runtime-binary-not-confinable",
  "runtime-home-not-confinable",
  "account-state-not-confinable",
  "unavailable",
);
export type SshPlacedProcessRefusalReason = typeof SshPlacedProcessRefusalReason.Type;

export const SshExecutorProcessRefusedReply = Schema.Struct({
  kind: Schema.Literal("process-refused"),
  reason: SshPlacedProcessRefusalReason,
}).annotations(strict);
export type SshExecutorProcessRefusedReply = typeof SshExecutorProcessRefusedReply.Type;

export const SshExecutorReply = Schema.Union(
  SshExecutorAttestedReply,
  SshExecutorBusyReply,
  SshExecutorReadReply,
  SshExecutorHarnessFileReply,
  SshExecutorCommandRanReply,
  SshExecutorTerminalOpenedReply,
  SshExecutorTerminalUnavailableReply,
  SshExecutorWorktreeCreatedReply,
  SshExecutorWorktreeRemovedReply,
  SshExecutorProcessStartedReply,
  SshExecutorProcessRefusedReply,
);
export type SshExecutorReply = typeof SshExecutorReply.Type;

export const SshExecutorReplyFrame = Schema.Struct({
  type: Schema.Literal("reply"),
  id: SshExecutorRequestId,
  reply: SshExecutorReply,
}).annotations(strict);
export type SshExecutorReplyFrame = typeof SshExecutorReplyFrame.Type;

/**
 * A confined launch connected to its forwarder: the executor opens stream
 * `stream` for that connection toward this host's proxy for `launch`, the
 * request that started the command or placed process. Only while that launch
 * runs.
 */
export const SshExecutorStreamOpenFrame = Schema.Struct({
  type: Schema.Literal("stream-open"),
  stream: SshExecutorStreamId.pipe(Schema.filter((stream) => stream % 2 === 1)),
  launch: SshExecutorRequestId,
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

/**
 * What an open terminal printed. The executor sends at most
 * {@link SSH_EXECUTOR_TERMINAL_WINDOW_BYTES} of it that this host has not
 * granted back with `terminal-credit`, and holds the shell while it waits.
 */
export const SshExecutorTerminalOutputFrame = Schema.Struct({
  type: Schema.Literal("terminal-output"),
  terminal: SshExecutorTerminalId,
  data: TerminalChunk,
}).annotations(strict);
export type SshExecutorTerminalOutputFrame = typeof SshExecutorTerminalOutputFrame.Type;

/** The terminal's shell ended; nothing more is sent for it. */
export const SshExecutorTerminalExitedFrame = Schema.Struct({
  type: Schema.Literal("terminal-exited"),
  terminal: SshExecutorTerminalId,
  exitCode: Schema.optional(Schema.Int),
}).annotations(strict);
export type SshExecutorTerminalExitedFrame = typeof SshExecutorTerminalExitedFrame.Type;

/**
 * A placed process ended: it exited with a code or a signal, and `stderr` is
 * the last of its standard error, base64-encoded. It follows the last of the
 * process's output, and it is the end of its stream: nothing more is sent on
 * that stream, so the host still reads what it holds rather than lose it to a
 * close.
 */
export const SshExecutorProcessEndedFrame = Schema.Struct({
  type: Schema.Literal("process-ended"),
  stream: HostOpenedStreamId,
  exitCode: Schema.optional(Schema.Int),
  signal: Schema.optional(Schema.String.pipe(Schema.pattern(/^SIG[A-Z0-9]{1,16}$/u))),
  stderr: Base64.pipe(Schema.maxLength(Math.ceil(SSH_EXECUTOR_MAX_PROCESS_STDERR_BYTES / 3) * 4)),
}).annotations(strict);
export type SshExecutorProcessEndedFrame = typeof SshExecutorProcessEndedFrame.Type;

/** Every frame an executor sends. */
export const SshExecutorFrame = Schema.Union(
  SshExecutorHello,
  SshExecutorReplyFrame,
  SshExecutorStreamOpenFrame,
  SshExecutorDialedFrame,
  SshExecutorResolvedFrame,
  SshExecutorStreamFrame,
  SshExecutorTerminalOutputFrame,
  SshExecutorTerminalExitedFrame,
  SshExecutorProcessEndedFrame,
);
export type SshExecutorFrame = typeof SshExecutorFrame.Type;
