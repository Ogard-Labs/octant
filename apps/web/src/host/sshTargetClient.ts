import { Schema } from "effect";
import { decodeHostAnswer } from "@octant/contracts";
import {
  ProjectTerminalResult,
  type ProjectTerminalResult as ProjectTerminalResultValue,
} from "@octant/contracts/project-terminals";
import {
  SshRemoteProject,
  SshRemoteProjectList,
  SshRemoteProjectRefusal,
  SshRemoteWorktree,
  SshRemoteWorktreeList,
  type SshRemoteTerminalCommand,
} from "@octant/contracts/ssh-remote-project";
import {
  SshHostKeyProbe,
  SshTargetAdministrationRefusal,
  SshTargetList,
  SshTargetStatus,
} from "@octant/contracts/ssh-target";
import { describeSshRemoteProjectRefusal } from "@octant/domain/ssh-target-recovery";
import type { SshTargetAdministrationBridge, SshTargetOperation } from "../shell/hostBridge";

/**
 * The SSH targets page's view of the host's local administration routes,
 * reached through this desktop window's main process. Canonical:
 * docs/design/remote-ssh-environments.md.
 *
 * It decodes every answer as clients decode the host's, and turns a refusal
 * into the sentence the person sees; it decides nothing. The host checks
 * every value against its schemas, admits every request against the target's
 * attestation, and answers a terminal as a local Project terminal answers.
 */

export type SshTargetAnswer<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "refused"; readonly message: string };

export interface SshTargetClient {
  readonly list: () => Promise<SshTargetAnswer<SshTargetList["targets"]>>;
  readonly probeHostKey: (destination: string) => Promise<SshTargetAnswer<SshHostKeyProbe>>;
  readonly register: (
    probe: SshHostKeyProbe,
    executorPath: string,
  ) => Promise<SshTargetAnswer<SshTargetStatus>>;
  readonly repin: (
    targetId: string,
    probe: SshHostKeyProbe,
  ) => Promise<SshTargetAnswer<SshTargetStatus>>;
  readonly connect: (targetId: string) => Promise<SshTargetAnswer<SshTargetStatus>>;
  readonly remove: (targetId: string) => Promise<SshTargetAnswer<null>>;
  readonly projects: () => Promise<SshTargetAnswer<SshRemoteProjectList["projects"]>>;
  readonly bind: (
    targetId: string,
    remoteRoot: string,
    name: string,
  ) => Promise<SshTargetAnswer<SshRemoteProject>>;
  readonly worktrees: () => Promise<SshTargetAnswer<SshRemoteWorktreeList["worktrees"]>>;
  readonly createWorktree: (
    projectId: string,
    name: string,
  ) => Promise<SshTargetAnswer<SshRemoteWorktree>>;
  readonly removeWorktree: (worktreeId: string) => Promise<SshTargetAnswer<null>>;
  /** One terminal command, answered as a local Project terminal's is. */
  readonly terminal: (command: SshRemoteTerminalCommand) => Promise<ProjectTerminalResultValue>;
}

const INVALID = "Octant refused that request. Check the values and try again.";
const UNAVAILABLE = "SSH target administration is unavailable in this window.";

function decoded<A, I>(schema: Schema.Schema<A, I>, body: unknown): A | undefined {
  try {
    return decodeHostAnswer(schema)(body);
  } catch {
    return undefined;
  }
}

/** The sentence for a refused request, from whichever refusal the host sent. */
function refusalMessage(answer: { readonly status: number; readonly body: unknown }): string {
  const administration = decoded(SshTargetAdministrationRefusal, answer.body);
  if (administration !== undefined) return administration.message;
  const project = decoded(SshRemoteProjectRefusal, answer.body);
  if (project !== undefined) return describeSshRemoteProjectRefusal(project);
  return answer.status === 400 || answer.status === 413 ? INVALID : UNAVAILABLE;
}

export function createSshTargetClient(bridge: SshTargetAdministrationBridge): SshTargetClient {
  const send = async (
    operation: SshTargetOperation,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown } | undefined> => {
    try {
      return await bridge.sshTargetRequest(operation, body);
    } catch {
      return undefined;
    }
  };
  const call = async <A, I>(
    schema: Schema.Schema<A, I>,
    operation: SshTargetOperation,
    body?: unknown,
  ): Promise<SshTargetAnswer<A>> => {
    const answer = await send(operation, body);
    if (answer === undefined) return { status: "refused", message: UNAVAILABLE };
    if (answer.status !== 200) return { status: "refused", message: refusalMessage(answer) };
    const value = decoded(schema, answer.body);
    return value === undefined
      ? { status: "refused", message: UNAVAILABLE }
      : { status: "ok", value };
  };
  const removed = async (
    operation: SshTargetOperation,
    body: unknown,
  ): Promise<SshTargetAnswer<null>> => {
    const answer = await send(operation, body);
    if (answer === undefined) return { status: "refused", message: UNAVAILABLE };
    return answer.status === 204
      ? { status: "ok", value: null }
      : { status: "refused", message: refusalMessage(answer) };
  };
  const list = <A, B, I>(
    schema: Schema.Schema<A, I>,
    operation: SshTargetOperation,
    pick: (value: A) => B,
  ) =>
    call(schema, operation).then(
      (answer): SshTargetAnswer<B> =>
        answer.status === "ok" ? { status: "ok", value: pick(answer.value) } : answer,
    );
  return {
    list: () => list(SshTargetList, "list", (value) => value.targets),
    probeHostKey: (destination) => call(SshHostKeyProbe, "probe-host-key", { destination }),
    register: (probe, executorPath) =>
      call(SshTargetStatus, "register", {
        probeId: probe.probeId,
        fingerprint: probe.fingerprint,
        executorPath,
      }),
    repin: (targetId, probe) =>
      call(SshTargetStatus, "repin", {
        targetId,
        probeId: probe.probeId,
        fingerprint: probe.fingerprint,
      }),
    connect: (targetId) => call(SshTargetStatus, "connect", { targetId }),
    remove: (targetId) => removed("remove", { targetId }),
    projects: () => list(SshRemoteProjectList, "projects", (value) => value.projects),
    bind: (targetId, remoteRoot, name) =>
      call(SshRemoteProject, "bind", { targetId, remoteRoot, name }),
    worktrees: () => list(SshRemoteWorktreeList, "worktrees", (value) => value.worktrees),
    createWorktree: (projectId, name) =>
      call(SshRemoteWorktree, "create-worktree", { projectId, name }),
    removeWorktree: (worktreeId) => removed("remove-worktree", { worktreeId }),
    terminal: async (command) => {
      const answer = await send("terminal", command);
      const result =
        answer?.status === 200 ? decoded(ProjectTerminalResult, answer.body) : undefined;
      return (
        result ?? {
          kind: "project-terminal-refused",
          reason: "unavailable",
          message: answer === undefined ? UNAVAILABLE : refusalMessage(answer),
        }
      );
    },
  };
}
