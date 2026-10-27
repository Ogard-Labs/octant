import type { Duplex } from "node:stream";
import { Option, Schema } from "effect";
import {
  AggregateId,
  type PermissionPersistence,
  type ProviderExecutionPolicy,
  type ToolEgressLaunch,
  type ToolEgressLaunchId,
} from "@octant/contracts";
import type {
  SshCommandNetwork,
  SshCommandPosture,
  SshExecutorCommandRanReply,
  SshExecutorHarnessFileRequest,
  SshHarnessFileResult,
} from "@octant/contracts/ssh-executor-protocol";
import type { SshRemoteProject } from "@octant/contracts/ssh-remote-project";
import type { SshAdmissionDecision } from "@octant/contracts/ssh-target";
import type {
  ToolEgressCallConfirmation,
  ToolEgressLaunchEnd,
  ToolEgressLaunchStart,
} from "../harness/nativeHarnessEgressRules";
import type {
  ToolEgressProxyEndpointRequest,
  ToolEgressProxyOptions,
} from "../harness/nativeHarnessEgressProxy";
import type {
  NativeHarnessFileRefusal,
  NativeHarnessFileSystemPort,
} from "../harness/nativeHarnessFileSystem";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "../harness/nativeHarnessTools";
import {
  materializeHarnessToolNetwork,
  resolveDefaultThreadEgressPolicy,
} from "../process/threadEgressPolicy";
import type {
  SshTargetAdmissionRequest,
  SshTargetCallOutcome,
  SshTargetConnectionService,
  SshTargetSession,
} from "./sshTargetConnectionService";

/**
 * The native harness's file tools and shell for a Code thread whose Project
 * is bound to a remote root. Canonical: docs/design/remote-ssh-environments.md
 * § Native harness on a target.
 *
 * Inference, approvals, and every authority check stay on this host; these
 * ports are only the thread's hands on the target. Each call asks admission
 * in the turn's posture as it stands at that call, and travels only on the
 * session the tools were bound to: when that session ends, the turn is told
 * once and every later call refuses, so nothing is queued for a later session
 * and no new attestation is borrowed by an old turn.
 *
 * A command's network follows its posture as a local harness command's does:
 * Full access reaches the target's own network, approval-gated and
 * auto-accept-edits reach only this host's egress proxy for that launch, and
 * anything else reaches none. `proxied` never falls back to open network: a
 * host without egress rules runs those commands offline.
 */

const decodeAggregateId = Schema.decodeUnknownOption(AggregateId);

export interface SshRemoteHarnessEgress {
  /** Starts the launch's proxy on this host, as the local proxied shell does. */
  readonly startLaunch: (
    input: Pick<ToolEgressProxyOptions, "launch" | "endpoint" | "resolveAll" | "connect"> & {
      readonly confirmed?: ToolEgressCallConfirmation | undefined;
    },
  ) => Promise<ToolEgressLaunchStart>;
  /** Where this host's proxy for one launch listens. */
  readonly endpoint: ToolEgressProxyEndpointRequest;
  readonly launchId: () => ToolEgressLaunchId;
}

export interface SshRemoteHarnessOptions {
  readonly connections: Pick<
    SshTargetConnectionService,
    "admit" | "session" | "harnessFile" | "runCommand" | "resolveOnTarget" | "dialFromTarget"
  >;
  readonly egress?: SshRemoteHarnessEgress;
  readonly uuid: () => string;
}

export interface SshRemoteHarnessInput {
  readonly project: SshRemoteProject;
  /** Whose egress rules a proxied command runs under. */
  readonly scope: { readonly threadId: string; readonly projectId: string };
  /** The turn's posture now, read at every call; undefined refuses the call. */
  readonly posture: () =>
    | {
        readonly executionPolicy: ProviderExecutionPolicy;
        readonly permissionPersistence: PermissionPersistence;
      }
    | undefined;
  /** Told once, when the session the tools are bound to ends. */
  readonly onTargetDisconnected: () => void;
}

export type SshRemoteHarnessBinding =
  | {
      readonly status: "bound";
      readonly filesystem: NativeHarnessFileSystemPort;
      readonly shell: NativeHarnessShellPort;
      /** The turn ended: stop listening for the session's end. */
      readonly release: () => void;
    }
  | {
      readonly status: "refused";
      readonly decision: Extract<SshAdmissionDecision, { readonly status: "refused" }>;
    };

/**
 * Binds a turn's file tools and shell to the target's session now. A target
 * with no session, or one that does not admit file work in the turn's
 * posture, is refused with the admission reason before any tool exists.
 */
export function bindSshRemoteHarness(
  options: SshRemoteHarnessOptions,
  input: SshRemoteHarnessInput,
): SshRemoteHarnessBinding {
  const { project } = input;
  const posture = input.posture();
  const decision = options.connections.admit(project.targetId, {
    posture: posture?.executionPolicy ?? "plan",
    permissionPersistence: posture?.permissionPersistence ?? "current-session",
    subject: { kind: "file-operation" },
  });
  if (decision.status !== "admitted") return { status: "refused", decision };
  const session = options.connections.session(project.targetId);
  if (session === undefined) {
    return { status: "refused", decision: { status: "refused", reason: "target-unreachable" } };
  }
  let connected = true;
  const stopListening = session.onEnd(() => {
    connected = false;
    input.onTargetDisconnected();
  });
  const admission = (subject: SshTargetAdmissionRequest["subject"]) => {
    const now = connected ? input.posture() : undefined;
    return now === undefined
      ? undefined
      : {
          posture: now.executionPolicy,
          permissionPersistence: now.permissionPersistence,
          subject,
        };
  };
  return {
    status: "bound",
    filesystem: remoteFileSystem(options, session, project, admission),
    shell: remoteShell(options, session, input, admission),
    release: () => {
      connected = false;
      stopListening();
    },
  };
}

type Admission = (
  subject: SshTargetAdmissionRequest["subject"],
) => SshTargetAdmissionRequest | undefined;

function remoteFileSystem(
  options: SshRemoteHarnessOptions,
  session: SshTargetSession,
  project: SshRemoteProject,
  admission: Admission,
): NativeHarnessFileSystemPort {
  // One reader per tool set: an edit needs this tool set's own read first.
  const reader = options.uuid();
  const run = async (
    operation: SshExecutorHarnessFileRequest["operation"],
  ): Promise<SshHarnessFileResult | FileRefusal> => {
    const admitted = admission({ kind: "file-operation" });
    if (admitted === undefined) return refusal("target-unavailable");
    const outcome = await options.connections.harnessFile(session, admitted, {
      kind: "harness-file",
      root: project.remoteRoot,
      reader,
      operation,
    });
    if (outcome.status !== "replied") return refusal("target-unavailable");
    const { reply } = outcome;
    if (reply.kind === "harness-file") return reply.result;
    return refusal(reply.reason === "too-large" ? "file-too-large" : "target-unavailable");
  };
  // The executor answers in the shape the local file system returns, and
  // each tool takes only its own kinds: an executor that answers a read with
  // an edit's result is not believed.
  return {
    root: project.remoteRoot,
    read: async (args) => {
      const result = await run({ tool: "read", arguments: args });
      return result.kind === "file" || result.kind === "directory" || result.kind === "refused"
        ? result
        : refusal("target-unavailable");
    },
    write: async (args) => {
      const result = await run({ tool: "write", arguments: args });
      return result.kind === "written" || result.kind === "refused"
        ? result
        : refusal("target-unavailable");
    },
    edit: async (args) => {
      const result = await run({ tool: "edit", arguments: args });
      return result.kind === "edited" || result.kind === "refused"
        ? result
        : refusal("target-unavailable");
    },
    glob: async (args) => {
      const result = await run({ tool: "glob", arguments: args });
      return result.kind === "paths" || result.kind === "refused"
        ? result
        : refusal("target-unavailable");
    },
    grep: async (args) => {
      const result = await run({ tool: "grep", arguments: args });
      return result.kind === "matches" || result.kind === "refused"
        ? result
        : refusal("target-unavailable");
    },
  };
}

interface FileRefusal {
  readonly kind: "refused";
  readonly reason: NativeHarnessFileRefusal;
}

function refusal(reason: NativeHarnessFileRefusal): FileRefusal {
  return { kind: "refused", reason };
}

function commandPosture(policy: ProviderExecutionPolicy): SshCommandPosture | undefined {
  return policy === "approval-gated" || policy === "auto-accept-edits" || policy === "full-access"
    ? policy
    : undefined;
}

function remoteShell(
  options: SshRemoteHarnessOptions,
  session: SshTargetSession,
  input: SshRemoteHarnessInput,
  admission: Admission,
): NativeHarnessShellPort {
  const unavailable: NativeHarnessShellRun = {
    status: "unavailable",
    output: "",
    truncated: false,
  };
  return {
    run: async (call): Promise<NativeHarnessShellRun> => {
      const admitted = admission({ kind: "octant-launch" });
      // Plan runs no command, here as on this host.
      const posture = admitted === undefined ? undefined : commandPosture(admitted.posture);
      if (admitted === undefined || posture === undefined) return unavailable;
      // Admitted before the launch is journaled, so a refused command leaves
      // no launch record behind; the call admits again on the session.
      if (options.connections.admit(session.targetId, admitted).status !== "admitted") {
        return unavailable;
      }
      const network = commandNetwork(posture, options.egress !== undefined);
      const request = {
        kind: "run-command" as const,
        root: input.project.remoteRoot,
        command: call.command,
        posture,
        timeoutMs: call.timeoutMs,
      };
      const egress = options.egress;
      if (network !== "proxied" || egress === undefined) {
        return shellRun(
          await options.connections.runCommand(
            session,
            admitted,
            { ...request, network },
            { signal: call.signal },
          ),
        );
      }
      const threadId = decodeAggregateId(input.scope.threadId);
      const projectId = decodeAggregateId(input.scope.projectId);
      if (Option.isNone(threadId) || Option.isNone(projectId)) return unavailable;
      const launch: ToolEgressLaunch = {
        launchId: egress.launchId(),
        threadId: threadId.value,
        projectId: projectId.value,
        ...(call.callId === undefined ? {} : { toolCallId: call.callId }),
      };
      const started = await egress.startLaunch({
        launch,
        endpoint: egress.endpoint,
        resolveAll: (host) => options.connections.resolveOnTarget(session, host),
        connect: (destination): Duplex => options.connections.dialFromTarget(session, destination),
        confirmed: call.confirmedHosts,
      });
      if (started.status === "refused") return unavailable;
      let run: NativeHarnessShellRun;
      let ended: ToolEgressLaunchEnd;
      try {
        run = shellRun(
          await options.connections.runCommand(
            session,
            admitted,
            { ...request, network: "proxied", egressToken: started.launch.proxy.token },
            { signal: call.signal, egressProxy: started.launch.proxy.endpoint },
          ),
        );
      } finally {
        // The command ended on the target and its streams closed with it; the
        // launch's summary lands before the result returns, as locally.
        ended = await started.launch.finish();
      }
      // The model never reads output the journal has not marked.
      return ended.status === "summarized" ? run : unavailable;
    },
  };
}

function commandNetwork(posture: SshCommandPosture, proxiedAvailable: boolean): SshCommandNetwork {
  const network = materializeHarnessToolNetwork(
    resolveDefaultThreadEgressPolicy({ mode: "code", executionPolicy: posture }),
  );
  if (network === "allow") return posture === "full-access" ? "allow" : "none";
  if (network === "proxied") return proxiedAvailable ? "proxied" : "none";
  return "none";
}

function shellRun(
  outcome: SshTargetCallOutcome<
    SshExecutorCommandRanReply | { readonly kind: "refused"; readonly reason: string }
  >,
): NativeHarnessShellRun {
  if (outcome.status !== "replied" || outcome.reply.kind !== "command-ran") {
    return { status: "unavailable", output: "", truncated: false };
  }
  const reply = outcome.reply;
  const stdout = Buffer.from(reply.stdout, "base64").toString("utf8");
  const stderr = Buffer.from(reply.stderr, "base64").toString("utf8");
  const output =
    stderr.trim().length === 0
      ? stdout
      : stdout.trim().length === 0
        ? stderr
        : `${stdout}\n[stderr]\n${stderr}`;
  switch (reply.termination) {
    case "exited":
      return {
        status: "ran",
        ...(reply.exitCode === undefined ? {} : { exitCode: reply.exitCode }),
        output,
        truncated: false,
      };
    case "timed-out":
      return { status: "timed-out", output, truncated: false };
    case "cancelled":
      return { status: "cancelled", output, truncated: false };
    case "unavailable":
      return { status: "unavailable", output: "", truncated: false };
  }
}
