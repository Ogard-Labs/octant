import { decodeHostAnswer } from "@octant/contracts";
import {
  SshHostKeyProbe,
  SshTargetList,
  SshTargetStatus,
  type SshAdmissionRefusalReason,
} from "@octant/contracts/ssh-target";
import { failureMessage, type OpenedLocalControlSession } from "./localControl";

/**
 * `octant ssh-target`: register, re-pin, connect, list, and remove SSH targets
 * from this machine. Canonical: docs/design/remote-ssh-environments.md.
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
  | { readonly action: "remove"; readonly targetId: string };

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

function writeStatus(
  stdout: { readonly write: (chunk: string) => unknown },
  status: SshTargetStatus,
): void {
  const who = [status.remoteUser, status.platform].filter((part) => part !== undefined).join(", ");
  stdout.write(
    `${String(status.target.id)}  ${status.target.destination}  ${status.connection}${who === "" ? "" : `  (${who})`}\n`,
  );
  stdout.write(`  host key ${status.fingerprint}\n`);
  stdout.write(`  executor ${status.target.executorPath}\n`);
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
