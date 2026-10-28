import { decodeHostAnswer } from "@octant/contracts";
import {
  SshRemoteDirectoryListing,
  SshRemoteFileContent,
  SshRemoteGitDiff,
  SshRemoteGitStatus,
  SshRemoteProject,
  SshRemoteProjectList,
  SshRemoteProjectRefusal,
  SshRemoteWorktree,
  SshRemoteWorktreeList,
} from "@octant/contracts/ssh-remote-project";
import {
  SshHostKeyProbe,
  SshTargetList,
  SshTargetStatus,
  type SshAdmissionRefusalReason,
} from "@octant/contracts/ssh-target";
import { failureMessage, type OpenedLocalControlSession } from "./localControl";

/**
 * `octant ssh-target`: register, re-pin, connect, list, and remove SSH targets
 * from this machine, set where a provider's runtime is on one, bind a Code
 * Project to a folder on one, and read that folder's files, Git status, and
 * diff. Canonical: docs/design/remote-ssh-environments.md.
 *
 * A host key is pinned only after the person confirms the fingerprint the
 * destination presented: typed at the prompt, or given beforehand with
 * `--fingerprint`. Without a terminal and without that flag, nothing is pinned.
 */

export type SshTargetCliCommand =
  | { readonly action: "list" }
  | {
      readonly action: "add";
      readonly destination: string;
      readonly executorPath: string;
      readonly fingerprint?: string;
    }
  | { readonly action: "repin"; readonly targetId: string; readonly fingerprint?: string }
  | { readonly action: "connect"; readonly targetId: string }
  | { readonly action: "remove"; readonly targetId: string }
  | {
      readonly action: "runtime";
      readonly targetId: string;
      readonly providerInstanceId: string;
      readonly path: string;
    }
  | {
      readonly action: "bind";
      readonly targetId: string;
      readonly remoteRoot: string;
      readonly name: string;
    }
  | { readonly action: "projects" }
  | { readonly action: "files"; readonly projectId: string; readonly directory?: string }
  | { readonly action: "read"; readonly projectId: string; readonly path: string }
  | { readonly action: "status"; readonly projectId: string }
  | { readonly action: "diff"; readonly projectId: string; readonly path?: string }
  | { readonly action: "worktrees" }
  | { readonly action: "worktree-add"; readonly projectId: string; readonly name: string }
  | { readonly action: "worktree-remove"; readonly worktreeId: string };

/** A host answer decoded as clients decode them, or undefined when it does not read. */
function answer<A, I>(
  schema: Parameters<typeof decodeHostAnswer<A, I>>[0],
  body: unknown,
): A | undefined {
  try {
    return decodeHostAnswer(schema)(body);
  } catch {
    return undefined;
  }
}

export function resolveSshTargetCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): SshTargetCliCommand | undefined {
  const [action, ...rest] = positional;
  const flagNames = Object.keys(flags);
  const fingerprint = typeof flags.fingerprint === "string" ? flags.fingerprint : undefined;
  if (flags.fingerprint !== undefined && fingerprint === undefined) return undefined;
  if (action === "list" || action === undefined) {
    return rest.length === 0 && flagNames.length === 0 ? { action: "list" } : undefined;
  }
  if (action === "projects") {
    return rest.length === 0 && flagNames.length === 0 ? { action: "projects" } : undefined;
  }
  if (action === "worktrees") {
    return rest.length === 0 && flagNames.length === 0 ? { action: "worktrees" } : undefined;
  }
  if (action === "worktree") {
    const [verb, first, second, ...extra] = rest;
    if (flagNames.length > 0 || extra.length > 0 || first === undefined) return undefined;
    // The host checks each against its schemas before anything runs.
    if (verb === "add" && second !== undefined) {
      return { action: "worktree-add", projectId: first, name: second };
    }
    if (verb === "remove" && second === undefined) {
      return { action: "worktree-remove", worktreeId: first };
    }
    return undefined;
  }
  if (action === "files" || action === "read" || action === "status" || action === "diff") {
    return resolveReadCommand(action, rest, flagNames);
  }
  if (action === "runtime") {
    const [targetId, providerInstanceId, path, ...extra] = rest;
    if (
      targetId === undefined ||
      providerInstanceId === undefined ||
      path === undefined ||
      extra.length > 0 ||
      flagNames.length > 0
    ) {
      return undefined;
    }
    // The host checks each against its schemas before anything is recorded.
    return { action: "runtime", targetId, providerInstanceId, path };
  }
  if (action === "bind") {
    const [targetId, remoteRoot] = rest;
    const { name } = flags;
    if (
      targetId === undefined ||
      remoteRoot === undefined ||
      rest.length !== 2 ||
      typeof name !== "string" ||
      flagNames.some((flag) => flag !== "name")
    ) {
      return undefined;
    }
    // The host checks each against its schemas before anything runs.
    return { action: "bind", targetId, remoteRoot, name };
  }
  if (action === "add") {
    if (
      rest.length !== 1 ||
      flagNames.some((name) => name !== "executor" && name !== "fingerprint")
    )
      return undefined;
    // The host checks both against its schemas before anything runs.
    const [destination] = rest;
    const executorPath = flags.executor;
    if (destination === undefined || typeof executorPath !== "string") return undefined;
    return {
      action: "add",
      destination,
      executorPath,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    };
  }
  const [targetId] = rest;
  if (targetId === undefined || rest.length !== 1) return undefined;
  if (action === "repin") {
    if (flagNames.some((name) => name !== "fingerprint")) return undefined;
    return { action: "repin", targetId, ...(fingerprint === undefined ? {} : { fingerprint }) };
  }
  if (flagNames.length > 0) return undefined;
  if (action === "connect") return { action: "connect", targetId };
  if (action === "remove") return { action: "remove", targetId };
  return undefined;
}

/** The reads of a remote-bound Project; the host checks each path against its schema. */
function resolveReadCommand(
  action: "files" | "read" | "status" | "diff",
  rest: readonly string[],
  flagNames: readonly string[],
): SshTargetCliCommand | undefined {
  const [projectId, path, ...extra] = rest;
  if (projectId === undefined || extra.length > 0 || flagNames.length > 0) return undefined;
  if (action === "status") return path === undefined ? { action, projectId } : undefined;
  if (action === "read") return path === undefined ? undefined : { action, projectId, path };
  if (action === "files") {
    return { action, projectId, ...(path === undefined ? {} : { directory: path }) };
  }
  return { action, projectId, ...(path === undefined ? {} : { path }) };
}

export interface RunSshTargetCliCommandInput {
  readonly command: SshTargetCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
  /** Asks the person a question at the terminal; undefined when there is none. */
  readonly ask: ((question: string) => Promise<string | undefined>) | undefined;
}

export async function runSshTargetCliCommand(input: RunSshTargetCliCommandInput): Promise<number> {
  const { command, session } = input;
  if (command.action === "projects") {
    const listed = await session.send({ path: "/api/desktop/ssh-targets/projects", method: "GET" });
    const decoded = listed.status === 200 ? answer(SshRemoteProjectList, listed.body) : undefined;
    if (decoded === undefined) {
      input.stderr.write(`${failureMessage(listed, "Octant refused to list remote Projects.")}\n`);
      return 1;
    }
    if (decoded.projects.length === 0) input.stdout.write("No remote-bound Projects.\n");
    for (const project of decoded.projects) writeProject(input.stdout, project);
    return 0;
  }
  if (command.action === "bind") {
    const sent = await session.send({
      path: "/api/desktop/ssh-targets/projects/bind",
      method: "POST",
      body: { targetId: command.targetId, remoteRoot: command.remoteRoot, name: command.name },
    });
    const bound = sent.status === 200 ? answer(SshRemoteProject, sent.body) : undefined;
    if (bound !== undefined) {
      writeProject(input.stdout, bound);
      return 0;
    }
    return writeRefusal(input.stderr, sent, "Not bound");
  }
  if (
    command.action === "files" ||
    command.action === "read" ||
    command.action === "status" ||
    command.action === "diff"
  ) {
    return runReadCommand(input, command);
  }
  if (
    command.action === "worktrees" ||
    command.action === "worktree-add" ||
    command.action === "worktree-remove"
  ) {
    return runWorktreeCommand(input, command);
  }
  if (command.action === "list") {
    const listed = await session.send({ path: "/api/desktop/ssh-targets", method: "GET" });
    const decoded = listed.status === 200 ? answer(SshTargetList, listed.body) : undefined;
    if (decoded === undefined) {
      input.stderr.write(`${failureMessage(listed, "Octant refused to list SSH targets.")}\n`);
      return 1;
    }
    if (decoded.targets.length === 0) input.stdout.write("No SSH targets.\n");
    for (const status of decoded.targets) writeStatus(input.stdout, status);
    return 0;
  }
  if (command.action === "runtime") {
    const sent = await session.send({
      path: "/api/desktop/ssh-targets/runtime-binary",
      method: "POST",
      body: {
        targetId: command.targetId,
        providerInstanceId: command.providerInstanceId,
        path: command.path,
      },
    });
    const status = sent.status === 200 ? answer(SshTargetStatus, sent.body) : undefined;
    if (status === undefined) {
      input.stderr.write(`${failureMessage(sent, "Octant refused to set that runtime path.")}\n`);
      return 1;
    }
    writeStatus(input.stdout, status);
    return 0;
  }
  if (command.action === "connect" || command.action === "remove") {
    const sent = await session.send({
      path:
        command.action === "connect"
          ? "/api/desktop/ssh-targets/connect"
          : "/api/desktop/ssh-targets/remove",
      method: "POST",
      body: { targetId: command.targetId },
    });
    if (command.action === "remove") {
      if (sent.status !== 204) {
        input.stderr.write(`${failureMessage(sent, "Octant refused to remove that target.")}\n`);
        return 1;
      }
      input.stdout.write(`Removed SSH target ${command.targetId}.\n`);
      return 0;
    }
    return reportStatus(input, sent, "Octant refused to connect to that target.");
  }

  let destination: string;
  if (command.action === "add") {
    destination = command.destination;
  } else {
    const listed = await session.send({ path: "/api/desktop/ssh-targets", method: "GET" });
    const target = answer(SshTargetList, listed.body)?.targets.find(
      (status) => String(status.target.id) === command.targetId,
    );
    if (target === undefined) {
      input.stderr.write("No such SSH target.\n");
      return 1;
    }
    destination = target.target.destination;
  }

  const probed = await session.send({
    path: "/api/desktop/ssh-targets/host-key",
    method: "POST",
    body: { destination },
  });
  const probe = probed.status === 200 ? answer(SshHostKeyProbe, probed.body) : undefined;
  if (probe === undefined) {
    input.stderr.write(`${failureMessage(probed, "Octant could not read that host key.")}\n`);
    return 1;
  }
  const { fingerprint } = probe;
  input.stdout.write(`${destination} presented ${probe.hostKey.algorithm} key ${fingerprint}\n`);
  // The design has registration say what the pin and attestation do not
  // prove, rather than call the target verified.
  input.stdout.write(
    "The pin proves only that later sessions reach this key. Whoever administers the target can read its files and alter the executor there, whose attestation is its own report.\n",
  );
  const confirmed = await confirmFingerprint(input, fingerprint, command.fingerprint);
  if (!confirmed) return 1;

  const sent = await session.send(
    command.action === "add"
      ? {
          path: "/api/desktop/ssh-targets/register",
          method: "POST",
          body: { probeId: probe.probeId, fingerprint, executorPath: command.executorPath },
        }
      : {
          path: "/api/desktop/ssh-targets/repin",
          method: "POST",
          body: { targetId: command.targetId, probeId: probe.probeId, fingerprint },
        },
  );
  return reportStatus(input, sent, "Octant refused to pin that host key.");
}

async function confirmFingerprint(
  input: RunSshTargetCliCommandInput,
  fingerprint: string,
  given: string | undefined,
): Promise<boolean> {
  if (given !== undefined) {
    if (given === fingerprint) return true;
    input.stderr.write("That is not the fingerprint the destination presented; nothing pinned.\n");
    return false;
  }
  if (input.ask === undefined) {
    input.stderr.write(
      "Check the fingerprint with the target's administrator, then run again with --fingerprint <fingerprint>.\n",
    );
    return false;
  }
  const answer = await input.ask(
    "Octant will trust only this key for the target. Is it the target's key? Type yes to pin it: ",
  );
  if (answer?.trim().toLowerCase() === "yes") return true;
  input.stderr.write("Nothing pinned.\n");
  return false;
}

function reportStatus(
  input: RunSshTargetCliCommandInput,
  response: { readonly status: number; readonly body: unknown },
  fallback: string,
): number {
  const status = response.status === 200 ? answer(SshTargetStatus, response.body) : undefined;
  if (status === undefined) {
    input.stderr.write(`${failureMessage(response, fallback)}\n`);
    return 1;
  }
  writeStatus(input.stdout, status);
  return status.admission.every((entry) => entry.decision.status === "admitted") ? 0 : 1;
}

/** What the person can do about each refusal, as the design's refusal table states it. */
const RECOVERY: Readonly<Record<SshAdmissionRefusalReason, string>> = {
  "target-removed": "The target was removed; its Projects' threads stay readable here.",
  "target-unreachable": "Reconnect when the target is reachable: octant ssh-target connect <id>.",
  "target-reconnecting":
    "Octant is reconnecting on its own; to try now instead: octant ssh-target connect <id>.",
  "authentication-refused":
    "Check that ssh to the target signs in without a prompt, then: octant ssh-target connect <id>.",
  "host-key-changed":
    "The target presented another host key. After checking it, confirm it: octant ssh-target repin <id>.",
  "executor-missing": "Install the headless Octant of this version on the target.",
  "executor-version-mismatch": "Install the headless Octant of this host's version on the target.",
  "remote-root-user": "Register the target with a non-root user.",
  "unsupported-platform": "Use a Linux or macOS machine.",
  "confinement-backend-missing":
    "Install bubblewrap on the target: sudo apt-get install -y bubblewrap.",
  "user-namespaces-unavailable": "Enable unprivileged user namespaces for this user on the target.",
  "plan-filter-unavailable":
    "Plan on Linux needs an x64 or arm64 CPU and an executable /bin/sh on the target.",
  "confinement-canary-escaped":
    "Confinement did not hold on the target; contact the target's administrator.",
  "not-attested": "Reconnect to attest: octant ssh-target connect <id>.",
  "runtime-not-attestable": "Choose a runtime Octant confines on remote targets.",
  "full-access-not-remembered":
    "Remember Full access for this Project from a local window, or choose a narrower posture.",
};

async function runReadCommand(
  input: RunSshTargetCliCommandInput,
  command: Extract<SshTargetCliCommand, { readonly action: "files" | "read" | "status" | "diff" }>,
): Promise<number> {
  const { stdout } = input;
  if (command.action === "files") {
    const sent = await input.session.send({
      path: "/api/desktop/ssh-targets/projects/files",
      method: "POST",
      body: {
        projectId: command.projectId,
        ...(command.directory === undefined ? {} : { directory: command.directory }),
      },
    });
    const listing = sent.status === 200 ? answer(SshRemoteDirectoryListing, sent.body) : undefined;
    if (listing === undefined) return writeRefusal(input.stderr, sent, "Not listed");
    for (const entry of listing.entries) {
      stdout.write(
        entry.kind === "directory"
          ? `${entry.path}/\n`
          : `${entry.path}  ${String(entry.byteLength)} bytes\n`,
      );
    }
    if (listing.truncated) input.stderr.write("The folder holds more than this listing shows.\n");
    return 0;
  }
  if (command.action === "read") {
    const sent = await input.session.send({
      path: "/api/desktop/ssh-targets/projects/file",
      method: "POST",
      body: { projectId: command.projectId, path: command.path },
    });
    const file = sent.status === 200 ? answer(SshRemoteFileContent, sent.body) : undefined;
    if (file === undefined) return writeRefusal(input.stderr, sent, "Not read");
    stdout.write(Buffer.from(file.contentBase64, "base64").toString("utf8"));
    return 0;
  }
  if (command.action === "status") {
    const sent = await input.session.send({
      path: "/api/desktop/ssh-targets/projects/git-status",
      method: "POST",
      body: { projectId: command.projectId },
    });
    const status = sent.status === 200 ? answer(SshRemoteGitStatus, sent.body) : undefined;
    if (status === undefined) return writeRefusal(input.stderr, sent, "No status");
    const { head } = status;
    stdout.write(
      head.kind === "detached"
        ? `HEAD detached at ${head.oid}\n`
        : head.kind === "unborn"
          ? `On ${head.name}, no commits yet\n`
          : `On ${head.name} at ${head.oid}\n`,
    );
    for (const entry of status.entries) {
      stdout.write(
        `${entry.index}${entry.worktree} ${entry.originalPath === undefined ? "" : `${entry.originalPath} -> `}${entry.path}\n`,
      );
    }
    if (status.truncated) input.stderr.write("The checkout has more changes than this shows.\n");
    return 0;
  }
  const sent = await input.session.send({
    path: "/api/desktop/ssh-targets/projects/git-diff",
    method: "POST",
    body: {
      projectId: command.projectId,
      ...(command.path === undefined ? {} : { path: command.path }),
    },
  });
  const diff = sent.status === 200 ? answer(SshRemoteGitDiff, sent.body) : undefined;
  if (diff === undefined) return writeRefusal(input.stderr, sent, "No diff");
  stdout.write(diff.text);
  if (diff.truncated) input.stderr.write("The diff is longer than Octant reads at once.\n");
  return 0;
}

/** Says why a bind or read did nothing, with the recovery for an admission refusal. */
function writeRefusal(
  stderr: { readonly write: (chunk: string) => unknown },
  response: { readonly status: number; readonly body: unknown },
  what: string,
): number {
  const refused = answer(SshRemoteProjectRefusal, response.body);
  if (refused === undefined) {
    stderr.write(`${failureMessage(response, `${what}: Octant refused the request.`)}\n`);
    return 1;
  }
  if (refused.reason === "not-admitted") {
    stderr.write(`${what}: the target admits no reads now, ${refused.decision.reason}.\n`);
    if (refused.decision.status === "refused") {
      stderr.write(`  ${RECOVERY[refused.decision.reason]}\n`);
    }
    return 1;
  }
  stderr.write(`${what}: ${READ_REFUSAL[refused.reason]}\n`);
  return 1;
}

/** Why a bind or read did nothing, for each refusal the executor or this host can give. */
const READ_REFUSAL: Readonly<
  Record<Exclude<SshRemoteProjectRefusal["reason"], "not-admitted">, string>
> = {
  "root-unavailable": "that folder does not exist on the target, or is not a folder.",
  "root-moved": "that folder moved since it was bound.",
  "root-not-confinable":
    "Octant binds no folder that is /, or holds or sits inside your ~/.ssh or its own runtime; choose the project folder itself.",
  "outside-root": "that path leads outside the folder.",
  "not-found": "that path does not exist.",
  "not-a-directory": "that path is not a folder.",
  "not-a-file": "that path is not a file.",
  "too-large": "the answer is too large to read.",
  "not-a-repository": "that folder is not a Git repository.",
  "git-unavailable": "Git is not installed on the target.",
  "read-failed": "the target could not read it.",
  "unknown-project": "no such Project.",
  "unknown-worktree": "no such worktree of that Project.",
  "executor-unavailable": "the session to the target ended; reconnect and try again.",
  "not-repository-root":
    "a worktree needs the bound folder to be its repository's own top level, with .git inside it.",
  "worktree-exists": "a worktree or branch of that name already exists.",
  "worktree-dirty": "the worktree holds changes or untracked files, so Git keeps it.",
  "worktree-failed": "Git could not change the worktree on the target.",
};

function writeWorktree(
  stdout: { readonly write: (chunk: string) => unknown },
  worktree: SshRemoteWorktree,
): void {
  stdout.write(
    `${String(worktree.id)}  ${worktree.branch}  ${worktree.path}  (Project ${String(worktree.projectId)})\n`,
  );
}

async function runWorktreeCommand(
  input: RunSshTargetCliCommandInput,
  command: Extract<
    SshTargetCliCommand,
    { readonly action: "worktrees" | "worktree-add" | "worktree-remove" }
  >,
): Promise<number> {
  if (command.action === "worktrees") {
    const listed = await input.session.send({
      path: "/api/desktop/ssh-targets/projects/worktrees",
      method: "GET",
    });
    const decoded = listed.status === 200 ? answer(SshRemoteWorktreeList, listed.body) : undefined;
    if (decoded === undefined) {
      input.stderr.write(`${failureMessage(listed, "Octant refused to list worktrees.")}\n`);
      return 1;
    }
    if (decoded.worktrees.length === 0) input.stdout.write("No managed worktrees.\n");
    for (const worktree of decoded.worktrees) writeWorktree(input.stdout, worktree);
    return 0;
  }
  if (command.action === "worktree-add") {
    const sent = await input.session.send({
      path: "/api/desktop/ssh-targets/projects/worktrees/create",
      method: "POST",
      body: { projectId: command.projectId, name: command.name },
    });
    const created = sent.status === 200 ? answer(SshRemoteWorktree, sent.body) : undefined;
    if (created === undefined) return writeRefusal(input.stderr, sent, "Not created");
    writeWorktree(input.stdout, created);
    return 0;
  }
  const sent = await input.session.send({
    path: "/api/desktop/ssh-targets/projects/worktrees/remove",
    method: "POST",
    body: { worktreeId: command.worktreeId },
  });
  if (sent.status !== 204) return writeRefusal(input.stderr, sent, "Not removed");
  input.stdout.write(`Removed worktree ${command.worktreeId}; its branch stays.\n`);
  return 0;
}

function writeProject(
  stdout: { readonly write: (chunk: string) => unknown },
  project: SshRemoteProject,
): void {
  stdout.write(
    `${String(project.id)}  ${project.name}  ${project.remoteRoot} on ${String(project.targetId)}\n`,
  );
}

function writeStatus(
  stdout: { readonly write: (chunk: string) => unknown },
  status: SshTargetStatus,
): void {
  const who = [status.remoteUser, status.platform].filter((part) => part !== undefined).join(", ");
  stdout.write(
    `${String(status.target.id)}  ${status.target.destination}  ${status.connection}${who === "" ? "" : `  (${who})`}\n`,
  );
  const { reconnect } = status;
  if (reconnect?.status === "waiting") {
    stdout.write(
      `  reconnecting on its own: attempt ${String(reconnect.attempt)} of ${String(reconnect.maxAttempts)} at ${new Date(reconnect.nextAttemptAt).toISOString()}\n`,
    );
  } else if (reconnect?.status === "attempting") {
    stdout.write(
      `  reconnecting on its own: attempt ${String(reconnect.attempt)} of ${String(reconnect.maxAttempts)} under way\n`,
    );
  } else if (reconnect?.status === "stopped") {
    stdout.write(`  stopped reconnecting after ${String(reconnect.attempts)} attempts\n`);
  }
  stdout.write(`  host key ${status.fingerprint}\n`);
  stdout.write(`  executor ${status.target.executorPath}\n`);
  for (const binary of status.runtimeBinaries) {
    stdout.write(`  runtime of ${String(binary.providerInstanceId)} at ${binary.path}\n`);
  }
  for (const { posture, decision } of status.admission) {
    if (decision.status === "admitted") {
      stdout.write(`  ${posture}: admitted\n`);
      continue;
    }
    const detail =
      decision.reason === "confinement-canary-escaped"
        ? ` (${decision.posture}: ${decision.probe} succeeded)`
        : decision.reason === "not-attested" && decision.probe !== undefined
          ? ` (${decision.probe} did not report a refusal)`
          : "";
    stdout.write(`  ${posture}: refused, ${decision.reason}${detail}\n`);
    stdout.write(`    ${RECOVERY[decision.reason]}\n`);
  }
}
