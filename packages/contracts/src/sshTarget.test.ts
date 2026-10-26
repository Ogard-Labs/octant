import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SshAdmissionDecision, SshAttestation, SshTarget } from "./sshTarget";

const target = {
  id: "11111111-1111-4111-8111-111111111111",
  destination: "build@devbox.example",
  hostKey: {
    algorithm: "ssh-ed25519",
    publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  },
  executorPath: "/opt/octant/bin/octant",
};

describe("SSH target contracts", () => {
  it("accepts destinations as people type them and refuses one the SSH client would read as an option or hand to a shell", () => {
    const decode = Schema.decodeUnknownEither(SshTarget);
    for (const destination of [
      "devbox",
      "build@devbox.example",
      "build@dev-box-2.example",
      "ssh://build@devbox.example:2222",
      "ssh://[::1]:2222",
      "fe80::1%eth0",
    ]) {
      expect(decode({ ...target, destination })._tag).toBe("Right");
    }
    for (const destination of [
      "-oProxyCommand=sh",
      "build@-oProxyCommand=sh",
      "ssh://-oProxyCommand=sh",
      "ssh://build@-oProxyCommand=sh",
      "ssh://[-oProxyCommand=sh]",
      "devbox$(id)",
      "devbox;id",
      "dev`id`box",
      "dev box",
      " devbox",
      "devbox\u0007",
      "",
    ]) {
      expect(decode({ ...target, destination })._tag).toBe("Left");
    }
    expect(decode({ ...target, executorPath: "octant" })._tag).toBe("Left");
  });

  it("accepts an executor path only in characters the target's login shell passes through unchanged", () => {
    const decode = Schema.decodeUnknownEither(SshTarget);
    for (const executorPath of [
      "/opt/octant/bin/octant",
      "/home/build/.local/share/octant/current/bin/octant",
      "/srv/octant-1.2.3+build/bin/octant",
    ]) {
      expect(decode({ ...target, executorPath })._tag).toBe("Right");
    }
    for (const executorPath of [
      "octant",
      "/opt/octant bin/octant",
      "/opt/octant;id",
      "/opt/$(id)/octant",
      "/opt/`id`/octant",
      "/opt/octant'/bin",
      "/opt/octant/bin/octant\n",
      "/opt/*/octant",
      "/opt//octant",
      "/",
    ]) {
      expect(decode({ ...target, executorPath })._tag).toBe("Left");
    }
  });

  it("keeps a registered target free of the remote user and platform, which each connection attests anew", () => {
    const decode = Schema.decodeUnknownEither(SshTarget);
    expect(decode({ ...target, remoteUser: "build" })._tag).toBe("Left");
    expect(decode({ ...target, platform: "linux" })._tag).toBe("Left");
  });

  it("decodes an attestation from an unsupported platform as data the host can refuse", () => {
    const attestation = Schema.decodeUnknownSync(SshAttestation)({
      connectionId: "22222222-2222-4222-8222-222222222222",
      facts: {
        identity: { buildVersion: "0.9.0", protocolVersion: 1, installVerified: true },
        platform: { operatingSystem: "freebsd", architecture: "x64", uid: 1001 },
        backend: { kind: "none" },
        canaries: [],
      },
    });
    expect(attestation.facts.platform.operatingSystem).toBe("freebsd");
  });

  it("carries the posture and the escaped action on a canary refusal and nothing more", () => {
    const decode = Schema.decodeUnknownEither(SshAdmissionDecision);
    const escaped = {
      status: "refused",
      reason: "confinement-canary-escaped",
      posture: "plan",
      probe: "open-network-socket",
    };
    expect(decode(escaped)._tag).toBe("Right");
    expect(decode({ ...escaped, detail: "shell output" })._tag).toBe("Left");
    expect(decode({ status: "refused", reason: "confinement-canary-escaped" })._tag).toBe("Left");
  });
});
