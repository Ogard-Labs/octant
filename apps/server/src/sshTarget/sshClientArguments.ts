import type { SshDestination, SshExecutorPath } from "@octant/contracts/ssh-target";

/**
 * The fixed argument lists Octant hands the system OpenSSH client. Canonical:
 * docs/design/remote-ssh-environments.md § Transport.
 *
 * Nothing a thread, model, or target produces reaches these lists: the
 * destination and executor path come only from a registration a local window
 * or the local CLI made, and both are schema-checked. Options on the command
 * line take precedence over the person's SSH configuration, which otherwise
 * still applies (aliases, user, port, jump hosts, identity files).
 *
 * `--` ends the options before the destination, so even a destination the
 * schema let through could never be read as an option.
 */

/** The system OpenSSH client, at the path macOS and Linux distributions install it. */
export const SYSTEM_SSH_CLIENT = "/usr/bin/ssh";

/**
 * Options both lists set. Each keeps the target from reaching this machine or
 * the person's identity, or keeps a configured behavior from running here.
 */
const SHARED_OPTIONS = [
  // The remote never gains the person's SSH identity or display.
  "ForwardAgent=no",
  "ForwardX11=no",
  "ForwardX11Trusted=no",
  // A configured port forward or tunnel cannot open a path into this Mac.
  "ClearAllForwardings=yes",
  "Tunnel=no",
  // A configured local command never runs here.
  "PermitLocalCommand=no",
  // No password or passphrase prompt reaches Octant.
  "BatchMode=yes",
  // Only Octant's own known-hosts file speaks for the target: no system file,
  // no configured command or DNS record can vouch for another key, and the
  // client never rewrites the file.
  "GlobalKnownHostsFile=/dev/null",
  "KnownHostsCommand=none",
  "VerifyHostKeyDNS=no",
  "UpdateHostKeys=no",
  "CheckHostIP=no",
  "HashKnownHosts=no",
  // A configured shared connection would carry this session over a master
  // whose host key was checked under someone else's rules.
  "ControlMaster=no",
  "ControlPath=none",
  // A configured remote command would replace the executor.
  "RemoteCommand=none",
  "RequestTTY=no",
  // Frames are binary; an escape character would let their bytes control ssh.
  "EscapeChar=none",
  "ConnectTimeout=15",
  "LogLevel=ERROR",
] as const;

/**
 * A file path as the value of a `-o` option. OpenSSH splits a known-hosts
 * option's value on whitespace into several files and expands `%` tokens in
 * it. Unquoted, the macOS data directory (`~/Library/Application Support`)
 * named `~/Library/Application` as a known-hosts file of its own: the probe
 * wrote every key it read into it, confirmed or not, and every session then
 * trusted those keys beside the pin. Quoting keeps the path one file and `%%`
 * keeps a percent sign literal. OpenSSH cannot be relied on to read a quote or
 * backslash inside a quoted value the same way across versions, so a path
 * holding one is refused rather than guessed at.
 */
function sshOptionPath(path: string): string {
  if (/["\\\p{Cc}]/u.test(path)) {
    throw new Error("An SSH option path may not hold a quote, backslash, or control character.");
  }
  return `"${path.replaceAll("%", "%%")}"`;
}

export interface SshExecutorSessionArgumentsInput {
  readonly destination: SshDestination;
  /** This target's own owner-only known-hosts file, holding only its pinned key. */
  readonly knownHostsFile: string;
  readonly executorPath: SshExecutorPath;
}

/**
 * The session that runs the executor. The remote command is the executor's
 * absolute path and two fixed words; the schema limits the path to characters
 * the remote login shell passes through unchanged.
 */
export function sshExecutorSessionArguments(
  input: SshExecutorSessionArgumentsInput,
): ReadonlyArray<string> {
  return [
    "-T",
    ...SHARED_OPTIONS.flatMap((option) => ["-o", option]),
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${sshOptionPath(input.knownHostsFile)}`,
    // A session that stops answering is lost, not left waiting.
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "--",
    input.destination,
    input.executorPath,
    "executor",
    "--stdio",
  ];
}

export interface SshHostKeyProbeArgumentsInput {
  readonly destination: SshDestination;
  /** A fresh, empty file the client writes the presented key into. */
  readonly knownHostsFile: string;
}

/**
 * A connection that only records the host key the destination presents. Every
 * authentication method is off, so it ends at "permission denied" without
 * logging in, and `-N` asks for no command should a server admit it anyway.
 * The key it records is not trusted until the person confirms it.
 */
export function sshHostKeyProbeArguments(
  input: SshHostKeyProbeArgumentsInput,
): ReadonlyArray<string> {
  return [
    "-T",
    "-N",
    ...SHARED_OPTIONS.flatMap((option) => ["-o", option]),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${sshOptionPath(input.knownHostsFile)}`,
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "HostbasedAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "--",
    input.destination,
  ];
}
