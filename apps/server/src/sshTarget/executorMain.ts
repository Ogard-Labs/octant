import { homedir, tmpdir, userInfo } from "node:os";
import { inspectHeadlessArtifact, resolveReportedHostVersion } from "@octant/host-runtime";
import { SSH_EXECUTOR_PROTOCOL_VERSION } from "@octant/contracts/ssh-executor-protocol";
import type { SshExecutorIdentityFacts } from "@octant/contracts/ssh-target";
import { attestExecutorConfinement, sshServerAddressFrom } from "./executorAttestation";
import { openExecutorRuntimeDirectory } from "./executorRuntimeDirectory";
import { serveSshExecutor } from "./executorSession";

/**
 * `octant executor --stdio`: the process this host starts on an SSH target,
 * speaking only on the session's standard input and output. Canonical:
 * docs/design/remote-ssh-environments.md § Executor delivery and identity.
 *
 * It opens no listening socket, acts only on requests, and exits when its
 * input closes; every process it launched is confined with die-with-parent
 * (Linux) or its process group (macOS), so nothing keeps running unseen.
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
await serveSshExecutor({
  input: process.stdin,
  write: (bytes) => process.stdout.write(bytes),
  identity,
  attest: (request) =>
    attestExecutorConfinement(
      {
        identity,
        platform: process.platform,
        architecture: process.arch,
        uid,
        username: currentUsername(),
        homeDirectory: homedir(),
        runtimeExecutable: process.execPath,
        sessionDirectory: runtime.status === "opened" ? runtime.path : undefined,
        sessionParent: runtime.status === "opened" ? runtime.parent : undefined,
        sshServerAddress: sshServerAddressFrom(process.env.SSH_CONNECTION),
      },
      request,
    ),
});
exitNow();
