import { homedir, tmpdir, userInfo } from "node:os";
import { inspectHeadlessArtifact, resolveReportedHostVersion } from "@octant/host-runtime";
import {
  SSH_EXECUTOR_MAX_PLACED_PROCESSES,
  SSH_EXECUTOR_PROTOCOL_VERSION,
} from "@octant/contracts/ssh-executor-protocol";
import type { SshExecutorIdentityFacts } from "@octant/contracts/ssh-target";
import { attestExecutorConfinement, sshServerAddressFrom } from "./executorAttestation";
import { ExecutorHarnessFiles } from "./executorHarnessFiles";
import { ExecutorEgress, MAX_DIALED_CONNECTIONS, runExecutorCommand } from "./executorLaunches";
import { ExecutorProcesses } from "./executorProcesses";
import { answerExecutorRead, resolveBoundRoot } from "./executorReads";
import { openExecutorRuntimeDirectory } from "./executorRuntimeDirectory";
import { serveSshExecutor } from "./executorSession";
import { ExecutorStreams } from "./executorStreams";
import { ExecutorTerminals } from "./executorTerminals";
import { createExecutorWorktree, removeExecutorWorktree } from "./executorWorktrees";

/**
 * `octant executor --stdio`: the process this host starts on an SSH target,
 * speaking only on the session's standard input and output. Canonical:
 * docs/design/remote-ssh-environments.md § Executor delivery and identity.
 *
 * It opens no network listener, acts only on requests, and exits when its
 * input closes; every process it launched is confined with die-with-parent
 * (Linux) or its process group (macOS), so nothing keeps running unseen. The
 * only sockets it listens on are proxied launches' forwarders: a Unix socket
 * per launch in its owner-only runtime directory, open only while that
 * command or placed runtime runs.
 */

/**
 * The executor's own install, verified as the headless server verifies its
 * artifact. Run from a source checkout there is no install to verify; it then
 * reports the development version, which only a development host matches.
 */
async function executorIdentity(
  env: Readonly<Record<string, string | undefined>>,
): Promise<SshExecutorIdentityFacts> {
  const artifactRoot = env.OCTANT_ARTIFACT_ROOT;
  let installVerified = true;
  if (artifactRoot !== undefined && artifactRoot !== "") {
    const inspection = await inspectHeadlessArtifact({
      artifactRoot,
      runtime: { platform: process.platform, arch: process.arch, wireVersion: "1" },
    }).catch(() => undefined);
    installVerified = inspection?.ok === true;
  }
  return {
    buildVersion: resolveReportedHostVersion(env),
    protocolVersion: SSH_EXECUTOR_PROTOCOL_VERSION,
    installVerified,
  };
}

function currentUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

// A runtime without user ids runs on a platform the host refuses before it
// looks at the user, so reporting root there refuses nothing new.
const uid = process.getuid?.() ?? 0;
const runtime = openExecutorRuntimeDirectory({ base: tmpdir(), uid, pid: process.pid });
const removeRuntime = () => {
  if (runtime.status === "opened") runtime.remove();
};
const exitNow = () => {
  removeRuntime();
  process.exit(0);
};
process.once("SIGHUP", exitNow);
process.once("SIGTERM", exitNow);
process.once("SIGINT", exitNow);

const identity = await executorIdentity(process.env);
const sessionDirectory = runtime.status === "opened" ? runtime.path : undefined;
const sessionParent = runtime.status === "opened" ? runtime.parent : undefined;
const reads = {
  platform: process.platform,
  homeDirectory: homedir(),
  sessionDirectory,
  sessionParent,
};
await serveSshExecutor({
  input: process.stdin,
  write: (bytes) => process.stdout.write(bytes),
  identity,
  handlers: (send) => {
    // One registry of the streams the host opens, so a dialed connection and
    // a placed process can never share an id.
    const hostOpened = new ExecutorStreams({
      send,
      opens: "odd",
      maxStreams: MAX_DIALED_CONNECTIONS + SSH_EXECUTOR_MAX_PLACED_PROCESSES,
    });
    const egress = new ExecutorEgress(send, hostOpened, process.platform);
    const processes = new ExecutorProcesses(
      send,
      {
        platform: process.platform,
        uid,
        homeDirectory: homedir(),
        stateHome: process.env.XDG_STATE_HOME,
        sessionDirectory,
        sessionParent,
        path: process.env.PATH,
        language: process.env.LANG,
        resolveRoot: (root) => resolveBoundRoot(reads, root),
      },
      hostOpened,
      egress,
    );
    const files = new ExecutorHarnessFiles(reads);
    const terminals = new ExecutorTerminals(send, {
      platform: process.platform,
      sessionDirectory,
      shell: process.env.SHELL,
      path: process.env.PATH,
      language: process.env.LANG,
    });
    return {
      answer: async (request, signal, id) => {
        switch (request.kind) {
          case "attest":
            return attestExecutorConfinement(
              {
                identity,
                platform: process.platform,
                architecture: process.arch,
                uid,
                username: currentUsername(),
                homeDirectory: homedir(),
                runtimeExecutable: process.execPath,
                sessionDirectory,
                sessionParent,
                sshServerAddress: sshServerAddressFrom(process.env.SSH_CONNECTION),
              },
              request,
            );
          case "harness-file":
            return files.answer(request);
          case "run-command": {
            const root = await resolveBoundRoot(reads, request.root);
            if (root.status === "refused") return { kind: "refused", reason: root.reason };
            return runExecutorCommand(reads, root.canonical, request, egress, signal, id);
          }
          case "open-terminal": {
            const root = await resolveBoundRoot(reads, request.root);
            if (root.status === "refused") return { kind: "refused", reason: root.reason };
            return terminals.open(root.canonical, request);
          }
          case "create-worktree":
            return createExecutorWorktree(reads, request);
          case "remove-worktree":
            return removeExecutorWorktree(reads, request);
          case "start-process":
            return processes.start(request, id);
          default:
            return answerExecutorRead(reads, request);
        }
      },
      replied: (id, reply) => processes.replied(id, reply),
      receive: (frame) => {
        switch (frame.type) {
          case "stop-process":
            return processes.receive(frame);
          case "terminal-input":
          case "terminal-resize":
          case "terminal-close":
          case "terminal-credit":
            return terminals.receive(frame);
          default:
            return egress.receive(frame);
        }
      },
      end: () => {
        processes.abandon();
        egress.abandon();
        terminals.abandon();
      },
    };
  },
});
exitNow();
