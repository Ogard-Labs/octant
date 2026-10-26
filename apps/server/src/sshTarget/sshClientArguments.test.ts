import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SshDestination, SshExecutorPath } from "@octant/contracts/ssh-target";
import {
  sshClientEnvironment,
  sshExecutorSessionArguments,
  sshHostKeyProbeArguments,
} from "./sshClientArguments";

const destination = Schema.decodeUnknownSync(SshDestination)("build@devbox.example");
const executorPath = Schema.decodeUnknownSync(SshExecutorPath)("/opt/octant/bin/octant");

const SHARED = [
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "ForwardX11Trusted=no",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "Tunnel=no",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "BatchMode=yes",
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "KnownHostsCommand=none",
  "-o",
  "VerifyHostKeyDNS=no",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "CheckHostIP=no",
  "-o",
  "HashKnownHosts=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "RemoteCommand=none",
  "-o",
  "RequestTTY=no",
  "-o",
  "EscapeChar=none",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "LogLevel=ERROR",
];

describe("SSH client arguments", () => {
  it("starts the executor with only Octant's pin trusted, nothing forwarded, and the destination after `--`", () => {
    expect(
      sshExecutorSessionArguments({
        destination,
        knownHostsFile: "/Users/a/Library/Application Support/Octant/ssh-targets/t/known_hosts",
        executorPath,
      }),
    ).toEqual([
      "-T",
      ...SHARED,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      'UserKnownHostsFile="/Users/a/Library/Application Support/Octant/ssh-targets/t/known_hosts"',
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "--",
      "build@devbox.example",
      "/opt/octant/bin/octant",
      "executor",
      "--stdio",
    ]);
  });

  it("reads a destination's host key without logging in, running a command, or trusting the key", () => {
    expect(
      sshHostKeyProbeArguments({ destination, knownHostsFile: "/data/100%h/probe/known_hosts" }),
    ).toEqual([
      "-T",
      "-N",
      ...SHARED,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      'UserKnownHostsFile="/data/100%%h/probe/known_hosts"',
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
      "build@devbox.example",
    ]);
  });

  it("refuses a known-hosts path OpenSSH could not read back as one file", () => {
    for (const knownHostsFile of [
      '/data/a"b/known_hosts',
      "/data/a\\b/known_hosts",
      "/data/a\nb",
    ]) {
      expect(() => sshHostKeyProbeArguments({ destination, knownHostsFile })).toThrow();
    }
  });
});

describe("sshClientEnvironment", () => {
  it("hands the client only what it needs, so a SendEnv pattern cannot carry provider keys to a target", () => {
    expect(
      sshClientEnvironment({
        HOME: "/Users/person",
        PATH: "/usr/bin:/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        LANG: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        OPENAI_API_KEY: "sk-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        GITHUB_TOKEN: "ghp_secret",
        OCTANT_DESKTOP_BRIDGE_SECRET: "bridge",
      }),
    ).toEqual({
      HOME: "/Users/person",
      PATH: "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LANG: "en_US.UTF-8",
    });
  });
});
